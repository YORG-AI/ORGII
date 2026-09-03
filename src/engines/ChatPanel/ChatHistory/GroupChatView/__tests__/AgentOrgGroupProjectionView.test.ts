// @vitest-environment jsdom
import React, { act } from "react";
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

import type {
  AgentOrgGroupConversationItem,
  AgentOrgGroupProjectionItem,
  AgentOrgRunMemberView,
} from "@src/api/tauri/agent";
import deSessions from "@src/i18n/locales/de/sessions.json";
import enSessions from "@src/i18n/locales/en/sessions.json";
import esSessions from "@src/i18n/locales/es/sessions.json";
import frSessions from "@src/i18n/locales/fr/sessions.json";
import jaSessions from "@src/i18n/locales/ja/sessions.json";
import koSessions from "@src/i18n/locales/ko/sessions.json";
import plSessions from "@src/i18n/locales/pl/sessions.json";
import ptSessions from "@src/i18n/locales/pt/sessions.json";
import ruSessions from "@src/i18n/locales/ru/sessions.json";
import trSessions from "@src/i18n/locales/tr/sessions.json";
import viSessions from "@src/i18n/locales/vi/sessions.json";
import zhHantSessions from "@src/i18n/locales/zh-Hant/sessions.json";
import zhSessions from "@src/i18n/locales/zh/sessions.json";

import AgentOrgGroupProjectionView from "../AgentOrgGroupProjectionView";

const sessionsLocales: Record<string, { groupChat: unknown }> = {
  de: deSessions,
  en: enSessions,
  es: esSessions,
  fr: frSessions,
  ja: jaSessions,
  ko: koSessions,
  pl: plSessions,
  pt: ptSessions,
  ru: ruSessions,
  tr: trSessions,
  vi: viSessions,
  "zh-Hant": zhHantSessions,
  zh: zhSessions,
};

function localeLeaves(
  value: unknown,
  prefix = "",
  leaves = new Map<string, string>()
): Map<string, string> {
  if (typeof value === "string") {
    leaves.set(prefix, value);
    return leaves;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return leaves;
  for (const [key, child] of Object.entries(value)) {
    localeLeaves(child, prefix ? `${prefix}.${key}` : key, leaves);
  }
  return leaves;
}

function interpolationNames(value: string): string[] {
  return Array.from(
    value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g),
    (match) => match[1]
  ).sort();
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, args?: { member?: string }) =>
      args?.member ? `${key}:${args.member}` : key,
    i18n: { resolvedLanguage: "en" },
  }),
}));

vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    icon,
    loading: _loading,
    appearance: _appearance,
    variant: _variant,
    size: _size,
    shape: _shape,
    htmlType,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: React.ReactNode;
    loading?: boolean;
    appearance?: string;
    variant?: string;
    size?: string;
    shape?: string;
    htmlType?: "button" | "submit" | "reset";
  }) =>
    React.createElement(
      "button",
      { type: htmlType ?? "button", ...props },
      icon,
      children
    ),
}));

vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) =>
    React.createElement("p", null, textContent),
}));

vi.mock("@src/util/data/formatters/date", () => ({
  formatSmartDateTime: () => "visible time",
  toIntlLocaleTag: () => "en-US",
}));

const members = [
  {
    memberId: "coordinator",
    name: "Coordinator",
    role: "Lead",
    isCoordinator: true,
    sessionRuntime: { sessionId: "root-session" },
  },
  {
    memberId: "reviewer",
    name: "Reviewer",
    role: "Review",
    isCoordinator: false,
    sessionRuntime: { sessionId: "reviewer-session" },
  },
] as AgentOrgRunMemberView[];

