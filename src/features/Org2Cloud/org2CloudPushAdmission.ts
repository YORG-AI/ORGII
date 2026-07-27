/**
 * Pure push-admission decision: may THIS session publish to THIS org, and
 * if not, why. Extracted from the engine's pass loop so the same rules can
 * be replayed outside a full pass (retraction reconcile, tests, audit)
 * without duplicating them — a second copy of these rules is how a session
 * ends up published under one predicate and retracted under another.
 *
 * Ordering mirrors the engine: fork provenance first (a fork is a
 * continuation inside its source boundary, not an ordinary repo session),
 * then the ownership gate (explicit ownership / tag / share intent /
 * repo-scope auto-match). Repo-scope KEY matching stays in the caller: it
 * needs the async resolver cache and its `undefined` (in-flight) state,
 * which has no meaning in a pure decision.
 */
import type { Session } from "@src/store/session/sessionAtom/types";

import { isScopeMatchableImportedSession } from "../TeamCollaboration/importedSessionScopeMatch";

export const PUSH_ADMISSION_DENIAL = {
  /** Untagged fork whose provenance points at a different org. */
  FORK_OUTSIDE_SOURCE_ORG: "fork outside source org",
  /** No ownership, tag, share intent, or scope auto-match for this org. */
  OWNERSHIP_GATE: "ownership-gate (untagged/unowned/no-intent)",
} as const;

export type PushAdmissionDenial =
  (typeof PUSH_ADMISSION_DENIAL)[keyof typeof PUSH_ADMISSION_DENIAL];

export interface PushAdmissionInputs {
  /** The org this decision is about. */
  orgId: string;
  session: Pick<
    Session,
    "session_id" | "orgId" | "repoPath" | "repoRemoteUrls" | "parentSessionId"
  >;
  /** Durable fork provenance, already resolved through the registry. */
  forkedFrom: { orgId: string } | undefined;
  /** LIVE tag state for (session, org) — never a pass-start snapshot. */
  tagged: boolean;
  /** `session.orgId` parses to this org's canonical selector. */
  ownedByOrg: boolean;
  /** An explicit, non-off sharing-ladder entry exists for this session. */
  shareIntent: boolean;
}

export type PushAdmission =
  | { admitted: true }
  | { admitted: false; denial: PushAdmissionDenial };

export function decidePushAdmission(
  inputs: PushAdmissionInputs
): PushAdmission {
  const { orgId, session, forkedFrom, tagged, ownedByOrg, shareIntent } =
    inputs;

  // An untagged fork publishes ONLY back to its source org; an explicit tag
  // overrides provenance for that org alone.
  if (forkedFrom && forkedFrom.orgId !== orgId && !tagged) {
    return {
      admitted: false,
      denial: PUSH_ADMISSION_DENIAL.FORK_OUTSIDE_SOURCE_ORG,
    };
  }

  if (
    !forkedFrom &&
    !tagged &&
    !ownedByOrg &&
    !shareIntent &&
    !isScopeMatchableImportedSession(session)
  ) {
    return {
      admitted: false,
      denial: PUSH_ADMISSION_DENIAL.OWNERSHIP_GATE,
    };
  }

  return { admitted: true };
}
