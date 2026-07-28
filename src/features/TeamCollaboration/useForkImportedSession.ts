/**
 * useForkImportedSession — "fork & continue" for an ALREADY-IMPORTED teammate
 * session, launched from inside the session view (header Fork button and the
 * composer's intercept-send dialog).
 *
 * Imported sessions (`imported-session-*`, `Session.importedFrom`) are
 * read-only replay copies with NO dispatch adapter — sending into them fails
 * at SessionService. The way forward is the same relay the cloud panel uses:
 * re-fetch the remote row for `importedFrom.sourceSessionId` and run
 * `forkTeammateSession` against the cloud backend. Members and registered
 * non-members both use their JWT; a non-member import additionally uses its
 * persisted share capability and keeps the writable fork in Personal.
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import type {
  Session,
  SessionImportedFrom,
} from "@src/store/session/sessionAtom/types";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "../Org2Cloud/org2CloudAuthAtom";
import { buildCloudSessionFetchClient } from "../Org2Cloud/org2CloudBackendAdapter";
import { ensureFreshSession } from "../Org2Cloud/org2CloudClient";
import type { Org2CloudOrg } from "../Org2Cloud/org2CloudOrgsAtom";
import { org2CloudOrgsAtom } from "../Org2Cloud/org2CloudOrgsAtom";
import { resolvePersistedCloudShareEndpoint } from "../Org2Cloud/org2CloudShareEndpoint";
import {
  isOrg2ShareErrorCode,
  resolveCloudSessionShare,
} from "../Org2Cloud/org2CloudSharesClient";
import { isOrg2SyncErrorCode } from "../Org2Cloud/org2CloudSyncClient";
import { executeAuthenticatedCloudSessionFork } from "./cloudSessionFork";
import type {
  ForkSessionResult,
  ForkTeammateSessionOptions,
} from "./forkSession";
import { ForkCancelledError, forkTeammateSession } from "./forkSession";
import { classifyForkOperationError } from "./forkSnapshotIntegrity";

const log = createLogger("useForkImportedSession");

export type ForkImportedErrorKind =
  | "retention"
  | "gone"
  | "replay"
  | "snapshot"
  | "agent"
  | "backend"
  | "generic"
  /** User dismissed the mandatory checkout picker — silent, no toast. */
  | "cancelled";
export type ForkImportedState = "idle" | "forking" | "error";

export type ForkImportedOutcome =
  | { ok: true; localSessionId: string; name: string; repoPath?: string }
  | { ok: false; errorKind: ForkImportedErrorKind };

type ImportedOrigin = Pick<
  SessionImportedFrom,
  | "orgId"
  | "sourceSessionId"
  | "ownerMemberId"
  | "shareToken"
  | "shareEndpointUrl"
>;

// ============================================================================
// Pure backend resolution (unit-tested; no IO)
// ============================================================================

export type ImportedForkBackendResolution =
  | { kind: "cloud"; orgId: string }
  | { kind: "guestShare"; shareToken: string; shareEndpointUrl?: string }
  | { kind: "unavailable"; errorKind: ForkImportedErrorKind };

/**
 * Membership wins when available. Otherwise, a persisted share capability
 * enables the registered non-member fork path.
 */
export function resolveImportedSessionForkBackend(
  importedFrom: ImportedOrigin,
  cloudOrgs: readonly Org2CloudOrg[]
): ImportedForkBackendResolution {
  if (cloudOrgs.some((org) => org.orgId === importedFrom.orgId)) {
    return { kind: "cloud", orgId: importedFrom.orgId };
  }
  if (importedFrom.shareToken) {
    return {
      kind: "guestShare",
      shareToken: importedFrom.shareToken,
      shareEndpointUrl: importedFrom.shareEndpointUrl,
    };
  }
  return { kind: "unavailable", errorKind: "generic" };
}

export interface GuestShareForkDeps {
  resolveShare: typeof resolveCloudSessionShare;
  buildClient: typeof buildCloudSessionFetchClient;
  fork: (
    options: ForkTeammateSessionOptions
  ) => Promise<ForkSessionResult | null>;
}

const GUEST_SHARE_FORK_DEPS: GuestShareForkDeps = {
  resolveShare: resolveCloudSessionShare,
  buildClient: buildCloudSessionFetchClient,
  fork: forkTeammateSession,
};