const items: AgentOrgGroupProjectionItem[] = [
  {
    id: "group:1:0",
    kind: "user_message",
    order: {
      createdAt: "2026-01-01T00:00:00Z",
      sourceRank: 20,
      stableSourceId: "00000000000000000001",
      itemOrdinal: 0,
    },
    turnIntentId: "turn-root",
    route: "coordinator",
    targetMemberId: "coordinator",
    targetName: "Coordinator",
    sourceRef: { kind: "event", id: "secret-event-id" },
    text: "root question",
    createdAt: "2026-01-01T00:00:00Z",
    state: "queued",
    canStop: true,
  },
  {
    id: "group:1:1",
    kind: "assistant_reply",
    order: {
      createdAt: "2026-01-01T00:00:01Z",
      sourceRank: 20,
      stableSourceId: "00000000000000000001",
      itemOrdinal: 1,
    },
    turnIntentId: "turn-root",
    route: "coordinator",
    targetMemberId: "coordinator",
    targetName: "Coordinator",
    responderMemberId: "coordinator",
    responderName: "Coordinator",
    sourceRef: { kind: "event", id: "secret-event-id" },
    replyToItemId: "group:1:0",
    text: "root answer",
    createdAt: "2026-01-01T00:00:01Z",
    state: "answered",
    canStop: false,
  },
  {
    id: "group:2:0",
    kind: "user_message",
    order: {
      createdAt: "2026-01-01T00:00:02Z",
      sourceRank: 20,
      stableSourceId: "00000000000000000002",
      itemOrdinal: 0,
    },
    turnIntentId: "turn-member",
    route: "member",
    targetMemberId: "reviewer",
    targetName: "Reviewer",
    sourceRef: { kind: "inbox", id: 99123 },
    text: "member question",
    createdAt: "2026-01-01T00:00:02Z",
    state: "failed",
    errorCode: "raw_provider_secret_failure",
    canStop: false,
    retryMode: "new_turn",
  },
  {
    id: "group:2:1",
    kind: "assistant_reply",
    order: {
      createdAt: "2026-01-01T00:00:03Z",
      sourceRank: 20,
      stableSourceId: "00000000000000000002",
      itemOrdinal: 1,
    },
    turnIntentId: "turn-member",
    route: "member",
    targetMemberId: "reviewer",
    targetName: "Reviewer",
    responderMemberId: "reviewer",
    responderName: "Actual Reviewer",
    sourceRef: { kind: "inbox", id: 99123 },
    replyToItemId: "group:2:0",
    text: "member answer",
    createdAt: "2026-01-01T00:00:03Z",
    state: "answered",
    canStop: false,
  },
  {
    id: "activity:task-completed",
    kind: "team_activity",
    order: {
      createdAt: "2026-01-01T00:00:03.500Z",
      sourceRank: 30,
      stableSourceId: "task-event-completed",
      itemOrdinal: 0,
    },
    activityKind: "task_completed",
    createdAt: "2026-01-01T00:00:03.500Z",
    memberId: "reviewer",
    memberName: "Reviewer",
    taskId: "task-1",
    taskSubject: "Review result",
  },
  {
    id: "group:3:0",
    kind: "diagnostic",
    order: {
      createdAt: "2026-01-01T00:00:04Z",
      sourceRank: 20,
      stableSourceId: "00000000000000000003",
      itemOrdinal: 0,
    },
    createdAt: "2026-01-01T00:00:04Z",
    errorCode: "source_unavailable",
  },
];

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe("AgentOrgGroupProjectionView", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onStop = vi.fn(async () => undefined);
  const onRetry = vi.fn(async () => undefined);
  const onExitGroup = vi.fn();
  const onMemberSelect = vi.fn();

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  const renderView = async (overrides?: {
    projectedItems?: AgentOrgGroupProjectionItem[];
    loading?: boolean;
    error?: string | null;
    runStatus?: "running" | "archived";
  }) => {
    await act(async () => {
      root.render(
        React.createElement(AgentOrgGroupProjectionView, {
          items: overrides?.projectedItems ?? items,
          members,
          runStatus: overrides?.runStatus ?? "running",
          loading: overrides?.loading ?? false,
          hasMore: false,
          error: overrides?.error ?? null,
          actionError: null,
          actionPendingTurns: new Set<string>(),
          overviewPanel: React.createElement("div", null, "overview"),
          bottomInset: 0,
          onExitGroup,
          onMemberSelect,
          onLoadOlder: vi.fn(async () => undefined),
          onRetryLoad: vi.fn(async () => undefined),
          onStop,
          onRetry,
        })
      );
    });
  };

  it("renders Coordinator and Member facts together without leaking internal ids or failures", async () => {
    await renderView();

    expect(container.textContent).toContain("root question");
    expect(container.textContent).toContain("root answer");
    expect(container.textContent).toContain("member question");
    expect(container.textContent).toContain("member answer");
    expect(
      container.querySelectorAll('[data-testid="agent-org-group-chat-message"]')
    ).toHaveLength(4);
    expect(
      container.querySelectorAll(
        '[data-testid="agent-org-group-projection-activity"]'
      )
    ).toHaveLength(1);
    expect(
      container.querySelectorAll(
        '[data-testid="agent-org-group-projection-diagnostic"]'
      )
    ).toHaveLength(1);
    expect(container.textContent).toContain(
      "groupChat.projection.activity.task_completed"
    );
    expect(
      container.querySelector(
        '[data-sender-name="groupChat.youLabel"][data-recipient-name="Coordinator"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-sender-name="Actual Reviewer"][data-recipient-name=""]'
      )
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "Actual Reviewer·groupChat.projection.state.answered"
    );
    for (const item of container.querySelectorAll(
      '[data-testid="agent-org-group-projection-item"]'
    )) {
      expect(item.tagName).toBe("DIV");
      expect(item.className).not.toMatch(
        /rounded-xl|border-primary|bg-primary/
      );
    }
    expect(container.textContent).toContain("groupChat.projection.unavailable");
    expect(container.textContent).not.toContain("secret-event-id");
    expect(container.textContent).not.toContain("99123");
    expect(container.textContent).not.toContain("raw_provider_secret_failure");
    expect(container.textContent).not.toContain(
      "raw sqlite corruption details"
    );
    expect(container.textContent).not.toContain("group_root");
    expect(container.textContent).not.toContain("group_mention");
  });

  it("keeps multi-target sends in one continuous sender run with independent bubbles", async () => {
    const multiTargetItems: AgentOrgGroupProjectionItem[] = [
      items[0],
      {
        ...(items[2] as AgentOrgGroupConversationItem),
        id: "group:2:0",
        turnIntentId: "turn-member",
        text: "second target question",
        createdAt: "2026-01-01T00:00:10Z",
      },
    ];
    await renderView({ projectedItems: multiTargetItems });

    expect(
      container.querySelectorAll('[data-testid="agent-org-group-chat-message"]')
    ).toHaveLength(2);
    expect(
      container.querySelectorAll('[title="groupChat.youLabel"]')
    ).toHaveLength(1);
    expect(container.textContent).toContain("@Coordinator");
    expect(container.textContent).toContain("@Reviewer");
  });

  it("binds Stop and Retry to the exact independent user bubbles", async () => {
    await renderView();
    const stop = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "groupChat.projection.stop"
    );
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "groupChat.projection.retryNewTurn"
    );

    await act(async () => stop?.click());
    await act(async () => retry?.click());

    expect(onStop).toHaveBeenCalledWith(items[0]);
    expect(onRetry).toHaveBeenCalledWith(items[2]);
  });

  it("exits Group before opening the Coordinator or a Member page", async () => {
    await renderView();
    const coordinator = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "groupChat.coordinatorLabel"
    );

    await act(async () => coordinator?.click());

    expect(onExitGroup).toHaveBeenCalledTimes(1);
    expect(onMemberSelect).toHaveBeenCalledWith(members[0]);
    expect(onExitGroup.mock.invocationCallOrder[0]).toBeLessThan(
      onMemberSelect.mock.invocationCallOrder[0]
    );
  });

  it("shows bounded loading, error, empty, and archived states", async () => {
    await renderView({ projectedItems: [], loading: true });
    expect(
      container.querySelector(
        '[data-testid="agent-org-group-projection-loading"]'
      )
    ).not.toBeNull();

    await renderView({ projectedItems: [], error: "private database error" });
    expect(container.textContent).toContain("groupChat.projection.loadError");
    expect(container.textContent).not.toContain("private database error");

    await renderView({ projectedItems: [] });
    expect(
      container.querySelector(
        '[data-testid="agent-org-group-projection-empty"]'
      )
    ).not.toBeNull();

    await renderView({ runStatus: "archived" });
    expect(container.textContent).toContain("groupChat.projection.archived");
    expect(container.textContent).not.toContain("groupChat.projection.stop");
    expect(container.textContent).not.toContain(
      "groupChat.projection.retryNewTurn"
    );
  });
});

