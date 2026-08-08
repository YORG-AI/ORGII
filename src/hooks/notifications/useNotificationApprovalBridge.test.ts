import { describe, expect, it, vi } from "vitest";

import type { NotificationSettings } from "@src/types/ui/notification";

import {
  ApprovalNotificationDeduper,
  PERMISSION_APPROVAL_NOTIFICATION_BODY,
  PLAN_APPROVAL_NOTIFICATION_BODY,
  isApprovalNotificationOwner,
  parseApprovalNotificationMessage,
  subscribeToApprovalNotifications,
} from "./useNotificationApprovalBridge";

const SETTINGS: NotificationSettings = {
  enabled: true,
  systemNotificationEnabled: true,
  dockBadgeEnabled: false,
  soundEnabled: true,
  soundPreset: "classic",
  soundVolume: 70,
  criticalOnly: false,
  quietHours: {
    enabled: false,
    start: "23:00",
    end: "08:00",
    allowCritical: true,
  },
  backgroundCompletionSummary: true,
  mutedSessionIds: [],
  categories: {
    taskCompletion: true,
    agentApproval: true,
    errors: true,
    teamInbox: true,
  },
};

describe("approval notification bridge", () => {
  it("normalizes native envelopes and flat CLI events", () => {
    expect(
      parseApprovalNotificationMessage({
        type: "permission:request",
        payload: {
          sessionId: "native-session",
          requestId: "permission-1",
          toolName: "run_shell",
          toolArgs: { command: "private command" },
        },
      })
    ).toEqual({
      kind: "permission",
      sessionId: "native-session",
      requestId: "permission-1",
    });

    expect(
      parseApprovalNotificationMessage({
        type: "agent:plan_ready_for_approval",
        session_id: "cli-session",
        planRevisionId: "revision-1",
        planTitle: "Private release plan",
        planEventSource: "create_plan",
      })
    ).toEqual({
      kind: "plan",
      sessionId: "cli-session",
      requestId: "revision-1",
    });
  });

  it("filters rehydrated plans", () => {
    expect(
      parseApprovalNotificationMessage({
        type: "agent:plan_ready_for_approval",
        payload: {
          sessionId: "native-session",
          planRevisionId: "revision-1",
          planEventSource: "rehydrate",
        },
      })
    ).toBeNull();

    expect(
      parseApprovalNotificationMessage({
        type: "agent:plan_ready_for_approval",
        payload: {
          sessionId: "native-session",
          planPath: "/private/plan.md",
          planEventSource: "create_plan",
        },
      })
    ).toBeNull();
  });

  it("subscribes globally, uses private-safe copy, deduplicates, and cleans up", () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const subscribe = vi.fn(
      (eventType: string, handler: (message: unknown) => void) => {
        handlers.set(eventType, handler);
        return () => handlers.delete(eventType);
      }
    );
    const notify = vi.fn();
    const deduper = new ApprovalNotificationDeduper();

    const unsubscribe = subscribeToApprovalNotifications({
      subscribe,
      getSettings: () => SETTINGS,
      deduper,
      notify,
    });

    expect(subscribe.mock.calls.map(([eventType]) => eventType)).toEqual([
      "permission:request",
      "agent:plan_ready_for_approval",
    ]);

    const permission = {
      type: "permission:request",
      payload: {
        sessionId: "native-session",
        requestId: "permission-1",
        toolName: "secret_tool_name",
        toolArgs: { command: "secret command arguments" },
      },
    };
    handlers.get("permission:request")?.(permission);
    handlers.get("permission:request")?.(permission);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(
      PERMISSION_APPROVAL_NOTIFICATION_BODY,
      SETTINGS,
      { sessionId: "native-session" }
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain("secret");

    handlers.get("agent:plan_ready_for_approval")?.({
      type: "agent:plan_ready_for_approval",
      session_id: "cli-session",
      planRevisionId: "revision-1",
      planTitle: "Confidential acquisition plan",
      planEventSource: "create_plan",
    });
    handlers.get("agent:plan_ready_for_approval")?.({
      type: "agent:plan_ready_for_approval",
      payload: {
        sessionId: "native-session",
        planRevisionId: "revision-2",
        planTitle: "Old private plan",
        planEventSource: "rehydrate",
      },
    });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(
      PLAN_APPROVAL_NOTIFICATION_BODY,
      SETTINGS,
      { sessionId: "cli-session" }
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain("Confidential");

    unsubscribe();
    expect(handlers.size).toBe(0);

    const unsubscribeRemount = subscribeToApprovalNotifications({
      subscribe,
      getSettings: () => SETTINGS,
      deduper,
      notify,
    });
    handlers.get("permission:request")?.(permission);
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribeRemount();
  });

  it("limits notification ownership to the main Tauri window", () => {
    expect(isApprovalNotificationOwner(false)).toBe(true);
    expect(isApprovalNotificationOwner(true, "main")).toBe(true);
    expect(isApprovalNotificationOwner(true, "settings")).toBe(false);
    expect(isApprovalNotificationOwner(true)).toBe(false);
  });

  it("expires duplicate keys and remains bounded to 256 entries", () => {
    const deduper = new ApprovalNotificationDeduper();
    expect(deduper.shouldNotify("session:permission:1", 0)).toBe(true);
    expect(deduper.shouldNotify("session:permission:1", 1)).toBe(false);
    expect(
      deduper.shouldNotify("session:permission:1", 10 * 60 * 1000 + 1)
    ).toBe(true);

    for (let index = 0; index < 300; index += 1) {
      expect(deduper.shouldNotify(`key-${index}`, 20 * 60 * 1000)).toBe(true);
    }
    expect(deduper.shouldNotify("key-0", 20 * 60 * 1000 + 1)).toBe(true);
  });
});
