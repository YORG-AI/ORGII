/**
 * Pure helpers for ORG2 Cloud org management (invite lifecycle, deep links,
 * error-code surfaces, last-admin pre-checks) so the management client and
 * `CloudOrgPanelView` stay thin. React/Jotai/Tauri-free by design — every
 * export here is unit-testable in isolation.
 *
 * Invite CODE model used by the managed-cloud RPC contract:
 * the CLIENT mints a random 32-byte code, sends ONLY its sha256 to
 * `create_invite`, and keeps the plaintext to show exactly once. The server
 * (`cloud_list_invites`) never returns the code or even the hash — a lost
 * plaintext means minting a new invite.
 */
import { ORG2_CLOUD_OFFICIAL_SUPABASE_URL } from "./config";
import { isFetchTransportError } from "./org2CloudFetchRetry";

// ---------------------------------------------------------------------------
// Invite code generation / hashing
// ---------------------------------------------------------------------------

/** Complete role vocabulary accepted from the managed-cloud roster. */
export const CLOUD_ORG_ROLES = ["owner", "admin", "member"] as const;

export type CloudOrgRole = (typeof CLOUD_ORG_ROLES)[number];

/** Non-owner roles that admins may assign through invites or the roster. */
export const CLOUD_ASSIGNABLE_ROLES = ["admin", "member"] as const;

export type CloudAssignableRole = (typeof CLOUD_ASSIGNABLE_ROLES)[number];

const CLOUD_ASSIGNABLE_ROLE_SET: ReadonlySet<string> = new Set(
  CLOUD_ASSIGNABLE_ROLES
);

export function isCloudAssignableRole(
  value: unknown
): value is CloudAssignableRole {
  return typeof value === "string" && CLOUD_ASSIGNABLE_ROLE_SET.has(value);
}

/** Random 32-byte hex invite code (same entropy as self-hosted org secrets). */
export function generateCloudInviteCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** sha256 hex digest — the only representation of a code that goes on wire. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

// ---------------------------------------------------------------------------
// Invite deep link (orgii://cloud/join?invite=…)
//
// Rides the SAME OS-level `orgii://` scheme as the collaboration links
// (registered in src-tauri/tauri.conf.json `deep-link.desktop.schemes`), so
// no Rust change is needed — `useDeepLinkHandler` receives the raw URL from
// the Tauri deep-link plugin and branches on the `cloud` host here, exactly
// like `store/collaboration/deepLink.ts` does for `collaboration`.
// ---------------------------------------------------------------------------

export const CLOUD_INVITE_DEEP_LINK_HOST = "cloud";
export const CLOUD_INVITE_DEEP_LINK_PATH = "join";

export interface CloudInviteDeepLink {
  inviteCode: string;
}

export function buildCloudInviteLink(inviteCode: string): string {
  const params = new URLSearchParams({ invite: inviteCode });
  return `orgii://${CLOUD_INVITE_DEEP_LINK_HOST}/${CLOUD_INVITE_DEEP_LINK_PATH}?${params.toString()}`;
}

/**
 * Whether `url` is an `orgii://cloud/join` deep link (regardless of query
 * validity). Mirrors `isCollabJoinDeepLink`.
 */
export function isCloudInviteDeepLink(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("orgii://")) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    return (
      host === CLOUD_INVITE_DEEP_LINK_HOST &&
      path === CLOUD_INVITE_DEEP_LINK_PATH
    );
  } catch {
    return false;
  }
}

/**
 * Parse an `orgii://cloud/join?invite=…` deep link. Returns `null` for
 * anything that is not a valid cloud-invite link (wrong host/path, missing
 * code, malformed URL) so the deep-link handler can fall through.
 */
export function parseCloudInviteDeepLink(
  url: string
): CloudInviteDeepLink | null {
  if (!isCloudInviteDeepLink(url)) return null;
  try {
    const inviteCode = new URL(url.trim()).searchParams.get("invite")?.trim();
    return inviteCode ? { inviteCode } : null;
  } catch {
    return null;
  }
}

/**
 * Join-form input: accepts either a pasted `orgii://cloud/join?...` link or
 * a raw invite code. Returns the bare code, or `null` when empty / a link
 * without a code.
 */