describe("Agent Org Group locale parity", () => {
  it("keeps every Group projection-visible key and interpolation parameter aligned in all 13 locales", () => {
    const locales = Object.entries(sessionsLocales).map(([locale, module]) => ({
      locale,
      leaves: localeLeaves(module.groupChat),
    }));
    expect(locales).toHaveLength(13);
    const english = locales.find(({ locale }) => locale === "en");
    expect(english).toBeDefined();
    const expectedKeys = [
      "coordinatorLabel",
      "memberCount_one",
      "memberCount_other",
      "memberFallback",
      "mixedTargetError",
      "pausedBanner.body",
      "pausedBanner.resume",
      "pausedBanner.title",
      "projection.actionError",
      "projection.archived",
      "projection.empty",
      "projection.loadError",
      "projection.loadOlder",
      "projection.loading",
      "projection.queueGuidance",
      "projection.respondedAs",
      "projection.retryDelivery",
      "projection.retryNewTurn",
      "projection.sentTo",
      "projection.state.answered",
      "projection.state.cancelled",
      "projection.state.failed",
      "projection.state.queued",
      "projection.state.running",
      "projection.state.unknown",
      "projection.stop",
      "projection.title",
      "projection.unavailable",
      "retry",
      "retryPossibleDuplicateConfirm",
      "submitError",
      "triggerLabel",
      "userMessageOutcomeUnknown",
      "userMessagePending",
      "youLabel",
    ];

    for (const locale of locales) {
      for (const key of expectedKeys) {
        expect(locale.leaves.has(key), `${locale.locale}:${key}`).toBe(true);
        expect(
          interpolationNames(locale.leaves.get(key) ?? ""),
          `${locale.locale}:${key}`
        ).toEqual(interpolationNames(english?.leaves.get(key) ?? ""));
      }
    }
  });
});
