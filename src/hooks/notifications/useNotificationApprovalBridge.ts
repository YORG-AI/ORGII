import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { notifyAgentApproval } from "@src/api/services/notification";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";
import type { NotificationSettings } from "@src/types/ui/notification";

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 256;

export const PERMISSION_APPROVAL_NOTIFICATION_BODY = "Action requires approval";
export const PLAN_APPROVAL_NOTIFICATION_BODY = "Plan ready for approval";

type ApprovalNotification = {
  kind: "permission" | "plan";
  sessionId: string;
  requestId: string;
};

type ApprovalEventSubscriber = (
  eventType: string,
  handler: (message: unknown) => void
) => () => void;

type ApprovalNotifier = (
  body: string,
  settings: NotificationSettings,
  context: { sessionId: string }
) => unknown;

interface ApprovalNotificationSubscriptionOptions {
  subscribe: ApprovalEventSubscriber;
  getSettings: () => NotificationSettings;
  deduper?: ApprovalNotificationDeduper;
  notify?: ApprovalNotifier;
}

export class ApprovalNotificationDeduper {
  private readonly seenAt = new Map<string, number>();

  shouldNotify(key: string, now: number = Date.now()): boolean {
    for (const [entryKey, timestamp] of this.seenAt) {
      if (now - timestamp > DEDUPE_TTL_MS) {
        this.seenAt.delete(entryKey);
      }
    }

    if (this.seenAt.has(key)) return false;
    while (this.seenAt.size >= MAX_DEDUPE_ENTRIES) {
      const oldestKey = this.seenAt.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.seenAt.delete(oldestKey);
    }
    this.seenAt.set(key, now);
    return true;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Normalize the two approval wire shapes without retaining private payload
 * details. Native agents send `{ type, payload }`; CLI agents send flat fields.
 */
export function parseApprovalNotificationMessage(
  message: unknown
): ApprovalNotification | null {
  const envelope = asRecord(message);
  if (!envelope) return null;

  const type = envelope.type;
  if (
    type !== "permission:request" &&
    type !== "agent:plan_ready_for_approval"
  ) {
    return null;
  }

  const payload = asRecord(envelope.payload) ?? envelope;
  const sessionId = firstString(
    payload.sessionId,
    payload.session_id,
    envelope.sessionId,
    envelope.session_id
  );
  if (!sessionId) return null;

  if (type === "permission:request") {
    const requestId = firstString(payload.requestId, envelope.requestId);
    return requestId ? { kind: "permission", sessionId, requestId } : null;
  }

  const planEventSource = firstString(
    payload.planEventSource,
    envelope.planEventSource
  );
  if (planEventSource === "rehydrate") return null;

  const requestId = firstString(
    payload.requestId,
    payload.planRevisionId,
    payload.toolCallId,
    payload.originToolCallId,
    envelope.requestId,
    envelope.planRevisionId,
    envelope.toolCallId,
    envelope.originToolCallId
  );
  return requestId ? { kind: "plan", sessionId, requestId } : null;
}

export function isApprovalNotificationOwner(
  tauriRuntime: boolean,
  windowLabel?: string
): boolean {
  return !tauriRuntime || windowLabel === "main";
}

function isMainNotificationWindow(): boolean {
  try {
    const tauriRuntime = isTauri();
    return isApprovalNotificationOwner(
      tauriRuntime,
      tauriRuntime ? getCurrentWindow().label : undefined
    );
  } catch {
    // If a Tauri renderer cannot prove that it is the main window, it must not
    // compete for app-wide notifications. Non-Tauri tests take the safe branch
    // above and remain able to exercise the subscription logic.
    return false;
  }
}

const globalApprovalNotificationDeduper = new ApprovalNotificationDeduper();

export function subscribeToApprovalNotifications({
  subscribe,
  getSettings,
  deduper = globalApprovalNotificationDeduper,
  notify = notifyAgentApproval,
}: ApprovalNotificationSubscriptionOptions): () => void {
  const handleMessage = (message: unknown) => {
    const approval = parseApprovalNotificationMessage(message);
    if (!approval) return;

    const key = `${approval.sessionId}:${approval.kind}:${approval.requestId}`;
    if (!deduper.shouldNotify(key)) return;

    const body =
      approval.kind === "permission"
        ? PERMISSION_APPROVAL_NOTIFICATION_BODY
        : PLAN_APPROVAL_NOTIFICATION_BODY;
    void notify(body, getSettings(), { sessionId: approval.sessionId });
  };

  const unsubscribePermission = subscribe("permission:request", handleMessage);
  const unsubscribePlan = subscribe(
    "agent:plan_ready_for_approval",
    handleMessage
  );

  return () => {
    unsubscribePermission();
    unsubscribePlan();
  };
}

export function useNotificationApprovalBridge(): void {
  const settings = useAtomValue(notificationSettingsAtom);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!isMainNotificationWindow()) return;

    const wsClient = getCodeEditorWebSocket();
    if (!wsClient) return;

    return subscribeToApprovalNotifications({
      subscribe: (eventType, handler) =>
        wsClient.on(eventType, (message) => handler(message)),
      getSettings: () => settingsRef.current,
    });
  }, []);
}
