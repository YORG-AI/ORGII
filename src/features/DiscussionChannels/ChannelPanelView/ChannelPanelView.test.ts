// @vitest-environment jsdom
//
// `InputArea` is a rich contenteditable composer (Lexical-style editor, slash
// menus, draft persistence) and is impractical to type into under jsdom, so it
// is stubbed here the same way `HumanSessionView.test.ts` stubs it. The stub
// records the props the surface passes, which keeps the real coverage: the
// post path is exercised by invoking the surface's own `onSubmitOverride`
// against the real jotai store, and the cloud gate is asserted through
// `submitDisabled` instead of through the absence of an input.
//
// The old "textarea value is cleared after a send" assertion is gone on
// purpose: clearing is now `useSubmitMessage`'s optimistic-clear, not this
// surface's business. What this surface owns — accept / refuse / report — is
// unit-tested in `channelPostHandler.test.ts`.
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
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

import type { ComposerInputRef } from "@src/components/ComposerInput";
import type { SubmitOverrideInput } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { Org2CloudChannelMessagesError } from "@src/features/Org2Cloud/channels/channelMessagesClient";
import type { CloudChannelMessage } from "@src/features/Org2Cloud/channels/channelMessagesTypes";
import type { CloudChannelMessagesState } from "@src/features/Org2Cloud/channels/useCloudChannelMessages";
import type { TabDragEventDetail } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";
import {
  SESSION_TAB_DRAG_END_EVENT,
  SESSION_TAB_DRAG_START_EVENT,
  type SessionTabDragEndDetail,
  type SessionTabDragStartDetail,
  type SessionTabTransfer,
} from "@src/shared/dnd/sessionTabDrag";
import type { ChatPanelSelectedChannel } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  LOCAL_CHANNEL_MESSAGES_STORAGE_KEY,
  type LocalChannelMessage,
  localChannelMessagesAtom,
} from "@src/store/ui/localChannelMessagesAtom";
import {
  LOCAL_CHANNELS_STORAGE_KEY,
  type LocalChannel,
  localChannelsAtom,
} from "@src/store/ui/localChannelsAtom";

import DiscussionChannelPanelView from "./index";

interface StubbedInputAreaProps {
  sessionId?: string;
  placeholder?: string;
  submitDisabled?: boolean;
  showAgentControls?: boolean;
  allowFileAttachments?: boolean;
  enableAgentInterceptors?: boolean;
  sessionScope?: string;
  acceptDraggedPills?: boolean;
  composerInputRef?: { current: ComposerInputRef | null };
  onSubmitOverride?: (input: SubmitOverrideInput) => Promise<boolean>;
}

const mocks = vi.hoisted(() => ({
  inputAreaProps: [] as StubbedInputAreaProps[],
  insertFilePill: vi.fn(),
  // The cloud message hook is network-backed; the surface's contract with it
  // is what this file covers, so the state it hands back is set per test.
  cloudMessages: {} as CloudChannelMessagesState,
  /** Set to archive the mocked cloud channel (partitioned, per useOrgChannels). */
  cloudChannelArchivedAt: null as string | null,
}));

vi.mock("@src/features/Org2Cloud/channels/useCloudChannelMessages", () => ({
  useCloudChannelMessages: () => mocks.cloudMessages,
  isOptimisticChannelMessageId: (id: string) => id.startsWith("pending:"),
}));

// The stub publishes the editor handle the same way the real `InputArea`
// does, so the surface's drop path can be driven end to end. It also carries
// `data-chat-drop-target`, the attribute `InputArea` puts on its own drop rect
// and the one the surface hit-tests to avoid double-inserting a pill.
vi.mock("@src/engines/ChatPanel/InputArea", () => ({
  default: (props: StubbedInputAreaProps) => {
    mocks.inputAreaProps.push(props);
    if (props.composerInputRef) {
      props.composerInputRef.current = {
        insertFilePill: mocks.insertFilePill,
      } as unknown as ComposerInputRef;
    }
    return createElement("div", {
      "data-testid": "channel-input-area",
      "data-chat-drop-target": "",
      "data-submit-disabled": String(props.submitDisabled ?? false),
      "data-session-id": props.sessionId ?? "",
      "data-placeholder": props.placeholder ?? "",
    });
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The real Markdown component is lazy-loaded behind Suspense; a plain
// passthrough keeps the body assertions synchronous.
vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) =>
    createElement("div", { "data-testid": "markdown" }, textContent),
}));

