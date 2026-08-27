// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComposerInputRef,
  ComposerSnapshot,
} from "@src/components/ComposerInput";
import type { ChatImageAttachment } from "@src/store/ui/chatImageAtom";
import { wpReadOnlyAtom } from "@src/store/ui/chatPanelAtom";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import type { InputAreaRefs } from "../types";
import {
  type UseSubmitMessageOptions,
  useSubmitMessage,
} from "../useSubmitMessage";

const mocks = vi.hoisted(() => ({
  clearImageDraft: vi.fn(),
  guardAgainstSecrets: vi.fn(),
  interceptPendingQuestionBatches: vi.fn(),
  messageError: vi.fn(),
  messageInfo: vi.fn(),
  messageWarning: vi.fn(),
  parseCompactSlashCommand: vi.fn(),
  projectOutgoingUserMessage: vi.fn(),
  resolveMcpSlashCommand: vi.fn(),
  runManualCompact: vi.fn(),
  waitForPendingPills: vi.fn(),
}));

vi.mock("@src/components/Message", () => ({
  default: {
    error: mocks.messageError,
    info: mocks.messageInfo,
    warning: mocks.messageWarning,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock("@src/hooks/security/useSecretScanGuard", () => ({
  useSecretScanGuard: () => mocks.guardAgainstSecrets,
}));

vi.mock("@src/engines/SessionCore", async () => {
  const { atom } = await import("jotai/vanilla");
  return { chatEventsAtom: atom([]) };
});

vi.mock("@src/store/session", async () => {
  const { atom } = await import("jotai/vanilla");
  return { sessionByIdAtom: () => atom(null) };
});

vi.mock("@src/store/ui/chatPanelAtom", async () => {
  const { atom } = await import("jotai/vanilla");
  return { wpReadOnlyAtom: atom(false) };
});

vi.mock("@src/util/contextPillContent", () => ({
  waitForPendingPills: mocks.waitForPendingPills,
}));

vi.mock("@src/util/session/sessionDispatch", () => ({
  isCliSession: () => false,
}));

vi.mock("@src/engines/ChatPanel/InputArea/utils/imageDraftCache", () => ({
  clearImageDraft: mocks.clearImageDraft,
}));

vi.mock("@src/engines/ChatPanel/hooks/useManualCompact", async () => {
  const { atom } = await import("jotai/vanilla");
  return {
    manualCompactInFlightSessionAtom: atom<string | null>(null),
    parseCompactSlashCommand: mocks.parseCompactSlashCommand,
    useManualCompact: () => ({ runManualCompact: mocks.runManualCompact }),
  };
});

vi.mock("../mcpSlashCommand", () => ({
  resolveMcpSlashCommand: mocks.resolveMcpSlashCommand,
}));

vi.mock("../outgoingTextTransforms", () => ({
  expandSkillPills: (text: string) => ({
    expanded: text,
    hasSkillPills: false,
  }),
  stripContextPillBase64: (text: string) => text,
}));

vi.mock("../projectOutgoingUserMessage", () => ({
  projectOutgoingUserMessage: mocks.projectOutgoingUserMessage,
}));

vi.mock("../questionIntercept", () => ({
  interceptPendingQuestionBatches: mocks.interceptPendingQuestionBatches,
}));

interface EditorHarness {
  editor: ComposerInputRef;
  readText(): string;
}

function createEditor(initialText: string): EditorHarness {
  let text = initialText;
  const snapshot: ComposerSnapshot = {
    parts: [{ kind: "text", text: initialText }],
  };
  const editor = {
    getTextWithPills: vi.fn(() => text),
    getTerminalPillTexts: vi.fn(() => ({})),
    getSnapshot: vi.fn(() => snapshot),
    clear: vi.fn(() => {
      text = "";
    }),
    setContent: vi.fn((content: string | ComposerSnapshot) => {
      text =
        typeof content === "string"
          ? content
          : content.parts
              .map((part) => (part.kind === "text" ? part.text : ""))
              .join("");
    }),
  } as unknown as ComposerInputRef;
  return { editor, readText: () => text };
}

function createRefs(editor: ComposerInputRef): InputAreaRefs {
  return {
    composerInputRef: { current: editor },
    containerRef: { current: null },
    contextMenuKeyboardHandlerRef: { current: null },
    slashCommandKeyboardHandlerRef: { current: null },
    plusSlashCommandKeyboardHandlerRef: { current: null },
    hasContentRef: { current: true },
    setHasContent: vi.fn(),
  };
}

function image(id = "image-1"): ChatImageAttachment {
  return {
    id,
    dataUrl: `data:image/png;base64,${id}`,
    fileName: `${id}.png`,
    size: 10,
    width: 4,
    height: 4,
  };
}

let latestSubmit: ReturnType<typeof useSubmitMessage> | null = null;

function Harness({ options }: { options: UseSubmitMessageOptions }): null {
  const submit = useSubmitMessage(options);
  useEffect(() => {
    latestSubmit = submit;
  }, [submit]);
  return null;
}

describe("useSubmitMessage composer boundary", () => {
  let root: SmokeRoot;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    latestSubmit = null;
    root = createSmokeRoot();
    mocks.guardAgainstSecrets.mockResolvedValue(true);
    mocks.parseCompactSlashCommand.mockReturnValue(null);
    mocks.projectOutgoingUserMessage.mockImplementation(
      ({ displayText }: { displayText: string }) => ({
        agentContent: `agent:${displayText}`,
      })
    );
    mocks.resolveMcpSlashCommand.mockResolvedValue(null);
    mocks.waitForPendingPills.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await root.unmount();
  });

  async function mount(
    options: UseSubmitMessageOptions,
    initializeStore?: (nextStore: ReturnType<typeof createStore>) => void
  ): Promise<void> {
    store = createStore();
    initializeStore?.(store);
    await root.render(
      createElement(Provider, { store }, createElement(Harness, { options }))
    );
    expect(latestSubmit).not.toBeNull();
  }

  function optionsFor(
    editorHarness: EditorHarness,
    overrides: Partial<UseSubmitMessageOptions> = {}
  ): UseSubmitMessageOptions {
    return {
      refs: createRefs(editorHarness.editor),
      draftSessionId: "session-1",
      replyTargetEventId: "reply-event-1",
      flushDraft: vi.fn().mockResolvedValue(undefined),
      clearReplyTarget: vi.fn().mockResolvedValue(undefined),
      imageAttachment: {
        hasImages: false,
        images: [],
        clearImages: vi.fn(),
        restoreImages: vi.fn(),
      },
      citeCode: {
        isCiteCode: false,
        clearCiteCode: vi.fn(),
        captureCiteCode: vi.fn(),
        restoreCiteCode: vi.fn(),
      },
      handleSessChatSubmit: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("delegates one in-flight send to workspace chat and clears durable composer state", async () => {
    const editorHarness = createEditor("ship the fix");
    let resolveDispatch!: () => void;
    const pendingDispatch = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });
    const handleSessChatSubmit = vi.fn(() => pendingDispatch);
    const flushDraft = vi.fn().mockResolvedValue(undefined);
    const clearReplyTarget = vi.fn().mockResolvedValue(undefined);
    const options = optionsFor(editorHarness, {
      flushDraft,
      clearReplyTarget,
      handleSessChatSubmit,
    });
    await mount(options);

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = latestSubmit!();
      duplicate = latestSubmit!();
    });
    await vi.waitFor(() => expect(handleSessChatSubmit).toHaveBeenCalledOnce());
    resolveDispatch();
    await act(async () => {
      await Promise.all([first, duplicate]);
    });

    expect(mocks.guardAgainstSecrets).toHaveBeenCalledWith("ship the fix");
    expect(handleSessChatSubmit).toHaveBeenCalledWith(
      undefined,
      "ship the fix",
      "agent:ship the fix",
      undefined
    );
    expect(editorHarness.editor.clear).toHaveBeenCalledOnce();
    expect(editorHarness.readText()).toBe("");
    expect(options.refs.setHasContent).toHaveBeenCalledWith(false);
    expect(flushDraft).toHaveBeenCalledWith("");
    expect(clearReplyTarget).toHaveBeenCalledOnce();
  });

  it("allows a different captured message while the first dispatch is still in flight", async () => {
    const editorHarness = createEditor("");
    let resolveFirstDispatch!: () => void;
    const firstDispatch = new Promise<void>((resolve) => {
      resolveFirstDispatch = resolve;
    });
    const handleSessChatSubmit = vi
      .fn()
      .mockImplementationOnce(() => firstDispatch)
      .mockResolvedValueOnce(undefined);
    await mount(optionsFor(editorHarness, { handleSessChatSubmit }));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = latestSubmit!({ capturedText: "first message" });
      second = latestSubmit!({ capturedText: "second message" });
    });
    await vi.waitFor(
      () => expect(handleSessChatSubmit).toHaveBeenCalledTimes(2),
      { timeout: 5_000 }
    );
    resolveFirstDispatch();
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(handleSessChatSubmit.mock.calls).toEqual([
      [undefined, "first message", "agent:first message", undefined],
      [undefined, "second message", "agent:second message", undefined],
    ]);
  });

  it("keeps the composer intact and releases the intent after the secret scan blocks it", async () => {
    const editorHarness = createEditor("token-shaped text");
    const handleSessChatSubmit = vi.fn().mockResolvedValue(undefined);
    const flushDraft = vi.fn().mockResolvedValue(undefined);
    mocks.guardAgainstSecrets.mockResolvedValueOnce(false);
    await mount(
      optionsFor(editorHarness, { handleSessChatSubmit, flushDraft })
    );

    await act(async () => {
      await latestSubmit!();
    });

    expect(handleSessChatSubmit).not.toHaveBeenCalled();
    expect(editorHarness.editor.clear).not.toHaveBeenCalled();
    expect(editorHarness.readText()).toBe("token-shaped text");
    expect(flushDraft).not.toHaveBeenCalled();

    mocks.guardAgainstSecrets.mockResolvedValueOnce(true);
    await act(async () => {
      await latestSubmit!();
    });

    expect(handleSessChatSubmit).toHaveBeenCalledOnce();
    expect(editorHarness.readText()).toBe("");
  });

  it("lets a read-only imported replay delegate to its fork-before-send override", async () => {
    const editorHarness = createEditor("continue from this replay");
    const onSubmitOverride = vi.fn().mockResolvedValue(true);
    const handleSessChatSubmit = vi.fn().mockResolvedValue(undefined);
    const clearReplyTarget = vi.fn().mockResolvedValue(undefined);
    await mount(
      optionsFor(editorHarness, {
        onSubmitOverride,
        handleSessChatSubmit,
        clearReplyTarget,
      }),
      (nextStore) => nextStore.set(wpReadOnlyAtom, true)
    );

    await act(async () => {
      await latestSubmit!();
    });

    expect(mocks.messageWarning).not.toHaveBeenCalled();
    expect(onSubmitOverride).toHaveBeenCalledWith({
      displayText: "continue from this replay",
      agentContent: "agent:continue from this replay",
      imageDataUrls: undefined,
    });
    expect(handleSessChatSubmit).not.toHaveBeenCalled();
    expect(editorHarness.readText()).toBe("");
    expect(clearReplyTarget).toHaveBeenCalledOnce();
  });

  it("restores text, images, cite state, and the durable draft after dispatch failure", async () => {
    const editorHarness = createEditor("do not lose this");
    const attachment = image();
    const flushDraft = vi.fn().mockResolvedValue(undefined);
    const imageAttachment = {
      hasImages: true,
      images: [attachment],
      clearImages: vi.fn(),
      restoreImages: vi.fn(),
    };
    const citeSnapshot = {
      isCiteCode: true,
      selectedCiteRange: { start: 1, end: 3 },
      selectedCiteText: "const answer = 42",
      citeFileName: "answer.ts",
    };
    const citeCode = {
      isCiteCode: true,
      clearCiteCode: vi.fn(),
      captureCiteCode: vi.fn(() => citeSnapshot),
      restoreCiteCode: vi.fn(),
    };
    const options = optionsFor(editorHarness, {
      flushDraft,
      imageAttachment,
      citeCode,
      handleSessChatSubmit: vi
        .fn()
        .mockRejectedValue(new Error("transport unavailable")),
    });
    await mount(options);

    await act(async () => {
      await latestSubmit!();
      await Promise.resolve();
    });

    expect(editorHarness.editor.clear).toHaveBeenCalledOnce();
    expect(editorHarness.editor.setContent).toHaveBeenCalledOnce();
    expect(editorHarness.readText()).toBe("do not lose this");
    expect(options.refs.setHasContent).toHaveBeenLastCalledWith(true);
    expect(imageAttachment.clearImages).toHaveBeenCalledOnce();
    expect(imageAttachment.restoreImages).toHaveBeenCalledWith([attachment]);
    expect(citeCode.clearCiteCode).toHaveBeenCalledOnce();
    expect(citeCode.restoreCiteCode).toHaveBeenCalledWith(citeSnapshot);
    expect(flushDraft.mock.calls.map(([text]) => text)).toEqual([
      "",
      "do not lose this",
    ]);
    expect(mocks.messageError).toHaveBeenCalledWith(
      "chat.failedToSendMessage: transport unavailable"
    );
  });

  it("leaves the composer untouched while ordinary submission is disabled", async () => {
    const editorHarness = createEditor("queued while busy");
    const handleSessChatSubmit = vi.fn().mockResolvedValue(undefined);
    const options = optionsFor(editorHarness, {
      submitDisabled: true,
      handleSessChatSubmit,
    });
    await mount(options);

    await act(async () => {
      await latestSubmit!();
    });

    expect(handleSessChatSubmit).not.toHaveBeenCalled();
    expect(mocks.guardAgainstSecrets).not.toHaveBeenCalled();
    expect(editorHarness.editor.clear).not.toHaveBeenCalled();
    expect(editorHarness.readText()).toBe("queued while busy");
    expect(options.flushDraft).not.toHaveBeenCalled();
  });
});
