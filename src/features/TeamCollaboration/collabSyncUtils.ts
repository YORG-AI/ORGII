/**
 * Backend-agnostic sync helpers shared with the managed ORG2 Cloud plane:
 * repo-scope key normalization/matching (design §8.3), the default access
 * settings, the wire-metadata builder (`toRemoteMetadata` — its row-id
 * format is cloud protocol) and the hashing primitives the segments push
 * protocol uses. The self-hosted-only eligibility helpers were deleted with
 * the in-app self-hosted track (cloud-parity Phase E).
 */
import {
  COLLAB_SESSION_ACCESS_MODE,
  COLLAB_SESSION_ORIGIN_KIND,
  COLLAB_SESSION_REPLAY_LEVEL,
  COLLAB_SESSION_VISIBILITY,
  COLLAB_WORKSPACE_SCOPE,
} from "@src/store/collaboration/types";
import type {
  CollabSessionAccessMode,
  CollabSessionVisibility,
} from "@src/store/collaboration/types";
import type {
  CollabMemberRecord,
  CollabOrgRecord,
  CollabSessionAccessSettings,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";
import { getExternalHistorySourceId } from "@src/util/session/sessionDispatch";

function stripRepoScopePathSuffix(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/i, "");
}

// Hosts that treat the owner/repo path case-insensitively. On these, the path
// is lowercased so `MyOrg/MyRepo` and `myorg/myrepo` resolve to one scope key.
const CASE_INSENSITIVE_SCOPE_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
]);

const DEFAULT_SCHEME_PORTS: Record<string, string> = {
  https: "443",
  http: "80",
  ssh: "22",
  git: "9418",
};

// `host[:port]` → host, dropping only the scheme's default port so that
// `github.com:443` and `github.com` collapse to one key.
function stripDefaultPort(
  hostWithPort: string,
  scheme: string | undefined
): string {
  const portMatch = /^(.+):(\d+)$/.exec(hostWithPort);
  if (!portMatch) return hostWithPort;
  const [, host, port] = portMatch;
  if (scheme && DEFAULT_SCHEME_PORTS[scheme.toLowerCase()] === port)
    return host;
  return hostWithPort;
}

function applyHostCaseFolding(host: string, path: string): string {
  return CASE_INSENSITIVE_SCOPE_HOSTS.has(host)
    ? `${host}${path.toLowerCase()}`
    : `${host}${path}`;
}

/**
 * Repo scope key normalization (design §8.3): scope keys are normalized git
 * remote URLs, so two machines with different checkout paths agree on the
 * same key. Every remote form collapses to `host/path`:
 *
 *   git@github.com:org/x.git      → github.com/org/x
 *   https://github.com/org/x.git  → github.com/org/x
 *   ssh://git@github.com/org/x    → github.com/org/x
 *
 * Non-URL inputs (absolute paths, for repos without a remote) are returned
 * trimmed minus trailing slashes — path-vs-path matching is unchanged.
 */
export function normalizeRepoScopeKey(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  // scheme://[user[:pass]@]host[:port]/path
  const urlMatch = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]+@)?([^/]+)(\/.*)?$/i.exec(
    trimmed
  );
  if (urlMatch) {
    const scheme = urlMatch[1];
    const host = stripDefaultPort(urlMatch[2].toLowerCase(), scheme);
    const path = stripRepoScopePathSuffix(urlMatch[3] ?? "");
    return applyHostCaseFolding(host, path);
  }

  // scp-like syntax: [user@]host:path. The host must look like a hostname
  // (an explicit user@ or a dot) so Windows drive letters fall through.
  const scpMatch = /^(?:([^/@:]+)@)?([^/@:]+):(.+)$/.exec(trimmed);
  if (scpMatch && (scpMatch[1] !== undefined || scpMatch[2].includes("."))) {
    const host = scpMatch[2].toLowerCase();
    const path = stripRepoScopePathSuffix(
      `/${scpMatch[3].replace(/^\/+/, "")}`
    );
    return applyHostCaseFolding(host, path);
  }

  return trimmed;
}

