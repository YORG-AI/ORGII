/**
 * useForkImportedSession — "fork & continue" for an ALREADY-IMPORTED teammate
 * session, launched from inside the session view (header Fork button and the
 * composer's intercept-send dialog).
 *
 * Imported sessions (`imported-session-*`, `Session.importedFrom`) are
 * read-only replay copies with NO dispatch adapter — sending into them fails
 * at SessionService. The way forward is the same relay the cloud panel uses:
 * re-fetch the remote row for `importedFrom.sourceSessionId` and run
 * `forkTeammateSession` against the cloud backend. A member uses their JWT;
 * a guest import uses its persisted share capability anonymously and keeps
 * the writable fork in Personal.
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
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
import {
  isOrg2ShareErrorCode,
  resolveCloudSessionShare,
} from "../Org2Cloud/org2CloudSharesClient";
import {
  isOrg2SyncErrorCode,
  listOrgSessions,
} from "../Org2Cloud/org2CloudSyncClient";
import type {
  ForkSessionResult,
  ForkTeammateSessionOptions,
} from "./forkSession";
import { ForkCancelledError, forkTeammateSession } from "./forkSession";

const log = createLogger("useForkImportedSession");

export type ForkImportedErrorKind =
  | "retention"
  | "gone"
  | "generic"
  /** User dismissed the mandatory checkout picker — silent, no toast. */
  | "cancelled";
export type ForkImportedState = "idle" | "forking" | "error";

export type ForkImportedOutcome =
  | { ok: true; localSessionId: string; name: string; repoPath?: string }
  | { ok: false; errorKind: ForkImportedErrorKind };

type ImportedOrigin = Pick<
  SessionImportedFrom,
  "orgId" | "sourceSessionId" | "ownerMemberId" | "shareToken"
>;

// ============================================================================
// Pure backend resolution (unit-tested; no IO)
// ============================================================================

export type ImportedForkBackendResolution =
  | { kind: "cloud"; orgId: string }
  | { kind: "guestShare"; shareToken: string }
  | { kind: "unavailable"; errorKind: ForkImportedErrorKind };

/** The remote row this import came from, if it is still shared. */
export function pickImportedRemoteSession(
  remoteSessions: readonly RemoteTeammateSessionMetadata[],
  importedFrom: ImportedOrigin
): RemoteTeammateSessionMetadata | undefined {
  return remoteSessions.find(
    (session) =>
      session.orgId === importedFrom.orgId &&
      session.sourceSessionId === importedFrom.sourceSessionId &&
      !session.deletedAt
  );
}

/**
 * Membership wins when available. Otherwise, a persisted share capability
 * enables the anonymous guest fork path.
 */
export function resolveImportedSessionForkBackend(
  importedFrom: ImportedOrigin,
  cloudOrgs: readonly Org2CloudOrg[]
): ImportedForkBackendResolution {
  if (cloudOrgs.some((org) => org.orgId === importedFrom.orgId)) {
    return { kind: "cloud", orgId: importedFrom.orgId };
  }
  if (importedFrom.shareToken) {
    return { kind: "guestShare", shareToken: importedFrom.shareToken };
  }
  return { kind: "unavailable", errorKind: "generic" };
}

export interface GuestShareForkDeps {
  resolveShare: (shareToken: string) => Promise<RemoteTeammateSessionMetadata>;
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

/** Re-resolve and fork a share anonymously; the token is the only credential. */
export async function executeGuestShareFork(
  shareToken: string,
  deps: GuestShareForkDeps = GUEST_SHARE_FORK_DEPS
): Promise<ForkSessionResult | null> {
  const remoteSession = await deps.resolveShare(shareToken);
  return deps.fork({
    client: deps.buildClient(null),
    orgId: remoteSession.orgId,
    remoteSession,
    shareToken,
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

      if (resolution.kind === "guestShare") {
        const result = await executeGuestShareFork(resolution.shareToken);
        if (!result) return fail("generic");
        setState("idle");
        return {
          ok: true,
          localSessionId: result.localSessionId,
          name: result.name,
          repoPath: result.repoPath,
        };
      }

      if (!auth) return fail("generic");
      const fresh = await ensureFreshSession(auth);
      if (!fresh) return fail("generic");
      commitRefreshedAuth(setAuth, auth, fresh);
      // Server-side retention filter: a row that aged out simply is not
      // listed anymore → 'gone'.
      const { sessions } = await listOrgSessions(
        fresh.accessToken,
        resolution.orgId
      );
      const remoteSession = pickImportedRemoteSession(sessions, importedFrom);
      if (!remoteSession) return fail("gone");
      const result: ForkSessionResult | null = await forkTeammateSession({
        client: buildCloudSessionFetchClient(fresh.accessToken),
        orgId: resolution.orgId,
        remoteSession,
        promptForExecution: true,
      });
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
      log.error("failed to fork imported session", error);
      // A fork click can race past the cloud retention window even when the
      // listing still had the row — distinct message (upgrade prompt). A
      // revoked/expired guest capability is the same user-facing gone state.
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
