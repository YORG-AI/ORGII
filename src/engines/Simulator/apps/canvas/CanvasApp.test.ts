// @vitest-environment jsdom
import { Profiler, type ReactNode, act, createElement } from "react";
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

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { CanvasRevisionDraft } from "@src/store/session/canvasRevisionDraftAtom";

import CanvasApp from "./CanvasApp";

const testState = vi.hoisted(() => ({
  appEvents: [] as SessionEvent[],
  previewEventId: null as string | null,
  revisionDraft: null as CanvasRevisionDraft | null,
  publishedHeader: null as ReactNode,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));
// Partial mock: modules across the import graph create real atoms at module
// scope, so only the React read/write hooks are replaced.
vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtomValue: (atom: unknown) => {
      if (atom === "canvas-preview") {
        return testState.previewEventId
          ? { payload: { eventId: testState.previewEventId } }
          : null;
      }
      if (atom === "sidebar-collapsed") return false;
      if (atom === "sidebar-position") return "left";
      if (atom === "sidebar-width") return 240;
      return null;
    },
    useSetAtom: () => vi.fn(),
  };
});
vi.mock("@src/store/session/canvasPreviewAtom", () => ({
  canvasPreviewAtom: "canvas-preview",
}));
vi.mock("@src/engines/SessionCore", () => ({
  useCanvasRevisionDraftForSession: () => testState.revisionDraft,
}));
vi.mock("@src/features/CanvasShare", async () => {
  const { getCanvasShareAvailability } = await vi.importActual<
    typeof import("@src/features/CanvasShare/canvasShareProtocol")
  >("@src/features/CanvasShare/canvasShareProtocol");
  return {
    CanvasShareDialog: () => null,
    getCanvasShareAvailability,
    useCanvasShareDialog: () => ({
      state: { phase: "closed", operationId: 0 },
      open: vi.fn(),
      close: vi.fn(),
      retry: vi.fn(),
      retryShortLink: vi.fn(),
      copy: vi.fn(),
    }),
  };
});
vi.mock(
  "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionProgress",
  () => ({
    default: ({ draft }: { draft: CanvasRevisionDraft }) =>
      createElement("div", {
        "data-testid": "canvas-revision-progress",
        "data-phase": draft.phase,
      }),
  })
);
vi.mock("@src/store/ui/simulatorAtom", () => ({
  simulatorPrimarySidebarCollapsedAtom: "sidebar-collapsed",
  simulatorPrimarySidebarPositionAtom: "sidebar-position",
  simulatorPrimarySidebarWidthAtom: "sidebar-width",
  simulatorPrimarySidebarWidthPersistAtom: "sidebar-width-persist",
}));
vi.mock("../core/useSimulatorAppState", () => ({
  useSimulatorAppState: () => ({ appEvents: testState.appEvents }),
}));
vi.mock("./canvasConfig", () => ({ CANVAS_APP_CONFIG: {} }));
vi.mock("@src/hooks/tabHost/useWorkstationTabHeader", () => ({
  usePublishWorkstationTabHeader: ({ content }: { content: ReactNode }) => {
    testState.publishedHeader = content;
  },
}));
vi.mock("@src/components/WindowChrome", () => ({
  NoDragRegion: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@src/components/DiffStatsBadge", () => ({ default: () => null }));
vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    htmlType: type,
    ...props
  }: { htmlType?: "button" } & React.ComponentProps<"button">) =>
    createElement("button", { type, ...props }, children),
}));
vi.mock("@src/components/IconButton", () => ({
  default: ({ children, ...props }: React.ComponentProps<"button">) =>
    createElement("button", props, children),
}));
vi.mock("@src/components/TabPill", () => ({
  default: ({
    tabs,
    activeTab,
    onChange,
  }: {
    tabs: string[];
    activeTab: string;
    onChange: (tab: string) => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "canvas-tabs", "data-active-tab": activeTab },
      tabs.map((tab) =>
        createElement("button", {
          key: tab,
          "data-testid": `tab-${tab}`,
          onClick: () => onChange(tab),
        })
      )
    ),
}));
vi.mock("./design/CanvasDesignSurface", () => ({
  default: ({
    payload,
    reloadKey,
    designEnabled,
    sessionId,
  }: {
    payload: { content?: string };
    reloadKey: number;
    designEnabled: boolean;
    sessionId: string;
  }) =>
    createElement("div", {
      "data-testid": "canvas-preview-surface",
      "data-content": payload.content,
      "data-reload-key": reloadKey,
      "data-design-enabled": String(designEnabled),
      "data-session-id": sessionId,
    }),
}));
vi.mock(
  "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/SessionReplayCodeMirrorViewer",
  () => ({
    SessionReplayCodeMirrorViewer: ({ content }: { content: string }) =>
      createElement("div", {
        "data-testid": "canvas-source",
        "data-content": content,
      }),
  })
);
vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({ title }: { title: string }) =>
    createElement("div", { "data-testid": "placeholder" }, title),
}));
vi.mock("@src/modules/WorkStation/shared", () => ({
  buildPrimarySidebarConfig: (config: unknown) => config,
  PrimarySidebarLayoutWithSections: ({
    tabs,
  }: {
    tabs: Array<{ sections: Array<{ content: ReactNode }> }>;
  }) => tabs[0]?.sections[0]?.content ?? null,
  SimulatorReplayChrome: ({
    activeEventId,
    children,
  }: {
    activeEventId: string;
    children?: ReactNode;
  }) =>
    createElement(
      "div",
      { "data-testid": "simulator-chrome", "data-active-id": activeEventId },
      testState.publishedHeader,
      children
    ),
  WorkStationShell: ({
    primarySidebarConfig,
    content,
  }: {
    primarySidebarConfig: { content: ReactNode };
    content: ReactNode;
  }) =>
    createElement(
      "div",
      null,
      createElement("aside", null, primarySidebarConfig.content),
      createElement("main", null, content)
    ),
  WorkstationToolbarTooltip: ({ children }: { children?: ReactNode }) =>
    children ?? null,
  WorkstationHeaderSectionSeparator: () =>
    createElement("span", { "data-testid": "toolbar-separator" }),
}));