vi.mock("@src/features/Org2Cloud/channels/useOrgChannels", () => ({
  useOrgChannels: () => {
    const channel = {
      id: "cloud-chan-1",
      name: "release-notes",
      topic: "what shipped",
      visibility: "private",
      postPolicy: "everyone",
      createdBy: "user-self",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: undefined,
      archivedAt: mocks.cloudChannelArchivedAt,
      messageCount: 0,
      lastMessageAt: undefined,
      memberCount: 4,
      myRole: "manager",
    };
    const archived = mocks.cloudChannelArchivedAt !== null;
    return {
      phase: "ready",
      channels: archived ? [] : [channel],
      archivedChannels: archived ? [channel] : [],
      error: null,
      refreshing: false,
      refresh: vi.fn(),
      getFreshAccessToken: vi.fn(),
      currentUserId: "user-self",
    };
  },
}));

const NOW = "2026-07-31T00:00:00.000Z";

const CHANNEL: LocalChannel = {
  id: "chan-1",
  name: "code-review",
  topic: "PR triage",
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

const LOCAL_TARGET: ChatPanelSelectedChannel = {
  scope: "local",
  channelId: "chan-1",
  name: "code-review",
};

const CLOUD_TARGET: ChatPanelSelectedChannel = {
  scope: "cloud",
  orgId: "org-1",
  channelId: "cloud-chan-1",
  name: "release-notes",
  visibility: "private",
};

/** Backend without the message capability: the honest gate stays up. */
function gatedCloudMessages(): CloudChannelMessagesState {
  return {
    phase: "unsupported",
    messages: [],
    error: null,
    refreshing: false,
    loadingOlder: false,
    hasOlder: false,
    unreadCount: 0,
    loadOlder: vi.fn(),
    postMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    markRead: vi.fn(),
    currentUserId: "user-self",
  };
}

function makeCloudMessage(
  overrides: Partial<CloudChannelMessage> & { id: string }
): CloudChannelMessage {
  const createdAt = overrides.createdAt ?? NOW;
  return {
    channelId: "cloud-chan-1",
    authorUserId: "user-self",
    authorDisplayName: "Ada",
    authorAvatarUrl: undefined,
    body: "cloud body",
    createdAt,
    editedAt: null,
    deletedAt: null,
    stateChangedAt: createdAt,
    mentionedUserIds: [],
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<LocalChannelMessage> = {}
): LocalChannelMessage {
  return {
    id: "msg-1",
    channelId: "chan-1",
    body: "hotfix-branch is ready for review",
    createdAt: NOW,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("DiscussionChannelPanelView", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inputAreaProps.length = 0;
    mocks.cloudMessages = gatedCloudMessages();
    mocks.cloudChannelArchivedAt = null;
    localStorage.removeItem(LOCAL_CHANNELS_STORAGE_KEY);
    localStorage.removeItem(LOCAL_CHANNEL_MESSAGES_STORAGE_KEY);
    store = createStore();
    store.set(localChannelsAtom, [CHANNEL]);
    store.set(localChannelMessagesAtom, []);
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

  function render(channel: ChatPanelSelectedChannel = LOCAL_TARGET) {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(DiscussionChannelPanelView, { channel })
        )
      );
    });
  }

  function bodies(): string[] {
    return Array.from(
      container.querySelectorAll("[data-testid='markdown']")
    ).map((node) => node.textContent ?? "");
  }

  function composerElement(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      "[data-testid='channel-input-area']"
    );
  }

  function latestComposerProps(): StubbedInputAreaProps {
    const props = mocks.inputAreaProps.at(-1);
    if (!props) throw new Error("InputArea was never rendered");
    return props;
  }

  /**
   * Pins a rect on an element jsdom would otherwise report as 0×0, so the
   * drop hit-test has geometry to work with.
   */
  function stubRect(
    element: Element,
    box: { left: number; top: number; right: number; bottom: number }
  ): void {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: box.left,
      y: box.top,
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.right - box.left,
      height: box.bottom - box.top,
      toJSON: () => ({}),
    });
  }

  /** Surface spans 0–400; the composer's own drop rect sits at the bottom. */
  function stubDropGeometry(): void {
    const surface = container.querySelector(
      "[data-testid='channel-session-drop-surface']"
    );
    if (!surface) throw new Error("drop surface was never rendered");
    stubRect(surface, { left: 0, top: 0, right: 400, bottom: 400 });
    const composer = composerElement();
    if (composer) {
      stubRect(composer, { left: 0, top: 340, right: 400, bottom: 400 });
    }
  }

  const TRANSFER: SessionTabTransfer = {
    source: "chat-panel",
    sourceTabId: "tab-1",
    sessionId: "sess-42",
    title: "Fix the flaky test",
  };

  /** A native session TAB leaving a tab strip. */
  function dragSessionTab(clientX: number, clientY: number): void {
    act(() => {
      document.dispatchEvent(
        new CustomEvent<SessionTabDragStartDetail>(
          SESSION_TAB_DRAG_START_EVENT,
          { detail: { transfer: TRANSFER } }
        )
      );
    });
    act(() => {
      document.dispatchEvent(
        new CustomEvent<SessionTabDragEndDetail>(SESSION_TAB_DRAG_END_EVENT, {
          detail: { transfer: TRANSFER, clientX, clientY },
        })
      );
    });
  }

  /** A sidebar session ROW, which emits the generic reference-pill drag. */
  function dragSessionRow(pointerX: number, pointerY: number): void {
    const detail: TabDragEventDetail = {
      tabId: "row-1",
      name: TRANSFER.title,
      pill: {
        path: `session://${TRANSFER.sessionId}`,
        name: TRANSFER.title,
        iconType: "session",
      },
      pointerX,
      pointerY,
    };
    act(() => {
      document.dispatchEvent(
        new CustomEvent<TabDragEventDetail>("tab-drag-start", { detail })
      );
    });
    act(() => {
      document.dispatchEvent(
        new CustomEvent<TabDragEventDetail>("tab-drag-end", { detail })
      );
    });
  }

  /** Drives the surface exactly the way `useSubmitMessage` drives it. */
  async function submit(text: string): Promise<void> {
    const { onSubmitOverride } = latestComposerProps();
    if (!onSubmitOverride) throw new Error("no onSubmitOverride");
    await act(async () => {
      await onSubmitOverride({ displayText: text });
    });
  }

  it("renders the header with the channel name and topic", () => {
    render();
    const header = container.querySelector(
      "[data-testid='channel-panel-header']"
    );
    expect(header?.className).not.toContain("pl-1.5");
    expect(header?.firstElementChild?.className).toContain("pl-[15px]");
    expect(
      container.querySelector("[data-testid='channel-panel-title']")
        ?.textContent
    ).toBe("code-review");
    expect(
      container.querySelector("[data-testid='channel-panel-topic']")
        ?.textContent
    ).toBe("PR triage");
  });

  it("shows the empty placeholder when the channel has no messages", () => {
    render();
    expect(
      container.querySelectorAll("[data-testid='channel-message']")
    ).toHaveLength(0);
    expect(bodies()).toEqual([]);
  });

  it("renders already-posted messages with a date divider", () => {
    store.set(localChannelMessagesAtom, [
      makeMessage({ id: "a", body: "code-review queue is empty" }),
      makeMessage({
        id: "b",
        body: "cutting release-notes now",
        createdAt: "2026-07-31T06:00:00.000Z",
      }),
    ]);
    render();

    expect(bodies()).toEqual([
      "code-review queue is empty",
      "cutting release-notes now",
    ]);
    expect(
      container.querySelectorAll("[data-testid='channel-date-divider']").length
    ).toBeGreaterThan(0);
  });

  it("mounts the session composer, not a bespoke textarea", () => {
    render();

    const composer = composerElement();
    expect(composer).not.toBeNull();
    expect(composer?.getAttribute("data-submit-disabled")).toBe("false");
    expect(composer?.getAttribute("data-session-id")).toBe(
      "channel-local-chan-1"
    );
    expect(composer?.getAttribute("data-placeholder")).toBe(
      "cloud.channels.feed.composerPlaceholder"
    );
    expect(
      container.querySelector("[data-testid='channel-composer']")?.className
    ).toContain("pb-3");
    expect(
      container.querySelector("[data-testid='channel-composer-input']")
    ).toBeNull();
  });

  it("keeps the composer human-only — no agent controls, uploads, or interceptors", () => {
    render();

    expect(latestComposerProps()).toMatchObject({
      sessionScope: "none",
      showAgentControls: false,
      allowFileAttachments: false,
      enableAgentInterceptors: false,
    });
  });

  it("constrains the transcript to the shared detail-panel column", () => {
    store.set(localChannelMessagesAtom, [makeMessage()]);
    render();

    const scroller = container.querySelector(
      "[data-testid='channel-message-list']"
    );
    expect(scroller?.className).toContain("px-2");
    expect(scroller?.firstElementChild?.className).toContain("max-w-[800px]");
    expect(scroller?.firstElementChild?.className).toContain("mx-auto");
  });

  it("posts a new message through the composer and renders it", async () => {
    render();
    await submit("rebase onto hotfix-branch");

    expect(
      store.get(localChannelMessagesAtom).map((message) => message.body)
    ).toEqual(["rebase onto hotfix-branch"]);
    expect(bodies()).toEqual(["rebase onto hotfix-branch"]);
  });

  it("rejects a refused post so the composer restores the draft, and shows why", async () => {
    render();

    const { onSubmitOverride } = latestComposerProps();
    await act(async () => {
      // Throwing is `useSubmitMessage`'s restore signal — a resolved `false`
      // would instead fall through to the agent submit path.
      await expect(
        onSubmitOverride?.({ displayText: "x".repeat(4001) })
      ).rejects.toThrow("cloud.channels.feed.errorTooLong");
    });

    expect(store.get(localChannelMessagesAtom)).toEqual([]);
    expect(
      container.querySelector("[data-testid='channel-composer-error']")
        ?.textContent
    ).toBe("cloud.channels.feed.errorTooLong");
  });

  it("renders a deleted message as a tombstone, not as its old body", () => {
    store.set(localChannelMessagesAtom, [
      makeMessage({ id: "gone", body: "leaked", deletedAt: NOW }),
    ]);
    render();

    expect(
      container.querySelector("[data-testid='channel-message-tombstone']")
        ?.textContent
    ).toBe("cloud.channels.feed.deletedMessage");
    expect(bodies()).toEqual([]);
  });

  it("deletes a message in place through the row action", () => {
    store.set(localChannelMessagesAtom, [makeMessage()]);
    render();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='channel-message-delete']"
    );
    act(() => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(store.get(localChannelMessagesAtom)[0]).toMatchObject({
      body: "",
      deletedAt: expect.any(String),
    });
    expect(
      container.querySelector("[data-testid='channel-message-tombstone']")
    ).not.toBeNull();
  });

  it("reports a channel deleted out from under an open tab", () => {
    store.set(localChannelsAtom, []);
    render();

    expect(
      container.querySelector("[data-testid='channel-panel-header']")
    ).toBeNull();
    expect(container.textContent).toContain("cloud.channels.feed.missingTitle");
    expect(composerElement()).toBeNull();
  });

  it("gates the cloud composer as a disabled session composer, not a stand-in", () => {
    render(CLOUD_TARGET);

    const composer = composerElement();
    expect(composer).not.toBeNull();
    expect(composer?.getAttribute("data-submit-disabled")).toBe("true");
    expect(composer?.getAttribute("data-session-id")).toBe(
      "channel-cloud-org-1-cloud-chan-1"
    );
    expect(
      container.querySelector("[data-testid='channel-composer-disabled']")
        ?.textContent
    ).toBe("cloud.channels.feed.cloudComposerDisabled");
    expect(
      container.querySelector("[data-testid='channel-panel-member-count']")
        ?.textContent
    ).toContain("4");
  });

  it("never writes to the local store from the cloud surface", async () => {
    render(CLOUD_TARGET);
    await submit("this must not land anywhere");

    expect(store.get(localChannelMessagesAtom)).toEqual([]);
  });

  it("attaches a session dropped on the transcript to the draft as a pill", () => {
    render();
    stubDropGeometry();

    dragSessionTab(120, 120);

    expect(mocks.insertFilePill).toHaveBeenCalledWith(
      expect.stringMatching(/^session:\/\/sess-42\/\d+$/),
      false,
      "session",
      "Fix the flaky test"
    );
  });

  it("highlights the whole surface while an eligible session is dragged", () => {
    render();
    stubDropGeometry();

    act(() => {
      document.dispatchEvent(
        new CustomEvent<SessionTabDragStartDetail>(
          SESSION_TAB_DRAG_START_EVENT,
          { detail: { transfer: TRANSFER } }
        )
      );
    });

    const zone = container.querySelector(
      "[data-testid='channel-session-drop-zone']"
    );
    expect(zone).not.toBeNull();
    expect(zone?.textContent).toBe("cloud.channels.feed.dropSessionHint");
  });

  it("ignores a drop released outside the channel surface", () => {
    render();
    stubDropGeometry();

    dragSessionTab(900, 900);

    expect(mocks.insertFilePill).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='channel-session-drop-zone']")
    ).toBeNull();
  });

  it("declines a sidebar-row drop the composer already turned into a pill", () => {
    render();
    stubDropGeometry();

    // Inside the composer's own drop rect: `InputArea`'s `useTabDragEndToPill`
    // owns this one, so inserting here too would give the user two pills.
    dragSessionRow(200, 370);
    expect(mocks.insertFilePill).not.toHaveBeenCalled();

    // Same drag released over the transcript is ours.
    dragSessionRow(200, 120);
    expect(mocks.insertFilePill).toHaveBeenCalledTimes(1);
  });

  describe("cloud channel with the message capability", () => {
    /** Flips the mocked hook into its working state for this test. */
    function readyCloudMessages(
      messages: CloudChannelMessage[],
      overrides: Partial<CloudChannelMessagesState> = {}
    ): void {
      mocks.cloudMessages = {
        ...gatedCloudMessages(),
        phase: "ready",
        messages,
        ...overrides,
      };
    }

    it("uses the shared loading placeholder while messages load", () => {
      readyCloudMessages([], { phase: "loading" });
      render(CLOUD_TARGET);

      expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
      expect(container.textContent).not.toContain(
        "cloud.channels.feed.loadingMessages"
      );
    });

    it("enables the same session composer instead of the gate notice", () => {
      readyCloudMessages([]);
      render(CLOUD_TARGET);

      const composer = composerElement();
      expect(composer?.getAttribute("data-submit-disabled")).toBe("false");
      expect(latestComposerProps().acceptDraggedPills).toBe(true);
      expect(
        container.querySelector("[data-testid='channel-composer-disabled']")
      ).toBeNull();
      // A postable channel is a drop target again.
      expect(
        container.querySelector("[data-testid='channel-session-drop-surface']")
      ).not.toBeNull();
    });

    it("renders cloud rows through the shared transcript, per author", () => {
      readyCloudMessages([
        makeCloudMessage({ id: "c1", body: "mine", authorUserId: "user-self" }),
        makeCloudMessage({
          id: "c2",
          body: "theirs",
          authorUserId: "user-other",
          authorDisplayName: "Grace",
          createdAt: "2026-07-31T06:00:00.000Z",
        }),
      ]);
      render(CLOUD_TARGET);

      expect(bodies()).toEqual(["mine", "theirs"]);
      expect(
        Array.from(
          container.querySelectorAll("[data-testid='channel-message-author']")
        ).map((node) => node.textContent)
      ).toEqual(["cloud.channels.feed.you", "Grace"]);
      // Row actions belong to the author only.
      expect(
        container.querySelectorAll("[data-testid='channel-message-edit']")
      ).toHaveLength(1);
      expect(
        container.querySelectorAll("[data-testid='channel-message-delete']")
      ).toHaveLength(1);
    });

    it("posts through the hook and never touches the local store", async () => {
      const postMessage = vi.fn().mockResolvedValue(undefined);
      readyCloudMessages([], { postMessage });
      render(CLOUD_TARGET);
      await submit("  ship the release notes  ");

      expect(postMessage).toHaveBeenCalledWith("ship the release notes");
      expect(store.get(localChannelMessagesAtom)).toEqual([]);
    });

    it("surfaces a managers-only refusal inline and rethrows so the draft survives", async () => {
      const postMessage = vi
        .fn()
        .mockRejectedValue(
          new Org2CloudChannelMessagesError(
            "post refused (ORG2_CHANNEL_POST_FORBIDDEN)",
            403
          )
        );
      readyCloudMessages([], { postMessage });
      render(CLOUD_TARGET);

      const { onSubmitOverride } = latestComposerProps();
      await act(async () => {
        await expect(
          onSubmitOverride?.({ displayText: "hello" })
        ).rejects.toThrow("cloud.channels.feed.errorPostForbidden");
      });
      expect(
        container.querySelector("[data-testid='channel-composer-error']")
          ?.textContent
      ).toBe("cloud.channels.feed.errorPostForbidden");
    });

    it("surfaces an archived-channel refusal with its own copy", async () => {
      const postMessage = vi
        .fn()
        .mockRejectedValue(
          new Org2CloudChannelMessagesError(
            "channel archived (ORG2_CHANNEL_ARCHIVED)",
            409
          )
        );
      readyCloudMessages([], { postMessage });
      render(CLOUD_TARGET);

      const { onSubmitOverride } = latestComposerProps();
      await act(async () => {
        await expect(
          onSubmitOverride?.({ displayText: "hello" })
        ).rejects.toThrow("cloud.channels.feed.errorArchived");
      });
      expect(
        container.querySelector("[data-testid='channel-composer-error']")
          ?.textContent
      ).toBe("cloud.channels.feed.errorArchived");
    });

    it("deletes through the hook from the shared row action", () => {
      const deleteMessage = vi.fn().mockResolvedValue(undefined);
      readyCloudMessages([makeCloudMessage({ id: "c1", body: "oops" })], {
        deleteMessage,
      });
      render(CLOUD_TARGET);

      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            "[data-testid='channel-message-delete']"
          )
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(deleteMessage).toHaveBeenCalledWith("c1");
    });

    it("offers the older page only while one exists", () => {
      const loadOlder = vi.fn();
      readyCloudMessages([makeCloudMessage({ id: "c1" })], {
        hasOlder: true,
        loadOlder,
      });
      render(CLOUD_TARGET);

      const button = container.querySelector<HTMLButtonElement>(
        "[data-testid='channel-load-older']"
      );
      expect(button).not.toBeNull();
      act(() => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(loadOlder).toHaveBeenCalledTimes(1);

      readyCloudMessages([makeCloudMessage({ id: "c1" })]);
      render(CLOUD_TARGET);
      expect(
        container.querySelector("[data-testid='channel-load-older']")
      ).toBeNull();
    });

    it("keeps an archived cloud channel read-only like the local plane", () => {
      // The RPC refuses with ORG2_CHANNEL_ARCHIVED regardless, so the working
      // message plane must not re-enable the composer or the row actions.
      mocks.cloudChannelArchivedAt = NOW;
      readyCloudMessages([makeCloudMessage({ id: "c1", body: "history" })]);
      render(CLOUD_TARGET);

      expect(bodies()).toEqual(["history"]);
      expect(composerElement()?.getAttribute("data-submit-disabled")).toBe(
        "true"
      );
      expect(latestComposerProps().acceptDraggedPills).toBe(false);
      expect(
        container.querySelector("[data-testid='channel-composer-archived']")
          ?.textContent
      ).toBe("cloud.channels.feed.archivedComposerDisabled");
      // The capability gate never fires here — the channel is archived, not old.
      expect(
        container.querySelector("[data-testid='channel-composer-disabled']")
      ).toBeNull();
      expect(
        container.querySelector("[data-testid='channel-message-edit']")
      ).toBeNull();
      expect(
        container.querySelector("[data-testid='channel-message-delete']")
      ).toBeNull();
    });
  });

  it("refuses session drops on a cloud channel instead of half-accepting", () => {
    render(CLOUD_TARGET);
    expect(latestComposerProps().acceptDraggedPills).toBe(false);
    expect(
      container.querySelector("[data-testid='channel-session-drop-surface']")
    ).toBeNull();

    dragSessionTab(120, 120);
    dragSessionRow(120, 120);

    expect(mocks.insertFilePill).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='channel-session-drop-zone']")
    ).toBeNull();
  });
});
