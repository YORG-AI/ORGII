// @vitest-environment jsdom
import React, { act, createElement, createRef } from "react";
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

import type ComposerBar from "@src/components/ComposerBar";

import { NormalComposerContent } from "./InputComposerBars";

const testState = vi.hoisted(() => ({
  composerBarProps: null as React.ComponentProps<typeof ComposerBar> | null,
  inputEditorProps: null as Record<string, unknown> | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/ComposerBar", async () => {
  const ReactModule = await import("react");
  return {
    default: (props: React.ComponentProps<typeof ComposerBar>) => {
      testState.composerBarProps = props;
      return ReactModule.createElement(
        "div",
        { "data-testid": "composer-bar" },
        props.leftPrefix,
        props.editorSlot,
        props.pills,
        props.submitButton
      );
    },
  };
});

vi.mock("@src/components/Voice", async () => {
  const ReactModule = await import("react");
  return {
    VoiceInputButton: (props: { appearance?: string }) =>
      ReactModule.createElement("span", {
        "data-testid": "voice-button",
        "data-appearance": props.appearance,
      }),
    VoiceRecordingBar: () =>
      ReactModule.createElement("span", {
        "data-testid": "voice-recording-bar",
      }),
  };
});

vi.mock("./InputEditor", async () => {
  const ReactModule = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      testState.inputEditorProps = props;
      return ReactModule.createElement(
        "span",
        { "data-testid": "input-editor" },
        props.leadingContent as React.ReactNode
      );
    },
  };
});

vi.mock("./InputActions", async () => {
  const ReactModule = await import("react");
  return {
    default: () =>
      ReactModule.createElement("span", { "data-testid": "input-actions" }),
  };
});

vi.mock("./PromptPolishButton", async () => {
  const ReactModule = await import("react");
  return {
    default: () =>
      ReactModule.createElement("span", { "data-testid": "prompt-polish" }),
  };
});

vi.mock("./CiteCodePreview", () => ({ default: () => null }));
vi.mock("./ImageAttachmentPreview", () => ({ default: () => null }));
vi.mock("./ReplyInfoDisplay", () => ({ default: () => null }));

describe("NormalComposerContent contextual presentations", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    testState.composerBarProps = null;
    testState.inputEditorProps = null;
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

  const renderComposer = (
    currentInputEmpty: boolean,
    overrides: Partial<React.ComponentProps<typeof NormalComposerContent>> = {}
  ) => {
    const props = {
      composerInputRef: createRef(),
      showContextMenu: false,
      contextMenuKeyboardHandlerRef: { current: null },
      showSlashMenu: false,
      slashCommandKeyboardHandlerRef: { current: null },
      showPlusSlashMenu: false,
      plusSlashCommandKeyboardHandlerRef: { current: null },
      onSlashCommand: vi.fn(),
      onSlashCommandClose: vi.fn(),
      onPlusSlashClose: vi.fn(),
      onContentChange: vi.fn(),
      onAtMention: vi.fn(),
      onAtMentionClose: vi.fn(),
      onSubmit: vi.fn(),
      onFocus: vi.fn(),
      onBlur: vi.fn(),
      onDragOver: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
      onAddContent: vi.fn(),
      onUpload: vi.fn(),
      onOpenSkillsTools: vi.fn(),
      isCiteCode: false,
      selectedCiteRange: null,
      citeFileName: "",
      onClearCiteCode: vi.fn(),
      replyInfo: { isReply: false },
      onClearReplyInfo: vi.fn(),
      modePill: null,
      modelPill: null,
      isHosted: false,
      canStopAgent: false,
      canResume: false,
      onInterrupt: vi.fn(async () => undefined),
      onResume: vi.fn(async () => undefined),
      isCursorIde: false,
      showVoiceUi: false,
      voice: {
        elapsedSeconds: 0,
        isRecording: false,
        liveTranscript: "",
        cancel: vi.fn(),
        stop: vi.fn(),
        start: vi.fn(),
        toggle: vi.fn(),
        isSupported: true,
      },
      isCompactRow: true,
      contextualCompact: true,
      inlineLeadingContent: createElement("span", null, "Stat"),
      suppressToolbarHover: false,
      currentInputEmpty,
      stopSuppressedForEmptyInput: false,
      isWpGeneWorking: false,
      isPendingCancel: false,
      isSessionTerminal: false,
      voiceFeatureEnabled: true,
      dropTargetId: "canvas-design",
      promptPolish: {
        status: "idle",
        isAvailable: false,
        isPolishing: false,
        isPolished: false,
        toggle: vi.fn(async () => undefined),
        reset: vi.fn(),
      },
      promptPolishDisabled: true,
      showAgentControls: true,
      showImageAttachments: false,
      ...overrides,
    } as React.ComponentProps<typeof NormalComposerContent>;

    act(() => root.render(createElement(NormalComposerContent, props)));
  };

  it("renders context, editor, and one solid voice action in the compact row", () => {
    renderComposer(true);

    expect(testState.composerBarProps).toMatchObject({
      inlineLayout: true,
      hideAddButton: true,
      showContextInfo: false,
    });
    expect(container.textContent).toContain("Stat");
    expect(
      container.querySelector("[data-testid='input-editor']")
    ).not.toBeNull();
    expect(
      container
        .querySelector("[data-testid='voice-button']")
        ?.getAttribute("data-appearance")
    ).toBe("solid");
    expect(container.querySelector("[data-testid='input-actions']")).toBeNull();
    expect(container.querySelector("[data-testid='prompt-polish']")).toBeNull();
  });

  it("replaces the idle microphone with the shared send action after typing", () => {
    renderComposer(false);

    expect(container.querySelector("[data-testid='voice-button']")).toBeNull();
    expect(
      container.querySelector("[data-testid='input-actions']")
    ).not.toBeNull();
  });

  it("uses the compact shared toolbar without hiding contextual controls", () => {
    renderComposer(true, {
      isCompactRow: true,
      contextualCompact: false,
      contextualPanel: true,
      inlineLeadingContent: createElement("span", null, "H1"),
      modePill: createElement("span", null, "Auto"),
      modelPill: createElement("span", null, "GPT 5.6 Sol · Extra High"),
    });

    expect(testState.composerBarProps).toMatchObject({
      inlineLayout: true,
      hideAddButton: false,
      showContextInfo: false,
    });
    expect(testState.inputEditorProps).toMatchObject({
      compact: true,
      leadingContent: expect.anything(),
    });
    expect(container.textContent).toContain("H1");
    expect(
      container.querySelector("[data-testid='input-editor']")?.textContent
    ).toBe("H1");
    expect(container.textContent).toContain("Auto");
    expect(container.textContent).toContain("GPT 5.6 Sol · Extra High");
    expect(
      container.querySelector("[data-testid='input-editor']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='voice-button']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='input-actions']")
    ).not.toBeNull();
    expect(container.querySelector("[data-testid='prompt-polish']")).toBeNull();
  });
});
