// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import NotificationsAdvancedBlocks from "../renderer/slots/NotificationsAdvancedBlocks";
import NotificationsMasterToggleRow from "../renderer/slots/NotificationsMasterToggleRow";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  setters: new Map<string, ReturnType<typeof vi.fn>>(),
  checkPermission: vi.fn(),
  requestPermission: vi.fn(),
  sendTest: vi.fn(),
  playSound: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/store/settings", () => ({
  useSetting: (key: string) => [
    mocks.values.get(key),
    mocks.setters.get(key) ?? vi.fn(),
  ],
}));

vi.mock("@src/store/ui/notificationAtom", () => ({
  notificationSettingsAtom: {},
}));

vi.mock("jotai", () => ({
  useAtomValue: () => ({
    enabled: true,
    systemNotificationEnabled: false,
    dockBadgeEnabled: false,
    soundEnabled: false,
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
  }),
}));

vi.mock("@src/api/services/notification", () => ({
  checkNotificationPermission: mocks.checkPermission,
  requestNotificationPermission: mocks.requestPermission,
  sendTestNotification: mocks.sendTest,
  playNotificationSound: mocks.playSound,
  setDockBadge: vi.fn(),
  unlockNotificationSound: vi.fn(),
}));

vi.mock("@/src/modules/shared/layouts/SectionLayout", () => ({
  SectionContainer: ({ children }: { children?: React.ReactNode }) =>
    createElement("section", null, children),
  SectionRow: ({
    children,
    label,
  }: {
    children?: React.ReactNode;
    label?: string;
  }) => createElement("div", { "data-label": label }, children),
}));

vi.mock("@src/components/Switch", () => ({
  default: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: () => void;
  }) =>
    createElement("button", {
      type: "button",
      disabled,
      "data-checked": String(Boolean(checked)),
      onClick: onCheckedChange,
    }),
}));

vi.mock("@src/components/Button", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    createElement("button", { type: "button" }, children),
}));

vi.mock("@src/components/Slider", () => ({
  default: () => createElement("div"),
}));

vi.mock("@src/components/Select", () => ({
  default: () => createElement("div"),
}));

vi.mock("@src/components/Message", () => ({
  default: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

vi.mock("@src/util/platform/tauri", () => ({
  isMacOS: () => false,
}));

describe("notification settings lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.values.clear();
    mocks.setters.clear();
    mocks.checkPermission.mockReset().mockResolvedValue("unknown");
    mocks.requestPermission.mockReset().mockResolvedValue("granted");
    mocks.sendTest.mockReset().mockResolvedValue(true);
    mocks.playSound.mockReset().mockResolvedValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("lets the master switch enable sound-only notifications without requesting OS permission", () => {
    const setEnabled = vi.fn();
    mocks.values.set("notifications.enabled", false);
    mocks.setters.set("notifications.enabled", setEnabled);

    act(() => root.render(createElement(NotificationsMasterToggleRow)));
    act(() => container.querySelector<HTMLButtonElement>("button")?.click());

    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });

  it("keeps categories visible with sound off and requests permission at the system toggle", async () => {
    const setSystemEnabled = vi.fn();
    const defaults: Record<string, unknown> = {
      "notifications.enabled": true,
      "notifications.completionSound": false,
      "notifications.soundPreset": "classic",
      "notifications.systemNotificationEnabled": false,
      "notifications.dockBadgeEnabled": false,
      "notifications.soundVolume": 70,
      "notifications.criticalOnly": false,
      "notifications.quietHours.enabled": false,
      "notifications.quietHours.start": "23:00",
      "notifications.quietHours.end": "08:00",
      "notifications.quietHours.allowCritical": true,
      "notifications.backgroundCompletionSummary": true,
      "notifications.mutedSessionIds": [],
      "notifications.categories.taskCompletion": true,
      "notifications.categories.agentApproval": true,
      "notifications.categories.errors": true,
      "notifications.categories.teamInbox": true,
    };
    for (const [key, value] of Object.entries(defaults)) {
      mocks.values.set(key, value);
      mocks.setters.set(key, vi.fn());
    }
    mocks.setters.set(
      "notifications.systemNotificationEnabled",
      setSystemEnabled
    );

    await act(async () => {
      root.render(createElement(NotificationsAdvancedBlocks));
    });

    expect(
      container.querySelector('[data-label="notifications.teamInbox"]')
    ).not.toBeNull();
    const systemRow = container.querySelector(
      '[data-label="notifications.enableSystem"]'
    );
    await act(async () => {
      systemRow?.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(mocks.requestPermission).toHaveBeenCalledTimes(1);
    expect(setSystemEnabled).toHaveBeenCalledWith(true);
  });
});
