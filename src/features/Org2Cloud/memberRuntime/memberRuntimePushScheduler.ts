/**
 * MemberRuntimePushScheduler — periodic member-runtime telemetry push.
 *
 * Deliberately SEPARATE from `Org2CloudSyncEngine` (the engine is
 * event-driven and has no recurring passes; telemetry is inherently
 * periodic). Started/stopped alongside the engine in
 * `useOrg2CloudSyncEngine`, so it shares the engine's identity-boundary
 * teardown: sign-out or an account/endpoint switch stops it and a fresh
 * start rebuilds all in-memory verdicts under the new identity.
 *
 * Scheduling copies the `useDataSourceAutoScan` discipline exactly:
 *  - ONE exact-deadline `setTimeout` chain (never `setInterval`); the timer
 *    is re-armed only after the current pass fully settles.
 *  - Visibility-aware: hidden documents clear the timer; becoming visible
 *    triggers an immediate due-check.
 *  - In-flight dedupe: `running` guarantees passes never overlap, and each
 *    pass walks its due orgs sequentially, so pushes never overlap either.
 *
 * Per org, a push happens only when EVERY gate holds: signed-in auth (with
 * the `ensureFreshSession` refresh idiom), the endpoint advertises the
 * `memberRuntime` capability, the org record has `runtimeTelemetry.enabled`,
 * and the local `privacy.shareRuntimeWithOrg` setting is on. Cadence is the
 * org's `intervalMinutes` clamped to [15, 1440]; a push overdue at launch
 * waits out a random [30s, 120s] jitter so an org's members coming online
 * together don't stampede.
 *
 * Failure handling: `ORG2_RUNTIME_DISABLED` marks the org disabled until
 * its roster record changes (no retry churn); anything else applies an
 * exponential per-org backoff (5 min base, 30 min cap) WITHOUT advancing
 * `lastPushAtMs`, so the next success closes the gap.
 */
import { isTauri } from "@tauri-apps/api/core";