/**
 * True for inputs that are local filesystem paths (POSIX absolute or a
 * Windows drive letter) rather than remote-style scope keys. A local path is
 * exactly what `resolveShareableScopeKey` must have failed to resolve — no
 * git remote means no shareable identity.
 */
export function isLocalRepoPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\\\\\?\\(?:[a-zA-Z]:\\|UNC\\)/i.test(value) ||
    value.startsWith("\\\\")
  );
}

/**
 * Scope matching (design §8.3, single point): both sides go through
 * `normalizeRepoScopeKey`, so a scope key stored in any remote-URL format
 * matches a candidate key in any other format. The candidate is a RESOLVED
 * scope key (the normalized git remote of the repo), never a local path —
 * resolution happens on the owner/submitter side (`resolveShareableScopeKey`)
 * because it requires async IPC. `null`/`undefined` means "repo has no
 * remote / key not carried" and matches nothing: sharing is git-remote-only.
 */
export function isScopeKeyInScopes(
  scopeKey: string | null | undefined,
  orgRepoScopes: string[] | undefined
): boolean {
  if (!scopeKey) return false;
  const normalized = normalizeRepoScopeKey(scopeKey);
  if (!normalized) return false;
  if (!orgRepoScopes || orgRepoScopes.length === 0) return false;
  return orgRepoScopes.some(
    (scope) => normalizeRepoScopeKey(scope) === normalized
  );
}

/**
 * Multi-remote scope matching: which of the org's stored scopes covers ANY
 * of the session's shareable keys (a fork checkout carries several — origin
 * fork + team upstream)? Returns the ORG'S stored scope string, not the
 * session key: the server compares `metadata->>'repoScopeKey'` against
 * `orgs.repo_scopes` by EXACT string, so pushing the org-side value is the
 * only representation guaranteed to pass. Null = no key matches.
 */
export function pickMatchingOrgScope(
  scopeKeys: readonly string[] | null | undefined,
  orgRepoScopes: string[] | undefined
): string | null {
  if (!scopeKeys || scopeKeys.length === 0) return null;
  if (!orgRepoScopes || orgRepoScopes.length === 0) return null;
  const normalizedKeys = new Set(
    scopeKeys.map((key) => normalizeRepoScopeKey(key)).filter(Boolean)
  );
  if (normalizedKeys.size === 0) return null;
  return (
    orgRepoScopes.find((scope) =>
      normalizedKeys.has(normalizeRepoScopeKey(scope))
    ) ?? null
  );
}

/**
 * Effective access mode for ONE session under ONE org's settings (design
 * §6.3). Resolution order:
 * 1. an explicit `sessionOverrides` entry wins outright — it is the escape
 *    hatch that can re-share a pre-shareSince session (or silence a new one);
 * 2. otherwise the `shareSince` gate: with shareSince set, sessions CREATED
 *    before it resolve to OFF (creation time, not last activity — reopening
 *    an old session must not drag its full history to the org). Unparseable
 *    timestamps on either side also gate to OFF: when we cannot prove the
 *    session is new, privacy wins;
 * 3. otherwise the member-level default `accessMode`.
 */
function getEffectiveAccessMode(
  session: Pick<Session, "session_id" | "created_at">,
  settings: CollabSessionAccessSettings
): CollabSessionAccessMode {
  const override = settings.sessionOverrides?.[session.session_id];
  if (override) return override;
  if (settings.shareSince) {
    const createdAtMs = Date.parse(session.created_at);
    const shareSinceMs = Date.parse(settings.shareSince);
    const createdAfterShareSince =
      Number.isFinite(createdAtMs) &&
      Number.isFinite(shareSinceMs) &&
      createdAtMs >= shareSinceMs;
    if (!createdAfterShareSince) return COLLAB_SESSION_ACCESS_MODE.OFF;
  }
  return settings.accessMode;
}

/**
 * THE default access settings (design §6.3, fix S8): sharing is OFF until the
 * member explicitly opts in. Single export — engine fallbacks and settings
 * models must not disagree on the default.
 */
