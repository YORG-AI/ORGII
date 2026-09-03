// @vitest-environment jsdom
import { Provider } from "jotai";
import { type ComponentProps, act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_CREATOR_LAUNCH_MODE } from "@src/features/SessionCreator/types";
import { CHAT_PANEL_CREATE_TARGET } from "@src/store/ui/chatPanelAtom";

import { StartPageAgentComposer } from "./StartPageAgentComposer";
import type { ChatPanelProps } from "./types";

const mocks = vi.hoisted(() => ({
  captureSlotProps: vi.fn(),
  mounts: vi.fn(),
  unmounts: vi.fn(),
}));

vi.mock("./StartPageWorkItemComposerChrome", () => ({
  default: () => null,
}));

const SessionCreatorSlot: NonNullable<ChatPanelProps["sessionCreatorSlot"]> = (
  props
) => {
  useEffect(() => {
    mocks.captureSlotProps(props);
  });
  useEffect(() => {
    mocks.mounts();
    return () => mocks.unmounts();
  }, []);
  return createElement(
    "div",
    { "data-testid": "session-creator-slot" },
    props.composerHeaderContent,
    props.pinnedActionsContent
  );
};

const baseProps = {
  creatorModeControl: createElement("div", null, "mode"),
  creatorVariant: "fullScreen" as const,
  defaultAiWorkItemExecutionTarget: null,
  handleAiWorkItemSessionStart: vi.fn(),
  handleOpenCliTerminal: vi.fn(),
  handleRegionNoticeChange: vi.fn(),
  handleStartPageSessionStart: vi.fn(),
  heroFooterSlot: createElement("div", null, "suggestions"),
  launchpadActionsVisible: true,
  onDraftChange: vi.fn(),
  resolveAiWorkItemContext: vi.fn(),
  SessionCreatorSlot,
} satisfies Omit<ComponentProps<typeof StartPageAgentComposer>, "createTarget">;

function latestSlotProps(): Record<string, unknown> {
  return mocks.captureSlotProps.mock.lastCall?.[0] as Record<string, unknown>;
}

describe("StartPageAgentComposer", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  async function render(
    createTarget: ComponentProps<typeof StartPageAgentComposer>["createTarget"]
  ) {
    await act(async () => {
      root.render(
        createElement(
          Provider,
          null,
          createElement(StartPageAgentComposer, {
            ...baseProps,
            createTarget,
          })
        )
      );
    });
  }

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("changes only composer chrome and launch semantics for Work Item", async () => {
    await render(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);

    expect(latestSlotProps().composerHeaderContent).toBeUndefined();
    expect(latestSlotProps().pinnedActionsContent).toBeUndefined();
    expect(latestSlotProps().heroFooterSlot).toBe(baseProps.heroFooterSlot);
    expect(latestSlotProps().onSessionStart).toBe(
      baseProps.handleStartPageSessionStart
    );
    expect(mocks.mounts).toHaveBeenCalledTimes(1);

    await render(CHAT_PANEL_CREATE_TARGET.WORK_ITEM);

    expect(latestSlotProps().composerHeaderContent).toBeDefined();
    expect(latestSlotProps().pinnedActionsContent).toBeDefined();
    expect(latestSlotProps().heroFooterSlot).toBeUndefined();
    expect(latestSlotProps().hideWorkItemAttachmentControl).toBe(true);
    expect(latestSlotProps().includeHumanSession).toBe(false);
    expect(latestSlotProps().launchMode).toBe(
      SESSION_CREATOR_LAUNCH_MODE.START_BACKGROUND
    );
    expect(latestSlotProps().launchpadIntent).toBe("plan");
    expect(latestSlotProps().onSessionStart).toBe(
      baseProps.handleAiWorkItemSessionStart
    );
    expect(latestSlotProps().resolveWorkItemContext).toBe(
      baseProps.resolveAiWorkItemContext
    );
    expect(mocks.mounts).toHaveBeenCalledTimes(1);
    expect(mocks.unmounts).not.toHaveBeenCalled();
  });
});
