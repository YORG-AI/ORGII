/**
 * Org2CloudSyncEngine — custom-endpoint schema gate (cloud-parity Phase C).
 *
 * A self-deployed backend upgrades on its own cadence, so before the first
 * sync work of a start() the engine probes `schema_version()` and requires
 * an EXACT match with `ORG2_CLOUD_EXPECTED_SCHEMA_VERSION`. Mismatch ⇒ sync
 * stays disabled for this start + one warning toast (the design's only
 * error surface — deployment docs live in the infra repo). A failed probe
 * (`null`) skips the pass and re-probes next pass: a backend that cannot
 * answer the anon probe cannot serve the sync RPCs either. The OFFICIAL
 * endpoint skips the gate — it is upgraded in lockstep with app releases.
 */
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";

import { ORG2_CLOUD_EXPECTED_SCHEMA_VERSION, getCloudEndpoint } from "./config";
import { SCHEMA_MISMATCH_REPROBE_MS } from "./org2CloudSyncEngine.constants";

const log = createLogger("Org2CloudSyncEngine");

/** `schema_version()` probe seam (Phase C custom-endpoint gate). */
export type Org2CloudSchemaVersionProbe = () => Promise<number | null>;

/**
 * Custom-endpoint schema gate (Phase C), KEYED BY the probed supabaseUrl:
 * the engine singleton is never stopped in production, so an endpoint
 * switch must re-probe by itself — a verdict for endpoint A can neither
 * bless nor brick endpoint B. 'ok' sticks for its URL; 'mismatch'
 * re-probes after a TTL so an in-place backend upgrade (same URL) heals
 * without an app relaunch. The toast fires once per URL per start().
 */
export class Org2CloudSchemaGate {
  private gate: {
    supabaseUrl: string;
    verdict: "ok" | "mismatch";
    probedAtMs: number;
  } | null = null;
  private readonly toastedUrls = new Set<string>();

  constructor(
    private readonly probeSchemaVersion: Org2CloudSchemaVersionProbe
  ) {}

  reset(): void {
    this.gate = null;
    this.toastedUrls.clear();
  }

  /**
   * Same contract as the other composed helpers (`Org2CloudSessionSync`,
   * `Org2CloudRepoScopeSync`, …): staleness after an `await` is the CALLER's
   * generation, threaded in via `isCurrentGeneration` rather than read off
   * a field here, so the pass semantics stay identical to when this method
   * lived directly on the engine.
   */
  async passesSchemaGate(
    generation: number,
    isCurrentGeneration: (generation: number) => boolean
  ): Promise<boolean> {
    const endpoint = getCloudEndpoint();
    if (endpoint.isOfficial) return true;
    const cached = this.gate;
    if (cached && cached.supabaseUrl === endpoint.supabaseUrl) {
      if (cached.verdict === "ok") return true;
      // Mismatch: hold the verdict for a TTL, then re-probe — the backend
      // may have been upgraded in place.
      if (Date.now() - cached.probedAtMs < SCHEMA_MISMATCH_REPROBE_MS) {
        return false;
      }
    }
    // First probe for this URL (or a switch away from a cached one, or a
    // mismatch past its TTL): ask the backend.
    const backendVersion = await this.probeSchemaVersion();
    if (!isCurrentGeneration(generation)) return false;
    if (backendVersion === null) {
      log.warn("schema_version probe failed; skipping cloud sync pass");
      return false;
    }
    if (backendVersion !== ORG2_CLOUD_EXPECTED_SCHEMA_VERSION) {
      this.gate = {
        supabaseUrl: endpoint.supabaseUrl,
        verdict: "mismatch",
        probedAtMs: Date.now(),
      };
      if (!this.toastedUrls.has(endpoint.supabaseUrl)) {
        this.toastedUrls.add(endpoint.supabaseUrl);
        Message.warning(
          i18n.t("navigation:cloud.sync.schemaMismatchToast", {
            backend: backendVersion,
            expected: ORG2_CLOUD_EXPECTED_SCHEMA_VERSION,
          })
        );
      }
      log.warn(
        `cloud sync disabled: custom backend schema_version ${backendVersion}` +
          `, app expects ${ORG2_CLOUD_EXPECTED_SCHEMA_VERSION}`
      );
      return false;
    }
    this.gate = {
      supabaseUrl: endpoint.supabaseUrl,
      verdict: "ok",
      probedAtMs: Date.now(),
    };
    return true;
  }
}