function canvasEvent(id: string): SessionEvent {
  return {
    id,
    sessionId: `session-${id}`,
    functionName: "render_inline_canvas",
    displayStatus: "completed",
    args: { mode: "html", content: `content-${id}`, title: id },
  } as unknown as SessionEvent;
}

function canvasRevision(id: string, revisesEventId: string): SessionEvent {
  const event = canvasEvent(id);
  event.sessionId = `session-${revisesEventId}`;
  event.functionName = "revise_inline_canvas";
  event.args.target_event_id = revisesEventId;
  return event;
}

describe("CanvasApp interaction lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let commitCount: number;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    testState.appEvents = [];
    testState.previewEventId = null;
    testState.revisionDraft = null;
    testState.publishedHeader = null;
    commitCount = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function render() {
    act(() => {
      root.render(
        createElement(
          Profiler,
          {
            id: "canvas-app",
            onRender: () => {
              commitCount += 1;
            },
          },
          createElement(CanvasApp, {
            state: {
              currentEventId: null,
              appEvents: [],
              selectedItemId: null,
              isReplaying: false,
            },
            currentEvent: null,
            selectedItemId: null,
            onSelectItem: vi.fn(),
          })
        )
      );
    });
  }

  function previewSurface() {
    return container.querySelector<HTMLElement>(
      "[data-testid='canvas-preview-surface']"
    );
  }

  function buttonWithText(text: string) {
    // Exact match: loose `includes` would let the toolbar "Share" button
    // shadow the sidebar item titled "a".
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === text
    );
  }

  it("commits a pending chat preview in the same render that hydrates it", () => {
    testState.previewEventId = "a";
    render();
    expect(
      container.querySelector("[data-testid='placeholder']")
    ).not.toBeNull();

    testState.appEvents = [canvasEvent("a"), canvasEvent("b")];
    commitCount = 0;
    render();

    expect(
      container.querySelector<HTMLElement>("[data-testid='simulator-chrome']")
        ?.dataset.activeId
    ).toBe("a");
    expect(previewSurface()?.dataset.content).toBe("content-a");
    expect(previewSurface()?.dataset.reloadKey).toBe("1");
    expect(commitCount).toBe(1);
  });

  it("handles selection and compare transitions without Effect commits", () => {
    testState.appEvents = [canvasEvent("a"), canvasEvent("b")];
    render();
    expect(previewSurface()?.dataset.content).toBe("content-b");
    expect(previewSurface()?.dataset.reloadKey).toBe("1");

    commitCount = 0;
    act(() => buttonWithText("a")?.click());
    expect(previewSurface()?.dataset.content).toBe("content-a");
    expect(previewSurface()?.dataset.reloadKey).toBe("2");
    expect(commitCount).toBe(1);

    const compareButtons = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => button.title === "Compare"
      );

    act(() => compareButtons()[0]?.click());
    commitCount = 0;
    act(() => compareButtons()[1]?.click());
    expect(
      container.querySelector<HTMLElement>("[data-testid='canvas-tabs']")
        ?.dataset.activeTab
    ).toBe("compare");
    expect(container.textContent).toContain("content-a");
    expect(container.textContent).toContain("content-b");
    expect(commitCount).toBe(1);

    commitCount = 0;
    act(() => compareButtons()[1]?.click());
    expect(
      container.querySelector<HTMLElement>("[data-testid='canvas-tabs']")
        ?.dataset.activeTab
    ).toBe("canvas");
    expect(previewSurface()?.dataset.content).toBe("content-a");
    expect(commitCount).toBe(1);
  });

  it("scopes Design mode to the selected Canvas event", () => {
    testState.appEvents = [canvasEvent("a")];
    render();

    expect(previewSurface()?.dataset.designEnabled).toBe("false");
    act(() => buttonWithText("Design")?.click());
    expect(previewSurface()?.dataset.designEnabled).toBe("true");

    testState.appEvents = [canvasEvent("a"), canvasEvent("b")];
    render();
    expect(previewSurface()?.dataset.content).toBe("content-b");
    expect(previewSurface()?.dataset.designEnabled).toBe("false");
    expect(previewSurface()?.dataset.sessionId).toBe("session-b");
  });

  it("keeps the last valid preview visible while a revision streams", () => {
    testState.appEvents = [canvasEvent("original")];
    testState.revisionDraft = {
      sessionId: "session-original",
      toolCallId: "revision-a",
      targetEventId: "original",
      receivedCharacters: 1_200,
      phase: "receiving",
      startedAt: 1,
    };

    render();

    expect(previewSurface()?.dataset.content).toBe("content-original");
    expect(
      container.querySelector("[data-testid='canvas-revision-progress']")
    ).not.toBeNull();
    expect(buttonWithText("Design")?.disabled).toBe(true);

    testState.revisionDraft = null;
    render();
    expect(
      container.querySelector("[data-testid='canvas-revision-progress']")
    ).toBeNull();
    expect(buttonWithText("Design")?.disabled).toBe(false);
  });

  it("shows a Design result as the latest version of the original Canvas", () => {
    testState.appEvents = [canvasEvent("original")];
    render();
    expect(container.querySelectorAll("aside button")).toHaveLength(2);
    expect(previewSurface()?.dataset.content).toBe("content-original");

    testState.previewEventId = "revision";
    testState.appEvents = [
      canvasEvent("original"),
      canvasRevision("revision", "original"),
    ];
    render();

    expect(container.querySelectorAll("aside button")).toHaveLength(2);
    expect(previewSurface()?.dataset.content).toBe("content-revision");
    expect(
      container.querySelector<HTMLElement>("[data-testid='simulator-chrome']")
        ?.dataset.activeId
    ).toBe("revision");
  });

  it("restores the last valid Canvas when the persisted revision failed", () => {
    const failedRevision = canvasRevision("failed-revision", "original");
    failedRevision.displayStatus = "failed";
    testState.previewEventId = "failed-revision";
    testState.appEvents = [canvasEvent("original"), failedRevision];

    render();

    expect(container.querySelectorAll("aside button")).toHaveLength(2);
    expect(previewSurface()?.dataset.content).toBe("content-original");
    expect(
      container.querySelector<HTMLElement>("[data-testid='simulator-chrome']")
        ?.dataset.activeId
    ).toBe("original");
  });
});