export function parseCloudInviteInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith("orgii://")) {
    return parseCloudInviteDeepLink(trimmed)?.inviteCode ?? null;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Session share deep link (orgii://cloud/session?share=…, migration 0012)
//
// Same OS-level delivery as the invite link above. The token is the WHOLE
// credential. Links also carry non-secret endpoint provenance so a receiver
// with a custom endpoint configured does not accidentally resolve an
// official share against the wrong cloud (or silently switch its account).
// The resolve response carries the org/session coordinates for segment reads.
// ---------------------------------------------------------------------------

export const CLOUD_SHARE_DEEP_LINK_PATH = "session";

export type CloudShareEndpointProvenance =
  | { kind: "official" }
  | { kind: "custom"; supabaseUrl: string }
  | { kind: "current" };

export interface CloudShareDeepLink {
  shareToken: string;
  endpoint: CloudShareEndpointProvenance;
}

export interface CloudShareLinkEndpoint {
  isOfficial: boolean;
  supabaseUrl: string;
}

const DEFAULT_CLOUD_SHARE_LINK_ENDPOINT: CloudShareLinkEndpoint = {
  isOfficial: true,
  supabaseUrl: "",
};

function normalizeCloudShareEndpointUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const isSecure = url.protocol === "https:";
    const isLoopbackHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!isSecure && !isLoopbackHttp) return null;
    return value.trim().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function buildCloudSessionShareLink(
  shareToken: string,
  endpoint: CloudShareLinkEndpoint = DEFAULT_CLOUD_SHARE_LINK_ENDPOINT
): string {
  // A custom endpoint override that points at the OFFICIAL deployment must
  // mint an official link: a receiver on a stock build has no override
  // configured, and a `custom` link would fail its endpoint-mismatch gate
  // even though the token resolves against the managed cloud.
  const isOfficial =
    endpoint.isOfficial ||
    normalizeCloudShareEndpointUrl(endpoint.supabaseUrl) ===
      ORG2_CLOUD_OFFICIAL_SUPABASE_URL;
  const params = new URLSearchParams({
    share: shareToken,
    endpoint: isOfficial ? "official" : "custom",
  });
  if (!isOfficial) {
    const normalized = normalizeCloudShareEndpointUrl(endpoint.supabaseUrl);
    if (!normalized) throw new Error("Invalid custom cloud endpoint URL");
    params.set("endpointUrl", normalized);
  }
  return `orgii://${CLOUD_INVITE_DEEP_LINK_HOST}/${CLOUD_SHARE_DEEP_LINK_PATH}?${params.toString()}`;
}

/** Whether `url` is an `orgii://cloud/session` deep link. */
export function isCloudShareDeepLink(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("orgii://")) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    return (
      host === CLOUD_INVITE_DEEP_LINK_HOST &&
      path === CLOUD_SHARE_DEEP_LINK_PATH
    );
  } catch {
    return false;
  }
}

/**
 * Parse an `orgii://cloud/session?share=…` deep link. Returns `null` for
 * anything that is not a valid cloud-share link so the deep-link handler
 * can fall through.
 */
export function parseCloudShareDeepLink(
  url: string
): CloudShareDeepLink | null {
  if (!isCloudShareDeepLink(url)) return null;
  try {
    const params = new URL(url.trim()).searchParams;
    const shareToken = params.get("share")?.trim();
    if (!shareToken) return null;
    const endpointKind = params.get("endpoint")?.trim().toLowerCase();
    // Pre-provenance links were emitted only during pre-release. Treat them
    // as managed-cloud links; newly generated custom links are explicit.
    if (!endpointKind || endpointKind === "official") {
      return { shareToken, endpoint: { kind: "official" } };
    }
    if (endpointKind !== "custom") return null;
    const supabaseUrl = normalizeCloudShareEndpointUrl(
      params.get("endpointUrl") ?? ""
    );
    if (!supabaseUrl) return null;
    // Heal already-minted links whose custom URL IS the official deployment.
    if (supabaseUrl === ORG2_CLOUD_OFFICIAL_SUPABASE_URL) {
      return { shareToken, endpoint: { kind: "official" } };
    }
    return { shareToken, endpoint: { kind: "custom", supabaseUrl } };
  } catch {
    return null;
  }
}

