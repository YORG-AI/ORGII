/**
 * Explicit per-session → org tags ("move a session into a shared org").
 *
 * A session's org membership is REPO-SCOPE-driven: repo scope is the HARD
 * governance boundary (server-enforced — cloud_upsert_session_metadata
 * raises ORG2_SCOPE_FORBIDDEN outside it; no scopes = the org accepts no
 * sessions). This atom is a sharing affordance WITHIN that boundary: "share
 * THIS in-scope session to org X now" (e.g. before raising the org's access
 * ladder default). The session data never moves — it stays a normal local
 * session; the tag only makes the push machinery publish it to the tagged
 * org. A tag whose session falls OUT of scope (admin removed the scope) is
 * invalidated by the sync engine: server row retracted, tag dropped.
 *
 * Tokens are namespaced: a managed cloud org is stored as `cloud:<orgId>`
 * (buildCloudOrgSelectorValue). Bare `<orgId>` tokens are LEGACY entries
 * from the retired self-hosted track — the cloud helpers below simply skip
 * them (parseCloudOrgSelectorValue returns null), so old persisted
 * localStorage state keeps parsing without a migration.
 *
 * SAFETY: tagging never overrides the engine's echo-loop guard — an imported
 * teammate copy (`importedFrom`, pulled from the cloud) is never pushed, that
 * check running before the tag is ever consulted. The user's own external
 * history IS taggable and shareable (its full transcript is loaded from the
 * source adapter at push time).
 */
import { atomWithStorage } from "jotai/utils";

import {
  buildCloudOrgSelectorValue,
  parseCloudOrgSelectorValue,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";

/** sessionId → list of org tokens the session is explicitly tagged to. */
export type SessionOrgTags = Record<string, string[]>;

export const sessionOrgTagsAtom = atomWithStorage<SessionOrgTags>(
  "orgii:session-org-tags-v1",
  {}
);
sessionOrgTagsAtom.debugLabel = "sessionOrgTagsAtom";

/** Token for a cloud org (`cloud:` prefixed). */
export function cloudOrgToken(orgId: string): string {
  return buildCloudOrgSelectorValue(orgId);
}

/** All tokens a session is tagged to (empty array when untagged). */
export function tokensForSession(
  tags: SessionOrgTags,
  sessionId: string
): string[] {
  return tags[sessionId] ?? [];
}

/**
 * Cloud org ids a session is explicitly tagged to. Unknown/legacy tokens
 * (bare self-hosted org ids) parse to null and are skipped.
 */
export function cloudOrgIdsForSession(
  tags: SessionOrgTags,
  sessionId: string
): string[] {
  const out: string[] = [];
  for (const token of tokensForSession(tags, sessionId)) {
    const cloudId = parseCloudOrgSelectorValue(token);
    if (cloudId) out.push(cloudId);
  }
  return out;
}

export function isSessionTaggedToCloudOrg(
  tags: SessionOrgTags,
  sessionId: string,
  orgId: string
): boolean {
  return tokensForSession(tags, sessionId).includes(cloudOrgToken(orgId));
}

/** Every cloud org id that has at least one tagged session (target set). */
export function taggedCloudOrgIds(tags: SessionOrgTags): Set<string> {
  const out = new Set<string>();
  for (const sessionId of Object.keys(tags)) {
    for (const orgId of cloudOrgIdsForSession(tags, sessionId)) out.add(orgId);
  }
  return out;
}

/** Immutably add a token to a session's tag list (idempotent). */
export function withTag(
  tags: SessionOrgTags,
  sessionId: string,
  token: string
): SessionOrgTags {
  const current = tokensForSession(tags, sessionId);
  if (current.includes(token)) return tags;
  return { ...tags, [sessionId]: [...current, token] };
}

/** Immutably remove a token; drops the session key when it empties out. */
export function withoutTag(
  tags: SessionOrgTags,
  sessionId: string,
  token: string
): SessionOrgTags {
  const current = tokensForSession(tags, sessionId);
  if (!current.includes(token)) return tags;
  const next = current.filter((t) => t !== token);
  if (next.length === 0) {
    const { [sessionId]: _dropped, ...rest } = tags;
    return rest;
  }
  return { ...tags, [sessionId]: next };
}
