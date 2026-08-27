// @vitest-environment jsdom
import { type ReactNode, act, createElement } from "react";
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
  publishedHeader: null as ReactNode,
  openCanvasShare: vi.fn(),
  revisionDraft: null as CanvasRevisionDraft | null,
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
      if (atom === "canvas-preview") return null;
      if (atom === "sidebar-collapsed") return false;
      if (atom === "sidebar-position") return "left";
      if (atom === "sidebar-width") return 240;
      return null;
    },
    useSetAtom: () => vi.fn(),
  };
});
vi.mock(
  "@src/engines/SessionCore/hooks/useCanvasRevisionDraftForSession",
  () => ({
    useCanvasRevisionDraftForSession: () => testState.revisionDraft,
  })
);
vi.mock(
  "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionProgress",
  () => ({ default: () => null })
);
vi.mock("@src/store/session/canvasPreviewAtom", () => ({
  canvasPreviewAtom: "canvas-preview",
}));
vi.mock("@src/store/ui/simulatorAtom", () => ({
  simulatorPrimarySidebarCollapsedAtom: "sidebar-collapsed",
  simulatorPrimarySidebarPositionAtom: "sidebar-position",
  simulatorPrimarySidebarWidthAtom: "sidebar-width",
  simulatorPrimarySidebarWidthPersistAtom: "sidebar-width-persist",
}));
vi.mock("../core/useSimulatorAppState", () => ({
  useSimulatorAppState: () => ({
    appEvents: testState.appEvents,
    currentEvent: null,
  }),
}));
vi.mock("./canvasConfig", () => ({ CANVAS_APP_CONFIG: {} }));
vi.mock("@src/hooks/tabHost/useWorkstationTabHeader", () => ({
  usePublishWorkstationTabHeader: ({ content }: { content: ReactNode }) => {
    testState.publishedHeader = content;
  },
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
      open: testState.openCanvasShare,
      close: vi.fn(),
      retry: vi.fn(),
      retryShortLink: vi.fn(),
      copy: vi.fn(),
    }),
  };
});
vi.mock("@src/components/WindowChrome", () => ({
  NoDragRegion: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@src/components/DiffStatsBadge", () => ({ default: () => null }));
vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    htmlType,
    icon: _icon,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    htmlType?: "button";
    icon?: ReactNode;
    variant?: string;
    size?: string;
  } & React.ComponentProps<"button">) =>
    createElement("button", { type: htmlType, ...props }, children),
}));
vi.mock("@src/components/IconButton", () => ({
  default: ({ children, ...props }: React.ComponentProps<"button">) =>
    createElement("button", props, children),
}));
vi.mock("@src/components/TabPill", () => ({
  default: () => createElement("div", { "data-testid": "canvas-tabs" }),
}));
vi.mock(
  "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasPreviewSurface",
  () => ({ default: () => createElement("div") })
);
vi.mock(
  "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/SessionReplayCodeMirrorViewer",
  () => ({ SessionReplayCodeMirrorViewer: () => createElement("div") })
);
vi.mock("@src/components/Placeholder", () => ({
  Placeholder: ({ title }: { title: string }) =>
    createElement("div", null, title),
}));
vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children?: ReactNode }) => children ?? null,
}));
vi.mock("@src/components/HeaderSectionSeparator", () => ({
  HeaderSectionSeparator: () =>
    createElement("span", { "data-testid": "toolbar-separator" }),
}));
vi.mock("@src/modules/WorkStation/shared", () => ({
  buildPrimarySidebarConfig: (config: unknown) => config,
  PrimarySidebarLayoutWithSections: () => null,
  SimulatorReplayChrome: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, testState.publishedHeader, children),
  WorkStationShell: ({ content }: { content: ReactNode }) =>
    createElement("main", null, content),
}));

function canvasEvent(
  args: Record<string, unknown>,
  id = "canvas-event"
): SessionEvent {
  return {
    id,
    sessionId: "session-a",
    functionName: "render_inline_canvas",
    displayStatus: "completed",
    args,
  } as unknown as SessionEvent;
}

describe("CanvasApp share action", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    testState.appEvents = [];
    testState.publishedHeader = null;
    testState.openCanvasShare.mockReset();
    testState.revisionDraft = null;
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

  function render(): void {
    act(() => {
      root.render(
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
      );
    });
  }

  function shareButton(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Share"
    );
  }

  it("shares only the selected completed Canvas from the visible toolbar", () => {
    testState.appEvents = [
      canvasEvent({ mode: "html", content: "<p>Ready</p>", title: "Ready" }),
    ];

    render();

    expect(shareButton()?.disabled).toBe(false);
    expect(
      container.querySelectorAll("[data-testid='toolbar-separator']")
    ).toHaveLength(1);
    act(() => shareButton()?.click());
    expect(testState.openCanvasShare).toHaveBeenCalledOnce();
    expect(testState.openCanvasShare).toHaveBeenCalledWith(
      {
        mode: "html",
        content: "<p>Ready</p>",
        title: "Ready",
        streaming: false,
      },
      "Ready"
    );
  });

  it("keeps Share visible but disabled for an in-progress Canvas", () => {
    testState.appEvents = [
      canvasEvent({
        mode: "html",
        content: "<p>Changing</p>",
        title: "Changing",
        streaming: true,
      }),
    ];

    render();

    expect(shareButton()).toBeDefined();
    expect(shareButton()?.disabled).toBe(true);
    act(() => shareButton()?.click());
    expect(testState.openCanvasShare).not.toHaveBeenCalled();
  });

  it("keeps Share disabled for a local URL Canvas", () => {
    testState.appEvents = [
      canvasEvent({ mode: "url", url: "file:///tmp/private.html" }),
    ];

    render();

    expect(shareButton()).toBeDefined();
    expect(shareButton()?.disabled).toBe(true);
  });

  it("disables Share while a revision draft is in flight for the selected Canvas", () => {
    testState.appEvents = [
      canvasEvent({ mode: "html", content: "<p>Ready</p>", title: "Ready" }),
    ];
    testState.revisionDraft = {
      sessionId: "session-a",
      toolCallId: "call-revision",
      targetEventId: "canvas-event",
      receivedCharacters: 42,
      phase: "receiving",
      startedAt: Date.now(),
    };

    render();

    expect(shareButton()).toBeDefined();
    expect(shareButton()?.disabled).toBe(true);
    act(() => shareButton()?.click());
    expect(testState.openCanvasShare).not.toHaveBeenCalled();

    // Draft cleared — the same Canvas becomes shareable again.
    testState.revisionDraft = null;
    render();
    expect(shareButton()?.disabled).toBe(false);
  });
});