const CLOUD_SHARE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Import-form input: accepts a pasted `orgii://cloud/session?share=…` link or a bare 64-char hex share token; `null` otherwise. */
export function parseCloudShareInput(raw: string): CloudShareDeepLink | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith("orgii://")) {
    return parseCloudShareDeepLink(trimmed);
  }
  return CLOUD_SHARE_TOKEN_PATTERN.test(trimmed)
    ? { shareToken: trimmed, endpoint: { kind: "current" } }
    : null;
}

// ---------------------------------------------------------------------------
// Invite records + state derivation (cloud_list_invites wire shape)
// ---------------------------------------------------------------------------

/** One invite row as listed by `cloud_list_invites` (admin-only). */
export interface CloudInviteRecord {
  inviteId: string;
  role: CloudAssignableRole;
  maxUses: number;
  usedCount: number;
  expiresAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export const CLOUD_INVITE_STATE = {
  ACTIVE: "active",
  REVOKED: "revoked",
  EXPIRED: "expired",
  EXHAUSTED: "exhausted",
} as const;

export type CloudInviteState =
  (typeof CLOUD_INVITE_STATE)[keyof typeof CLOUD_INVITE_STATE];

export function getCloudInviteRemainingUses(
  invite: Pick<CloudInviteRecord, "maxUses" | "usedCount">
): number {
  return Math.max(0, invite.maxUses - invite.usedCount);
}

/**
 * Lifecycle state of an invite row. Precedence mirrors the server's
 * `accept_invite` checks: revoked > expired > exhausted > active.
 */
export function deriveCloudInviteState(
  invite: Pick<
    CloudInviteRecord,
    "maxUses" | "usedCount" | "expiresAt" | "revokedAt"
  >,
  nowMs: number = Date.now()
): CloudInviteState {
  if (invite.revokedAt) return CLOUD_INVITE_STATE.REVOKED;
  if (invite.expiresAt) {
    const expiresMs = Date.parse(invite.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
      return CLOUD_INVITE_STATE.EXPIRED;
    }
  }
  if (getCloudInviteRemainingUses(invite) <= 0) {
    return CLOUD_INVITE_STATE.EXHAUSTED;
  }
  return CLOUD_INVITE_STATE.ACTIVE;
}

// ---------------------------------------------------------------------------
// Last-admin pre-check (client-side mirror of the server's ORG2_LAST_ADMIN
// guard, so the obvious cases fail fast without a round-trip)
// ---------------------------------------------------------------------------

export interface CloudMemberLike {
  userId: string;
  role: CloudOrgRole;
  status: string;
}

const ADMIN_ROLES = new Set(["owner", "admin"]);

/** Active owner/admin members excluding `excludedUserId` (post-op count). */
export function countOtherActiveAdmins(
  members: CloudMemberLike[],
  excludedUserId: string
): number {
  return members.filter(
    (member) =>
      member.status === "active" &&
      ADMIN_ROLES.has(member.role) &&
      member.userId !== excludedUserId
  ).length;
}

/**
 * Would demoting/removing `targetUserId` leave the org with zero active
 * owner/admin members? (The owner always counts as an admin, matching the
 * server check.) `false` when the target is not an active admin — removing
 * a plain member can never trip the guard.
 */
export function wouldRemoveLastAdmin(
  members: CloudMemberLike[],
  targetUserId: string
): boolean {
  const target = members.find(
    (member) => member.userId === targetUserId && member.status === "active"
  );
  if (!target || !ADMIN_ROLES.has(target.role)) return false;
  return countOtherActiveAdmins(members, targetUserId) === 0;
}

// ---------------------------------------------------------------------------
// Error codes (§22) surfaced by the management RPCs
// ---------------------------------------------------------------------------

/**
 * Codes the management UI reacts to specifically. Matched with `includes`
 * against the server's raised message (0009 ORG2_SCOPE_COOLDOWN precedent),
 * longest-first so no code can shadow a longer sibling.
 */
export const ORG2_MANAGEMENT_ERROR_CODES = [
  "ORG2_LAST_ADMIN",
  "ORG2_OWNER_MUST_TRANSFER",
  "ORG2_OWNER_REQUIRED",
  "ORG2_ADMIN_REQUIRED",
  "ORG2_MEMBER_REQUIRED",
  "ORG2_AUTH_REQUIRED",
  "ORG2_QUOTA_EXCEEDED",
  "ORG2_FORBIDDEN",
  "ORG2_MEMBER_NOT_FOUND",
  "ORG2_ORG_NOT_FOUND",
  "ORG2_NOT_FOUND",
  "ORG2_USE_LEAVE_ORG",
  "ORG2_VALIDATION",
  "ORG2_INVITE_INVALID",
  "ORG2_INVITE_REVOKED",
  "ORG2_INVITE_EXPIRED",
  "ORG2_INVITE_EXHAUSTED",
] as const;

export type Org2ManagementErrorCode =
  (typeof ORG2_MANAGEMENT_ERROR_CODES)[number];

const MANAGEMENT_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  ORG2_MANAGEMENT_ERROR_CODES
);