export function createDefaultAccessSettings(
  orgId: string,
  memberId: string
): CollabSessionAccessSettings {
  return {
    orgId,
    memberId,
    accessMode: COLLAB_SESSION_ACCESS_MODE.OFF,
    workspaceScope: COLLAB_WORKSPACE_SCOPE.SELECTED_WORKSPACES,
    workspacePaths: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Server-side visibility to publish for ONE session (design §6.2, M4b):
 * 'restricted' only when the owner explicitly picked "only me + people I
 * pick" in the share dialog (persisted in settings.sessionVisibility);
 * everything else stays org-visible. There is no 'restricted' access MODE —
 * visibility is orthogonal to the off/metadata/replay ladder.
 */
function getSessionVisibility(
  session: Pick<Session, "session_id">,
  settings: CollabSessionAccessSettings
): CollabSessionVisibility {
  return settings.sessionVisibility?.[session.session_id] ===
    COLLAB_SESSION_VISIBILITY.RESTRICTED
    ? COLLAB_SESSION_VISIBILITY.RESTRICTED
    : COLLAB_SESSION_VISIBILITY.ORG;
}

export function toRemoteMetadata(
  session: Session,
  org: CollabOrgRecord,
  member: CollabMemberRecord,
  settings: CollabSessionAccessSettings,
  repoScopeKey?: string | null
): RemoteTeammateSessionMetadata {
  const effectiveMode = getEffectiveAccessMode(session, settings);
  const externalHistorySource = getExternalHistorySourceId(session.session_id);
  return {
    id: `${org.id}:${member.id}:${session.session_id}`,
    orgId: org.id,
    ownerMemberId: member.id,
    ownerUserId: member.id,
    ownerDisplayName: member.displayName,
    ownerIdentityKind: member.identityKind,
    sourceSessionId: session.session_id,
    title: session.name || session.user_input || session.session_id,
    status: String(session.status),
    repoPath: session.repoPath,
    // Cross-machine repo identity (design §8.3): consumers match THIS
    // against org.repoScopes — repoPath above is display-only (the owner's
    // local absolute path). Absent ⇒ repo has no git remote ⇒ out of scope.
    repoScopeKey: repoScopeKey ?? undefined,
    branch: session.branch || session.worktreeBranch,
    // Agent/model identity for the teammate hover card (display only;
    // raw values — the consumer formats via formatAgentType/ModelIcon).
    cliAgentType: session.cliAgentType ?? undefined,
    agentDisplayName: session.agentDisplayName,
    agentDefinitionId: session.agentDefinitionId,
    model: session.model,
    origin: externalHistorySource
      ? {
          kind: COLLAB_SESSION_ORIGIN_KIND.EXTERNAL_HISTORY,
          source: externalHistorySource,
        }
      : { kind: COLLAB_SESSION_ORIGIN_KIND.ORGII },
    lastActivityAt: session.updated_at || session.updated_time,
    accessMode: effectiveMode,
    // Sharing plane (design §6.2): visibility follows the owner's explicit
    // per-session choice from the M4b share dialog; replayLevel derives from
    // the effective mode.
    visibility: getSessionVisibility(session, settings),
    replayLevel:
      effectiveMode === COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
        ? COLLAB_SESSION_REPLAY_LEVEL.REPLAY
        : COLLAB_SESSION_REPLAY_LEVEL.METADATA,
    // Fork lineage (design §16.11): published so teammates can group fork
    // threads. rootSessionId falls back to the immediate source for
    // pre-lineage local forks (source WAS the root unless recorded deeper).
    forkedFrom: session.forkedFrom
      ? {
          sourceSessionId: session.forkedFrom.sourceSessionId,
          rootSessionId:
            session.forkedFrom.rootSessionId ??
            session.forkedFrom.sourceSessionId,
          ownerDisplayName: session.forkedFrom.ownerDisplayName,
          forkedAt: session.forkedFrom.forkedAt,
        }
      : undefined,
    // Segments summary is server-owned (append/rewrite RPCs maintain it);
    // metadata pushes never carry it.
    eventsEpoch: undefined,
    eventsFrozenSeq: undefined,
    eventsCount: undefined,
    eventsTailHash: undefined,
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Deterministic JSON with recursively sorted object keys. Used for the
 * per-event hash vector of the segments push protocol (design §7.3 step 2):
 * event objects are rebuilt by serde on every read, so hashing must not
 * depend on incidental key order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}
