import {
  readIdentitySnapshot,
  subscribeIdentitySnapshotChanges,
} from "./identitySnapshotAtom";
import {
  type IdentitySnapshot,
  getActiveIdentitySession,
} from "./identityTypes";

export type SignInIntent =
  | { kind: "open_cloud_settings" }
  | { kind: "create_org" }
  | { kind: "accept_invite"; inviteId: string }
  | { kind: "import_share"; shareId: string }
  | { kind: "share_session"; sessionId: string }
  | { kind: "open_billing"; returnPath: "/billing" }
  | { kind: "resume_route"; path: string };

export const SIGN_IN_INTENT_RESOLVED_EVENT =
  "identity://sign-in-intent-resolved";
export const SIGN_IN_INTENT_TTL_MS = 10 * 60 * 1_000;

type IntentBinding =
  | { kind: "broker"; flowId: string; generation: number }
  | { kind: "legacy" };

interface PendingSignInIntent {
  ticket: number;
  intent: SignInIntent;
  createdAtMs: number;
  expiresAtMs: number;
  stagedRevision: number;
  binding: IntentBinding | null;
}

let ticketCounter = 0;
let pending: PendingSignInIntent | null = null;
let lifecycleInstalled = false;

function isSafeOpaqueId(value: string): boolean {
  return (
    value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export function isSafeInternalPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 2_048 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return false;
  }
  try {
    const parsed = new URL(path, "https://desktop.orgii.invalid");
    return parsed.origin === "https://desktop.orgii.invalid";
  } catch {
    return false;
  }
}

export function isAllowedSignInIntent(intent: SignInIntent): boolean {
  switch (intent.kind) {
    case "open_cloud_settings":
    case "create_org":
      return true;
    case "accept_invite":
      return isSafeOpaqueId(intent.inviteId);
    case "import_share":
      return isSafeOpaqueId(intent.shareId);
    case "share_session":
      return isSafeOpaqueId(intent.sessionId);
    case "open_billing":
      return intent.returnPath === "/billing";
    case "resume_route":
      return isSafeInternalPath(intent.path);
  }
}

export function stageSignInIntent(
  intent: SignInIntent,
  nowMs = Date.now()
): number {
  if (!isAllowedSignInIntent(intent)) {
    throw new Error("sign_in_intent_invalid");
  }
  const ticket = ++ticketCounter;
  pending = {
    ticket,
    intent: { ...intent },
    createdAtMs: nowMs,
    expiresAtMs: nowMs + SIGN_IN_INTENT_TTL_MS,
    stagedRevision: readIdentitySnapshot().revision,
    binding: null,
  };
  return ticket;
}

export function bindBrokerSignInIntent(
  ticket: number,
  flowId: string,
  generation: number
): boolean {
  if (!pending || pending.ticket !== ticket) return false;
  pending.binding = { kind: "broker", flowId, generation };
  return true;
}

export function bindLegacySignInIntent(ticket: number): boolean {
  if (!pending || pending.ticket !== ticket) return false;
  pending.binding = { kind: "legacy" };
  return true;
}

export function clearSignInIntent(ticket?: number): void {
  if (ticket !== undefined && pending?.ticket !== ticket) return;
  pending = null;
}

export function peekSignInIntent(nowMs = Date.now()): SignInIntent | null {
  if (pending && pending.expiresAtMs <= nowMs) pending = null;
  return pending ? { ...pending.intent } : null;
}

/** Consume only after the exact login flow has disappeared into a Ready session. */
export function resolveSignInIntent(
  snapshot: IdentitySnapshot,
  nowMs = Date.now()
): SignInIntent | null {
  if (!pending || pending.expiresAtMs <= nowMs) {
    pending = null;
    return null;
  }
  const binding = pending.binding;
  if (!binding) return null;
  const session = getActiveIdentitySession(snapshot, "org2_cloud");
  if (!session || session.status !== "ready") return null;

  if (binding.kind === "broker") {
    if (session.generation < binding.generation) return null;
    if (snapshot.flows.some((flow) => flow.flowId === binding.flowId)) {
      return null;
    }
  } else if (snapshot.revision <= pending.stagedRevision) {
    return null;
  }

  const resolved = { ...pending.intent };
  pending = null;
  return resolved;
}

export function installSignInIntentLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  subscribeIdentitySnapshotChanges((snapshot) => {
    const intent = resolveSignInIntent(snapshot);
    if (!intent || typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent<SignInIntent>(SIGN_IN_INTENT_RESOLVED_EVENT, {
        detail: intent,
      })
    );
  });
}