/** Extract the ORG2_* code carried in a server error message, if any. */
export function extractOrg2ManagementErrorCode(
  message: string
): Org2ManagementErrorCode | null {
  // Match whole ORG2_* tokens on a word boundary, not a substring: a future
  // longer server code that textually contains a listed one (e.g. a
  // hypothetical ORG2_NOT_FOUND_DETAIL) must never be mis-mapped to the
  // shorter listed code. Payload suffixes (ORG2_SCOPE_COOLDOWN <ts>) are a
  // separate token and are ignored when not themselves a listed code.
  const tokens = message.match(/\bORG2_[A-Z_]+\b/g);
  if (!tokens) return null;
  for (const token of tokens) {
    if (MANAGEMENT_ERROR_CODE_SET.has(token)) {
      return token as Org2ManagementErrorCode;
    }
  }
  return null;
}

/**
 * i18n keys (navigation namespace) for the codes worth a specific human
 * message. Codes not listed here (validation-tier internals) fall back to
 * the raw error message at the call site.
 */
const MANAGEMENT_ERROR_KEY_BY_CODE: Partial<
  Record<Org2ManagementErrorCode, string>
> = {
  ORG2_LAST_ADMIN: "cloud.orgManagement.errors.lastAdmin",
  ORG2_OWNER_MUST_TRANSFER: "cloud.orgManagement.errors.ownerMustTransfer",
  ORG2_OWNER_REQUIRED: "cloud.orgManagement.errors.ownerRequired",
  ORG2_ADMIN_REQUIRED: "cloud.orgManagement.errors.adminRequired",
  ORG2_QUOTA_EXCEEDED: "cloud.orgManagement.errors.quotaExceeded",
  ORG2_FORBIDDEN: "cloud.orgManagement.errors.forbidden",
  ORG2_MEMBER_NOT_FOUND: "cloud.orgManagement.errors.memberNotFound",
  ORG2_VALIDATION: "cloud.orgManagement.errors.validation",
  ORG2_INVITE_INVALID: "cloud.orgManagement.errors.inviteInvalid",
  ORG2_INVITE_REVOKED: "cloud.orgManagement.errors.inviteRevoked",
  ORG2_INVITE_EXPIRED: "cloud.orgManagement.errors.inviteExpired",
  ORG2_INVITE_EXHAUSTED: "cloud.orgManagement.errors.inviteExhausted",
} as const;

/** navigation-namespace i18n key for a recognized code, else null. */
export function cloudManagementErrorKey(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = extractOrg2ManagementErrorCode(error.message);
  return code ? (MANAGEMENT_ERROR_KEY_BY_CODE[code] ?? null) : null;
}

/**
 * Human message for a management failure: the translated specific message
 * when the code is recognized, a translated connection message for fetch
 * transport failures (WebKit's raw "Load failed" is meaningless to users),
 * the raw error message otherwise.
 */
export function cloudManagementErrorMessage(
  error: unknown,
  translate: (key: string) => string
): string {
  const key = cloudManagementErrorKey(error);
  if (key) return translate(key);
  if (isFetchTransportError(error)) {
    return translate("cloud.orgManagement.errors.network");
  }
  return error instanceof Error ? error.message : String(error);
}