/** Re-resolve and fork as a registered non-member against the issuing cloud. */
export async function executeGuestShareFork(
  accessToken: string,
  shareToken: string,
  shareEndpointUrl?: string,
  deps: GuestShareForkDeps = GUEST_SHARE_FORK_DEPS
): Promise<ForkSessionResult | null> {
  const endpoint = resolvePersistedCloudShareEndpoint(shareEndpointUrl);
  const remoteSession = await deps.resolveShare(
    accessToken,
    shareToken,
    endpoint
  );
  return deps.fork({
    client: deps.buildClient(accessToken, endpoint),
    orgId: remoteSession.orgId,
    remoteSession,
    shareToken,
    promptForExecution: true,
  });
}

// ============================================================================
// The hook
// ============================================================================

export function useForkImportedSession(session: Session | null | undefined) {
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const [state, setState] = useState<ForkImportedState>("idle");
  const [errorKind, setErrorKind] = useState<ForkImportedErrorKind | null>(
    null
  );

  const importedFrom = session?.importedFrom;

  const fork = useCallback(async (): Promise<ForkImportedOutcome> => {
    const fail = (kind: ForkImportedErrorKind): ForkImportedOutcome => {
      setErrorKind(kind);
      setState("error");
      return { ok: false, errorKind: kind };
    };
    if (!importedFrom) return fail("generic");
    setState("forking");
    setErrorKind(null);
    try {
      const resolution = resolveImportedSessionForkBackend(
        importedFrom,
        cloudOrgs
      );
      if (resolution.kind === "unavailable") {
        return fail(resolution.errorKind);
      }

      if (!auth) return fail("generic");
      const fresh = await ensureFreshSession(auth);
      if (!fresh) return fail("generic");
      if (!commitRefreshedAuth(setAuth, auth, fresh)) return fail("generic");

      if (resolution.kind === "guestShare") {
        const result = await executeGuestShareFork(
          fresh.accessToken,
          resolution.shareToken,
          resolution.shareEndpointUrl
        );
        if (!result) return fail("generic");
        setState("idle");
        return {
          ok: true,
          localSessionId: result.localSessionId,
          name: result.name,
          repoPath: result.repoPath,
        };
      }

      // Server-side retention filter: a row that aged out simply is not
      // listed anymore → 'gone'. The same helper powers owner @agent on
      // immutable external histories, keeping every cloud-source fork on one
      // implementation.
      const outcome = await executeAuthenticatedCloudSessionFork(
        fresh.accessToken,
        importedFrom
      );
      if (outcome.status === "gone") return fail("gone");
      const { result } = outcome;
      if (!result) {
        // Owner has published no segments — nothing to inherit.
        return fail("generic");
      }
      setState("idle");
      return {
        ok: true,
        localSessionId: result.localSessionId,
        name: result.name,
        // The RESOLVED local checkout (forkTeammateSession), or undefined
        // when this machine has no checkout — never the owner's dead path.
        repoPath: result.repoPath,
      };
    } catch (error) {
      if (error instanceof ForkCancelledError) {
        // Quiet cancel: user dismissed the mandatory checkout picker.
        setState("idle");
        return { ok: false, errorKind: "cancelled" };
      }
      const operationKind = classifyForkOperationError(error);
      log.error("failed to fork imported session", {
        sourceSessionId: importedFrom.sourceSessionId,
        orgId: importedFrom.orgId,
        stage: operationKind ?? "unknown",
        error,
      });
      // A fork click can race past the cloud retention window even when the
      // listing still had the row — distinct message (upgrade prompt). A
      // revoked/expired guest capability is the same user-facing gone state.
      if (operationKind === "replay_unavailable") return fail("replay");
      if (operationKind === "snapshot_incomplete") return fail("snapshot");
      if (operationKind === "segment_integrity") return fail("snapshot");
      if (operationKind === "agent_unavailable") return fail("agent");
      if (operationKind === "backend_registration") return fail("backend");
      if (isOrg2SyncErrorCode(error, "ORG2_RETENTION_EXPIRED")) {
        return fail("retention");
      }
      if (isOrg2ShareErrorCode(error, "ORG2_UNAUTHORIZED")) {
        return fail("gone");
      }
      return fail("generic");
    }
  }, [importedFrom, cloudOrgs, auth, setAuth]);

  return { fork, state, errorKind };
}
