/** Low-volume, plane-specific nudges carried by the active org Presence channel. */

export const ORG_CONTROL_CHANGED_EVENT = "org-control-changed";

export type Org2CloudControlChangeKind =
  | "entitlement"
  | "roster"
  | "scopes"
  | "sessions";

type BroadcastSender = (
  event: string,
  payload: Record<string, unknown>
) => void;

const senders = new Map<string, BroadcastSender>();
const pendingSessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Wired by useOrg2CloudRealtime while this instance owns the org channel. */
export function registerOrgControlBroadcaster(
  orgId: string,
  sender: BroadcastSender
): () => void {
  senders.set(orgId, sender);
  return () => {
    if (senders.get(orgId) !== sender) return;
    senders.delete(orgId);
    const timer = pendingSessionTimers.get(orgId);
    if (timer) clearTimeout(timer);
    pendingSessionTimers.delete(orgId);
  };
}

/**
 * Notify peers that a specific control plane changed. The server's durable
 * org_change_signals row remains the low-frequency recovery path when no
 * channel is open or a broadcast is missed.
 */
export function broadcastOrgControlChangedToPeers(
  orgId: string,
  kind: Org2CloudControlChangeKind
): void {
  const sender = senders.get(orgId);
  if (!sender) return;
  if (kind === "sessions") {
    // Metadata + event payload writes touch the same logical row in quick
    // succession. Collapse them into one peer listing refresh.
    if (pendingSessionTimers.has(orgId)) return;
    const timer = setTimeout(() => {
      pendingSessionTimers.delete(orgId);
      if (senders.get(orgId) === sender) {
        sender(ORG_CONTROL_CHANGED_EVENT, { kind });
      }
    }, 250);
    pendingSessionTimers.set(orgId, timer);
    return;
  }
  sender(ORG_CONTROL_CHANGED_EVENT, { kind });
}

export function parseOrgControlChangeKind(
  payload: Record<string, unknown>
): Org2CloudControlChangeKind | null {
  const kind = payload.kind;
  return kind === "entitlement" ||
    kind === "roster" ||
    kind === "scopes" ||
    kind === "sessions"
    ? kind
    : null;
}