import { builderProfileOverview } from "@src/api/tauri/builderProfile";
import type { BuilderProfileOverview } from "@src/api/tauri/builderProfile";
import { externalCliSourcesDetect } from "@src/api/tauri/externalHistory/detection";
import { usageDashboardDailyRollup } from "@src/api/tauri/usageDashboard";
import type { DailyRollupRow } from "@src/api/tauri/usageDashboard";
import { createLogger } from "@src/hooks/logger";
import { settingAtom } from "@src/store/settings/settingsAtom";
import { settingsLoadedAtom } from "@src/store/settings/settingsAtom";
import type { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  type Org2CloudAuthState,
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../org2CloudAuthAtom";
import type { CloudCapabilities } from "../org2CloudCapabilities";
import { getCloudCapabilities } from "../org2CloudCapabilities";
import { ensureFreshSession } from "../org2CloudClient";
import { type Org2CloudOrg, org2CloudOrgsAtom } from "../org2CloudOrgsAtom";
import {
  type MemberRuntimeErrorCode,
  isMemberRuntimeErrorCode,
  upsertMemberRuntime,
} from "./memberRuntimeClient";
import {
  collectMemberRuntimeSample,
  getMemberRuntimeMachineCached,
  mapProbesToInstalledAgents,
} from "./memberRuntimePayload";
import {
  UTC_DAY_MS,
  builderProfileFingerprint,
  computeOrgDueAtMs,
  drawMemberRuntimeCatchupJitterMs,
  installedAgentsFingerprint,
  mapRollupRowsToMemberUsageDays,
  memberRuntimeBackoffDelayMs,
  planUsageDaysPush,
  runtimeTelemetryRecordFingerprint,
  utcDayFloorMs,
} from "./memberRuntimePushPlanner";
import {
  type MemberRuntimePushState,
  readMemberRuntimePushState,
  writeMemberRuntimePushState,
} from "./memberRuntimePushState";
import type {
  MemberInstalledAgent,
  MemberProfilePayload,
  UpsertMemberRuntimeInput,
} from "./types";
import {
  MEMBER_AGENTS_DETECT_MIN_INTERVAL_MS,
  MEMBER_USAGE_ROLLUP_WINDOW_DAYS,
  SHARE_RUNTIME_SETTING_KEY,
} from "./types";

const log = createLogger("MemberRuntimePush");

type CloudStore = ReturnType<typeof getInstrumentedStore>;

/** With the capability missing (pre-0010 backend or a degraded probe), poll
 * again after this long rather than spinning on overdue deadlines. */
export const MEMBER_RUNTIME_CAPABILITY_RECHECK_MS = 6 * 60 * 60 * 1000;
/** Pass-level floor after a failed token refresh (org backoffs are per-org;
 * an auth failure blocks the whole pass and must not tight-loop). */
const AUTH_RETRY_DELAY_MS = 5 * 60_000;

/** Non-DOM contexts (workers and node-side tests) behave as visible. */
function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

export interface MemberRuntimeSchedulerDeps {
  now(): number;
  random(): number;
  getMachine: typeof getMemberRuntimeMachineCached;
  getSample: typeof collectMemberRuntimeSample;
  getDailyRollup: (startMs: number, endMs: number) => Promise<DailyRollupRow[]>;
  /** CACHE READ ONLY — scores already-extracted signal rows; extraction is
   * never triggered here. */
  getProfileOverview: () => Promise<BuilderProfileOverview>;
  detectInstalledAgents: () => Promise<MemberInstalledAgent[]>;
  upsert: typeof upsertMemberRuntime;
  getCapabilities: (accessToken: string) => Promise<CloudCapabilities>;
  ensureFresh: typeof ensureFreshSession;
}

const defaultDeps: MemberRuntimeSchedulerDeps = {
  now: () => Date.now(),
  random: Math.random,
  getMachine: getMemberRuntimeMachineCached,
  getSample: collectMemberRuntimeSample,
  getDailyRollup: usageDashboardDailyRollup,
  getProfileOverview: () => builderProfileOverview(),
  detectInstalledAgents: async () =>
    mapProbesToInstalledAgents(await externalCliSourcesDetect()),
  upsert: upsertMemberRuntime,
  getCapabilities: getCloudCapabilities,
  ensureFresh: ensureFreshSession,
};

interface OrgBackoffState {
  failures: number;
  notBeforeMs: number;
}

export class MemberRuntimePushScheduler {
  private readonly deps: MemberRuntimeSchedulerDeps;
  private store: CloudStore | null = null;
  private started = false;
  /** Bumped on stop(); in-flight passes check it before writing. */
  private generation = 0;
  private running = false;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private schedulerStartAtMs = 0;
  private catchupJitterMs = 0;
  /** Per-org transport/other-failure backoff (cleared on success/stop). */
  private readonly orgBackoff = new Map<string, OrgBackoffState>();
  /** orgId → runtimeTelemetry record fingerprint at the moment the server
   * said ORG2_RUNTIME_DISABLED; the org stays skipped while its roster
   * record still matches. */
  private readonly disabledRecordFingerprint = new Map<string, string>();
  /** Non-zero while the endpoint's capability probe said no memberRuntime. */
  private capabilityRecheckAtMs = 0;
  /** Pass-level floor after a failed token refresh. */
  private authRetryNotBeforeMs = 0;
  private storeUnsubscribers: Array<() => void> = [];

  private readonly onVisibilityChange = (): void => {
    this.clearTimer();
    if (!this.started || isDocumentHidden()) return;
    this.trigger();
  };

  constructor(deps: Partial<MemberRuntimeSchedulerDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Idempotent: subsequent calls while running are no-ops. */
  start(store: CloudStore): void {
    if (this.started) return;
    // The collectors are Tauri commands; a plain web harness has nothing to
    // sample and must not churn failure backoffs forever.
    if (!isTauri()) return;
    this.started = true;
    this.store = store;
    this.generation += 1;
    this.schedulerStartAtMs = this.deps.now();
    this.catchupJitterMs = drawMemberRuntimeCatchupJitterMs(this.deps.random);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    // Gate/cadence inputs: re-arm the exact-deadline timer when any change.
    this.storeUnsubscribers = [
      store.sub(org2CloudOrgsAtom, () => this.schedule()),
      store.sub(org2CloudAuthAtom, () => this.schedule()),
      store.sub(settingsLoadedAtom, () => this.schedule()),
      store.sub(settingAtom(SHARE_RUNTIME_SETTING_KEY), () => this.schedule()),
    ];
    this.trigger();
  }

  stop(): void {
    if (!this.started && this.store === null) return;
    this.started = false;
    this.generation += 1;
    this.clearTimer();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    for (const unsubscribe of this.storeUnsubscribers) unsubscribe();
    this.storeUnsubscribers = [];
    this.orgBackoff.clear();
    this.disabledRecordFingerprint.clear();
    this.capabilityRecheckAtMs = 0;
    this.authRetryNotBeforeMs = 0;
    this.store = null;
  }

  private clearTimer(): void {
    if (this.timeoutId === undefined) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
  }

  /** Re-arm the single exact-deadline timer from current state. */
  private schedule(): void {
    this.clearTimer();
    if (!this.started || this.running || isDocumentHidden()) return;
    const delay = this.nextDelayMs();
    if (delay == null) return;
    this.timeoutId = setTimeout(
      () => {
        this.timeoutId = undefined;
        this.trigger();
      },
      Math.max(1, delay)
    );
  }

  private trigger(): void {
    this.clearTimer();
    if (!this.started || this.running || isDocumentHidden()) return;
    this.running = true;
    const generation = this.generation;
    void this.runPass(generation)
      .catch((error: unknown) => {
        log.warn("member runtime push pass failed", error);
      })
      .finally(() => {
        this.running = false;
        if (this.generation === generation) this.schedule();
      });
  }

  /**
   * Orgs currently pushable ignoring dueness: signed in, sharing enabled
   * locally, org record enabled, and not held by a still-matching
   * ORG2_RUNTIME_DISABLED verdict. Cheap + synchronous (used by both the
   * deadline computation and the pass).
   */
  private eligibleOrgs(): {
    identityKey: string;
    auth: Org2CloudAuthState;
    orgs: Org2CloudOrg[];
  } | null {
    const store = this.store;
    if (!store) return null;
    const auth = store.get(org2CloudAuthAtom);
    if (!auth) return null;
    if (!store.get(settingsLoadedAtom)) return null;
    if (store.get(settingAtom(SHARE_RUNTIME_SETTING_KEY)) !== true) return null;
    const orgs = store.get(org2CloudOrgsAtom).filter((org) => {
      if (!org.runtimeTelemetry?.enabled) return false;
      const disabledFp = this.disabledRecordFingerprint.get(org.orgId);
      if (disabledFp === undefined) return true;
      if (
        disabledFp === runtimeTelemetryRecordFingerprint(org.runtimeTelemetry)
      ) {
        return false;
      }
      // The org record changed since the server said disabled — retry.
      this.disabledRecordFingerprint.delete(org.orgId);
      return true;
    });
    if (orgs.length === 0) return null;
    return { identityKey: org2CloudAuthIdentityKey(auth), auth, orgs };
  }

  private orgDueAtMs(identityKey: string, org: Org2CloudOrg): number {
    const state = readMemberRuntimePushState(identityKey, org.orgId);
    return computeOrgDueAtMs({
      lastPushAtMs: state.lastPushAtMs,
      intervalMinutes: org.runtimeTelemetry?.intervalMinutes ?? 0,
      schedulerStartAtMs: this.schedulerStartAtMs,
      catchupJitterMs: this.catchupJitterMs,
      backoffNotBeforeMs: this.orgBackoff.get(org.orgId)?.notBeforeMs,
    });
  }

  /** Milliseconds until the earliest eligible org's deadline; null = idle. */
  private nextDelayMs(): number | null {
    const eligible = this.eligibleOrgs();
    if (!eligible) return null;
    let earliest: number | null = null;
    for (const org of eligible.orgs) {
      const dueAt = this.orgDueAtMs(eligible.identityKey, org);
      earliest = earliest == null ? dueAt : Math.min(earliest, dueAt);
    }
    if (earliest == null) return null;
    // Pass-level floors delay the whole chain, not individual orgs.
    earliest = Math.max(
      earliest,
      this.capabilityRecheckAtMs,
      this.authRetryNotBeforeMs
    );
    return Math.max(0, earliest - this.deps.now());
  }

  private async runPass(generation: number): Promise<void> {
    const store = this.store;
    if (!store || this.generation !== generation) return;
    const eligible = this.eligibleOrgs();
    if (!eligible) return;
    const now = this.deps.now();
    if (this.capabilityRecheckAtMs > now || this.authRetryNotBeforeMs > now) {
      return;
    }
    const dueOrgs = eligible.orgs.filter(
      (org) => this.orgDueAtMs(eligible.identityKey, org) <= now
    );
    if (dueOrgs.length === 0) return;

    const fresh = await this.deps.ensureFresh(eligible.auth);
    if (this.generation !== generation) return;
    if (!fresh) {
      log.warn("member runtime push skipped: token refresh failed");
      this.authRetryNotBeforeMs = this.deps.now() + AUTH_RETRY_DELAY_MS;
      return;
    }
    this.authRetryNotBeforeMs = 0;
    // Compare-and-set (auth atom may have been wiped/replaced mid-refresh).
    commitRefreshedAuth(
      (updater) => store.set(org2CloudAuthAtom, updater),
      eligible.auth,
      fresh
    );

    let capabilities: CloudCapabilities | null = null;
    try {
      capabilities = await this.deps.getCapabilities(fresh.accessToken);
    } catch {
      capabilities = null;
    }
    if (this.generation !== generation) return;
    if (!capabilities?.memberRuntime) {
      this.capabilityRecheckAtMs =
        this.deps.now() + MEMBER_RUNTIME_CAPABILITY_RECHECK_MS;
      return;
    }
    this.capabilityRecheckAtMs = 0;

    // The detection probe is machine-global: run it at most once per pass
    // and share the result across orgs that are due for a re-probe.
    let sharedAgentsProbe: Promise<MemberInstalledAgent[] | null> | null = null;
    const probeAgentsOnce = (): Promise<MemberInstalledAgent[] | null> => {
      if (!sharedAgentsProbe) {
        sharedAgentsProbe = this.deps.detectInstalledAgents().catch(() => null);
      }
      return sharedAgentsProbe;
    };

    for (const org of dueOrgs) {
      if (this.generation !== generation) return;
      try {
        await this.pushOrg(
          fresh.accessToken,
          eligible.identityKey,
          org,
          probeAgentsOnce
        );
        this.orgBackoff.delete(org.orgId);
      } catch (error) {
        this.noteOrgFailure(org, error);
      }
    }
  }

  private noteOrgFailure(org: Org2CloudOrg, error: unknown): void {
    if (isMemberRuntimeErrorCode(error, "ORG2_RUNTIME_DISABLED")) {
      // Server-authoritative: stop pushing this org until its roster record
      // changes. No backoff churn against a deliberate off switch.
      this.disabledRecordFingerprint.set(
        org.orgId,
        runtimeTelemetryRecordFingerprint(org.runtimeTelemetry)
      );
      this.orgBackoff.delete(org.orgId);
      return;
    }
    const failures = (this.orgBackoff.get(org.orgId)?.failures ?? 0) + 1;
    const delayMs = memberRuntimeBackoffDelayMs(failures);
    this.orgBackoff.set(org.orgId, {
      failures,
      notBeforeMs: this.deps.now() + delayMs,
    });
    const code = (error as { code?: MemberRuntimeErrorCode | null })?.code;
    log.warn(
      `member runtime push failed for org ${org.orgId}` +
        `${code ? ` (${code})` : ""}; retrying in ${Math.round(delayMs / 1000)}s`,
      error
    );
  }

  /** One org's tick: compose parts, upsert, persist fingerprints. */
  private async pushOrg(
    accessToken: string,
    identityKey: string,
    org: Org2CloudOrg,
    probeAgentsOnce: () => Promise<MemberInstalledAgent[] | null>
  ): Promise<void> {
    const state = readMemberRuntimePushState(identityKey, org.orgId);
    const nowMs = this.deps.now();

    // Status: cached machine identity + fresh burst sample. Failures here
    // reject the tick (status is the heartbeat).
    const machine = await this.deps.getMachine();
    const sample = await this.deps.getSample(nowMs);

    // Usage: recompute the rolling UTC-day window, delta-push changed rows.
    const windowStartMs =
      utcDayFloorMs(nowMs) - (MEMBER_USAGE_ROLLUP_WINDOW_DAYS - 1) * UTC_DAY_MS;
    const rollupRows = await this.deps.getDailyRollup(windowStartMs, nowMs);
    const usagePlan = planUsageDaysPush(
      mapRollupRowsToMemberUsageDays(rollupRows),
      state.usageFingerprint
    );

    // Profile: cache read only; included only when one exists and changed.
    let profilePart: MemberProfilePayload | undefined;
    let nextProfileFingerprint = state.profileFingerprint;
    try {
      const overview = await this.deps.getProfileOverview();
      const profile = overview.profile;
      if (profile.code && profile.sessions > 0) {
        const fingerprint = builderProfileFingerprint(profile);
        if (fingerprint !== state.profileFingerprint) {
          profilePart = { profile };
          nextProfileFingerprint = fingerprint;
        }
      }
    } catch {
      // No cached profile (or read failed): enrichment only — skip.
    }

    // Installed agents: probe at most once per detect floor, include only on
    // fingerprint change.
    let nextAgentsFingerprint = state.agentsFingerprint;
    let nextAgentsDetectAtMs = state.lastAgentsDetectAtMs;
    if (
      nowMs - state.lastAgentsDetectAtMs >=
      MEMBER_AGENTS_DETECT_MIN_INTERVAL_MS
    ) {
      const agents = await probeAgentsOnce();
      if (agents) {
        nextAgentsDetectAtMs = nowMs;
        const fingerprint = installedAgentsFingerprint(agents);
        if (fingerprint !== state.agentsFingerprint) {
          profilePart = { ...(profilePart ?? {}), installedAgents: agents };
          nextAgentsFingerprint = fingerprint;
        }
      }
    }

    const input: UpsertMemberRuntimeInput = {
      status: { machine, sample },
      ...(usagePlan.days.length > 0 ? { usageDays: usagePlan.days } : {}),
      ...(profilePart ? { profile: profilePart } : {}),
    };
    await this.deps.upsert(accessToken, org.orgId, input);

    const nextState: MemberRuntimePushState = {
      lastPushAtMs: nowMs,
      usageFingerprint: usagePlan.fingerprintsAfterPush,
      profileFingerprint: nextProfileFingerprint,
      agentsFingerprint: nextAgentsFingerprint,
      lastAgentsDetectAtMs: nextAgentsDetectAtMs,
    };
    writeMemberRuntimePushState(identityKey, org.orgId, nextState);
  }
}

/** App-wide singleton, started/stopped by `useOrg2CloudSyncEngine`. */
export const memberRuntimePushScheduler = new MemberRuntimePushScheduler();
