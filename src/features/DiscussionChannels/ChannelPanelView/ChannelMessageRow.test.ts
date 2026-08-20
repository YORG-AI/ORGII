// @vitest-environment jsdom
//
// Covers the posted-reference half of "drop something into a channel": a
// session, work item or GitHub issue/PR named in a stored body is promoted
// out of the prose into its own card, other pill types stay inline on the
// read-only composer path, and a reference whose target is gone degrades
// instead of rendering a husk.
//
// `ComposerInput` is a contenteditable host with portal-mounted pills,
// impractical under jsdom, so it is stubbed the way `HumanSessionView.test.ts`
// stubs it. `useSessionTurnOverview` is stubbed because the real hook reads
// the on-disk turn index through the Tauri cache adapter; `projectApi` and the
// Tauri shell opener are stubbed for the same reason.
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

import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import type { Session } from "@src/store/session/sessionAtom/types";
import type { LocalChannelMessage } from "@src/store/ui/localChannelMessagesAtom";

import ChannelMessageRow from "./ChannelMessageRow";

interface StubbedComposerProps {
  initialContent?: string;
  editable?: boolean;
  minHeight?: number | string;
  overflowY?: string;
  className?: string;
}

const mocks = vi.hoisted(() => ({
  agentIconRender: vi.fn(),
  composerProps: [] as StubbedComposerProps[],
  openCloudSession: vi.fn(),
  openSession: vi.fn(),
  openWorkItem: vi.fn(),
  openExternalLink: vi.fn(async (_url: string) => undefined),
  readWorkItem: vi.fn(),
  readStandaloneWorkItem: vi.fn(),
  readProject: vi.fn(),
  turnCount: 7,
}));

vi.mock("@src/components/ComposerInput", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@src/components/ComposerInput")>();
  const React = await import("react");
  const MockComposerInput = React.forwardRef<
    { setContent: (content: unknown) => void },
    StubbedComposerProps
  >((props, ref) => {
    mocks.composerProps.push(props);
    React.useImperativeHandle(ref, () => ({ setContent: () => undefined }));
    return React.createElement(
      "div",
      { "data-testid": "stub-composer-input" },
      props.initialContent
    );
  });
  MockComposerInput.displayName = "MockComposerInput";
  return { ...actual, default: MockComposerInput };
});

// Provider SVGs resolve to URL strings outside the vite svgr pipeline.
vi.mock("@src/components/ModelIcon", () => ({
  default: () => createElement("span", { "data-testid": "model-icon" }),
}));

vi.mock("@src/config/agentIcons", () => ({
  resolveAgentIcon: () => () => {
    mocks.agentIconRender();
    return createElement("i", { "data-testid": "agent-icon" });
  },
}));

vi.mock("@src/features/Org2Cloud/useOpenCloudSessionReference", () => ({
  useOpenCloudSessionReference: () => mocks.openCloudSession,
}));

vi.mock("@src/components/SessionHoverCard/useSessionTurnOverview", () => ({
  useSessionTurnOverview: () => ({
    turnCount: mocks.turnCount,
    workedDurationMs: null,
  }),
}));

vi.mock(
  "@src/store/chatPanel/chatPanelTabOpenAtoms",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@src/store/chatPanel/chatPanelTabOpenAtoms")
      >();
    const { atom } = await import("jotai");
    return {
      ...actual,
      openOrFocusSessionInChatPanelTabAtom: atom(
        null,
        (_get, _set, options: unknown) => {
          mocks.openSession(options);
        }
      ),
    };
  }
);

// The adapters stay REAL so the card reads the same `WorkItem` shape the Work
// Item panel does; only the Tauri-backed reads are replaced.
vi.mock("@src/api/http/project", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/api/http/project")>();
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      readWorkItem: mocks.readWorkItem,
      readStandaloneWorkItem: mocks.readStandaloneWorkItem,
      readProject: mocks.readProject,
    },
  };
});

vi.mock("@src/util/platform/ipcRenderer", () => ({
  openExternalLink: mocks.openExternalLink,
}));

vi.mock("@src/store/chatPanel/chatPanelTabsAtom", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@src/store/chatPanel/chatPanelTabsAtom")
    >();
  const { atom } = await import("jotai");
  return {
    ...actual,
    openWorkItemInChatPanelTabAtom: atom(
      null,
      (_get, _set, options: unknown) => {
        mocks.openWorkItem(options);
      }
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "count" in options ? `${key}:${options.count}` : key,
  }),
}));

vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) =>
    createElement("div", { "data-testid": "markdown" }, textContent),
}));

const NOW = "2026-07-31T00:00:00.000Z";
const CLOUD_ENDPOINT = "https://cloud.example.com";
const CLOUD_IDENTITY_KEY = `${CLOUD_ENDPOINT}|viewer-1`;
const CLOUD_REFERENCE = buildCloudSessionReference({
  orgId: "org-1",
  ownerUserId: "owner-1",
  sourceSessionId: "remote-session-1",
});
const LEGACY_SOURCE_SESSION_ID =
  "codexapp-rollout-2026-08-03T21-36-58-019f0000-1111-7222-8333-444455556666";
const CODEX_CLOUD_REFERENCE = buildCloudSessionReference({
  orgId: "org-1",
  ownerUserId: "owner-1",
  sourceSessionId: LEGACY_SOURCE_SESSION_ID,
});

const SESSION: Session = {
  session_id: "sess-1",
  status: "completed",
  created_at: NOW,
  updated_at: NOW,
  name: "Triage the flaky test",
  model: "claude-sonnet-4-5",
  repo_name: "ORGII",
} as Session;

const REMOTE_SESSION: RemoteTeammateSessionMetadata = {
  id: "org-1:owner-1:remote-session-1",
  orgId: "org-1",
  ownerMemberId: "member-1",
  ownerUserId: "owner-1",
  ownerDisplayName: "Vince",
  ownerIdentityKind: "human",
  sourceSessionId: "remote-session-1",
  title: "Evaluate OrgTrack refactor",
  status: "completed",
  model: "claude-sonnet-4-5",
  accessMode: "full_replay",
  replayLevel: "replay",
  eventsEpoch: 1,
  eventsFrozenSeq: 5,
  eventsCount: 5,
  eventsTailHash: "tail",
};

const LEGACY_REMOTE_SESSION: RemoteTeammateSessionMetadata = {
  ...REMOTE_SESSION,
  id: `org-1:owner-1:${LEGACY_SOURCE_SESSION_ID}`,
  sourceSessionId: LEGACY_SOURCE_SESSION_ID,
  title: "Codex app rollout",
};

/**
 * The work-item resolver caches per `<projectSlug>/<shortId>` for the life of
 * the module, so every case here uses its OWN slug rather than resetting a
 * private cache from the test.
 */
function workItemPill(slug: string, shortId: string, label = shortId): string {
  return `${label} [workitem:workitem://${slug}/${shortId}/1700000000000]`;
}

function workItemData(shortId: string, title: string, overrides = {}) {
  return {
    frontmatter: {
      id: `id-${shortId}`,
      short_id: shortId,
      title,
      status: "in_progress",
      priority: "high",
      starred: false,
      labels: [],
      todos: [],
      comments: [],
      history: [],
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    },
    body: "",
    filename: `${shortId}.md`,
  };
}

function projectData(slug: string, name: string) {
  return {
    slug,
    description: "",
    meta: {
      id: `project-${slug}`,
      name,
      org_id: "org-1",
      status: "in_progress",
      priority: "high",
      health: "on_track",
      members: [],
      labels: [],
      linked_repos: [],
      created_at: NOW,
      updated_at: NOW,
    },
  };
}

function makeMessage(body: string): LocalChannelMessage {
  return {
    id: "msg-1",
    channelId: "chan-1",
    body,
    createdAt: NOW,
    editedAt: null,
    deletedAt: null,
  };
}

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ChannelMessageRow references", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.composerProps.length = 0;
    mocks.turnCount = 7;
    mocks.readWorkItem.mockRejectedValue(new Error("no such work item"));
    mocks.readStandaloneWorkItem.mockRejectedValue(
      new Error("no such work item")
    );
    mocks.readProject.mockRejectedValue(new Error("no such project"));
    store = createStore();
    store.set(org2CloudAuthAtom, {
      kind: "org2_cloud",
      supabaseUrl: CLOUD_ENDPOINT,
      supabaseAnonKey: "anon",
      userId: "viewer-1",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 4_102_444_800,
    });
    store.set(sessionsAtom, [SESSION]);
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

  function render(
    body: string,
    options: {
      grouped?: boolean;
      cloudOrgId?: string;
      onEdit?: ((messageId: string, body: string) => boolean) | null;
      onDelete?: ((messageId: string) => void) | null;
    } = {}
  ) {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(ChannelMessageRow, {
            message: makeMessage(body),
            grouped: options.grouped ?? false,
            authorLabel: "You",
            cloudOrgId: options.cloudOrgId,
            onEdit: options.onEdit ?? null,
            onDelete: options.onDelete ?? null,
          })
        )
      );
    });
  }

  /** Renders, then flushes the work-item resolver's microtask chain. */
  async function renderResolved(body: string) {
    render(body);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function card(): HTMLElement | null {
    return cardsOf("channel-session-card")[0] ?? null;
  }

  function cardsOf(testId: string): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(`[data-testid='${testId}']`)
    );
  }

  it("keeps a plain body on the markdown path", () => {
    render("rebasing onto hotfix-branch");

    expect(
      container.querySelector("[data-testid='markdown']")?.textContent
    ).toBe("rebasing onto hotfix-branch");
    expect(card()).toBeNull();
  });

  it("makes channel message text selectable like session transcript items", () => {
    render("copy this channel message");

    expect(
      container.querySelector("[data-testid='channel-message']")?.className
    ).toContain("allow-select-deep");
  });

  it("keeps edit and delete actions available on a grouped message", () => {
    const onEdit = vi.fn(() => true);
    const onDelete = vi.fn();

    render("second message in the group", {
      grouped: true,
      onEdit,
      onDelete,
    });

    expect(
      container.querySelector("[data-testid='channel-message-edit']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='channel-message-delete']")
    ).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLElement>("[data-testid='channel-message-delete']")
        ?.click();
    });
    expect(onDelete).toHaveBeenCalledWith("msg-1");
  });

  it("hides mutation actions when the message plane is read-only", () => {
    render("archived message", { grouped: true });

    expect(
      container.querySelector("[data-testid='channel-message-edit']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='channel-message-delete']")
    ).toBeNull();
  });

  it("promotes a session reference into a card with its round count", () => {
    render("look at Triage-the-flaky-test [session:sess-1] before we cut");

    const rendered = card();
    expect(rendered).not.toBeNull();
    expect(rendered?.getAttribute("data-session-missing")).toBeNull();
    // The card shows the LIVE session name, not the stored snapshot.
    expect(rendered?.textContent).toContain("Triage the flaky test");
    expect(rendered?.textContent).toContain(
      "sessions:history.detail.roundCount:7"
    );

    // The reference is gone from the prose, which stays on markdown.
    const prose = container.querySelector(
      "[data-testid='markdown']"
    )?.textContent;
    expect(prose).toBe("look at before we cut");
    expect(prose).not.toContain("[session:");
  });

  it("keeps a sidebar-only session reference available from its snapshot", () => {
    store.set(sessionsAtom, []);
    render("Triage-the-flaky-test [session:sess-1]");

    const rendered = card();
    expect(rendered?.getAttribute("data-session-missing")).toBeNull();
    expect(rendered?.getAttribute("data-session-snapshot")).toBe("true");
    expect(rendered?.textContent).toContain("Triage-the-flaky-test");

    act(() => {
      rendered?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.openSession).toHaveBeenCalledWith({
      sessionId: "sess-1",
      sessionName: "Triage-the-flaky-test",
      repoPath: undefined,
    });
  });

  it("opens the referenced session when the card is clicked", () => {
    render("Triage-the-flaky-test [session:sess-1]");

    act(() => {
      card()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        sessionName: "Triage the flaky test",
      })
    );
  });

  it("renders a cached cloud session as an available card", () => {
    store.set(org2CloudRemoteSessionsAtom, {
      "org-1": {
        identityKey: CLOUD_IDENTITY_KEY,
        rows: [REMOTE_SESSION],
        state: "ready",
        fetchedAt: Date.parse(NOW),
      },
    });
    render(`review ${CLOUD_REFERENCE}`);

    const rendered = card();
    expect(rendered?.getAttribute("data-cloud-session")).toBe("true");
    expect(rendered?.getAttribute("data-session-missing")).toBeNull();
    expect(rendered?.textContent).toContain("Evaluate OrgTrack refactor");
    expect(rendered?.textContent).toContain("Vince");

    act(() => {
      rendered?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.openCloudSession).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        ownerUserId: "owner-1",
        sourceSessionId: "remote-session-1",
      }),
      { autoReplay: true }
    );
  });

  it("does not rerender a cloud card when an unrelated roster row changes", () => {
    const entry = {
      identityKey: CLOUD_IDENTITY_KEY,
      rows: [REMOTE_SESSION],
      state: "ready" as const,
      fetchedAt: Date.parse(NOW),
    };
    store.set(org2CloudRemoteSessionsAtom, { "org-1": entry });
    render(CLOUD_REFERENCE);
    expect(mocks.agentIconRender).toHaveBeenCalledTimes(1);

    act(() => {
      store.set(org2CloudRemoteSessionsAtom, {
        "org-1": {
          ...entry,
          rows: [
            REMOTE_SESSION,
            {
              ...REMOTE_SESSION,
              id: "org-1:owner-2:other-session",
              ownerMemberId: "member-2",
              ownerUserId: "owner-2",
              sourceSessionId: "other-session",
              title: "Unrelated session",
            },
          ],
        },
      });
    });

    expect(mocks.agentIconRender).toHaveBeenCalledTimes(1);
  });

  it("does not show a stale roster title after an account switch", () => {
    store.set(org2CloudRemoteSessionsAtom, {
      "org-1": {
        identityKey: CLOUD_IDENTITY_KEY,
        rows: [REMOTE_SESSION],
        state: "ready",
        fetchedAt: Date.parse(NOW),
      },
    });
    render(CLOUD_REFERENCE);
    expect(card()?.textContent).toContain("Evaluate OrgTrack refactor");

    act(() => {
      store.set(org2CloudAuthAtom, {
        kind: "org2_cloud",
        supabaseUrl: CLOUD_ENDPOINT,
        supabaseAnonKey: "anon",
        userId: "viewer-2",
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 4_102_444_800,
      });
    });

    expect(card()?.textContent).not.toContain("Evaluate OrgTrack refactor");
    expect(card()?.textContent).toContain(
      "cloud.sessionRef.chipLabel ession-1"
    );
  });

  it("keeps an uncached cloud session openable instead of marking it missing", () => {
    render(CLOUD_REFERENCE);

    const rendered = card();
    expect(rendered?.getAttribute("data-cloud-session")).toBe("true");
    expect(rendered?.getAttribute("data-session-missing")).toBeNull();
    expect(rendered?.textContent).toContain(
      "cloud.sessionRef.chipLabel ession-1"
    );
  });

  it("opens an uncached shared Codex reference through cloud replay", () => {
    store.set(sessionsAtom, []);
    render(CODEX_CLOUD_REFERENCE, { cloudOrgId: "org-1" });

    const rendered = card();
    expect(rendered?.getAttribute("data-cloud-session")).toBe("true");
    expect(rendered?.getAttribute("data-session-snapshot")).toBeNull();

    act(() => {
      rendered?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.openCloudSession).toHaveBeenCalledWith(
      {
        version: 1,
        orgId: "org-1",
        ownerUserId: "owner-1",
        sourceSessionId: LEGACY_SOURCE_SESSION_ID,
      },
      { autoReplay: true }
    );
    expect(mocks.openSession).not.toHaveBeenCalled();
  });

  it("renders the posted title for legacy cloud session pills", () => {
    render(`Evaluate-OrgTrack [session:${CLOUD_REFERENCE}]`);

    const rendered = card();
    expect(rendered?.getAttribute("data-cloud-session")).toBe("true");
    expect(rendered?.getAttribute("data-session-missing")).toBeNull();
    expect(rendered?.textContent).toContain("Evaluate-OrgTrack");
  });

  it("recovers a legacy source-only pill through its unique cloud org row", () => {
    store.set(org2CloudRemoteSessionsAtom, {
      "org-1": {
        identityKey: CLOUD_IDENTITY_KEY,
        rows: [LEGACY_REMOTE_SESSION],
        state: "ready",
        fetchedAt: Date.parse(NOW),
      },
    });
    render(`Codex-app-rollout [session:${LEGACY_SOURCE_SESSION_ID}]`, {
      cloudOrgId: "org-1",
    });

    const rendered = card();
    expect(rendered?.getAttribute("data-cloud-session")).toBe("true");
    expect(rendered?.textContent).toContain("Codex app rollout");

    act(() => {
      rendered?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.openCloudSession).toHaveBeenCalledWith(
      {
        version: 1,
        orgId: "org-1",
        ownerUserId: "owner-1",
        sourceSessionId: LEGACY_SOURCE_SESSION_ID,
      },
      { autoReplay: true }
    );
    expect(mocks.openSession).not.toHaveBeenCalled();
  });

  it("does not guess an owner for an ambiguous legacy cloud source id", () => {
    store.set(org2CloudRemoteSessionsAtom, {
      "org-1": {
        identityKey: CLOUD_IDENTITY_KEY,
        rows: [
          LEGACY_REMOTE_SESSION,
          {
            ...LEGACY_REMOTE_SESSION,
            id: `org-1:owner-2:${LEGACY_SOURCE_SESSION_ID}`,
            ownerMemberId: "member-2",
            ownerUserId: "owner-2",
            ownerDisplayName: "Alex",
          },
        ],
        state: "ready",
        fetchedAt: Date.parse(NOW),
      },
    });
    render(`Codex-app-rollout [session:${LEGACY_SOURCE_SESSION_ID}]`, {
      cloudOrgId: "org-1",
    });

    const rendered = card();
    expect(rendered?.getAttribute("data-cloud-session")).toBeNull();
    expect(rendered?.getAttribute("data-session-snapshot")).toBe("true");

    act(() => {
      rendered?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.openCloudSession).not.toHaveBeenCalled();
    expect(mocks.openSession).toHaveBeenCalledWith({
      sessionId: LEGACY_SOURCE_SESSION_ID,
      sessionName: "Codex-app-rollout",
      repoPath: undefined,
    });
  });

  it("keeps a legacy source-only pill local outside a cloud channel", () => {
    store.set(org2CloudRemoteSessionsAtom, {
      "org-1": {
        identityKey: CLOUD_IDENTITY_KEY,
        rows: [LEGACY_REMOTE_SESSION],
        state: "ready",
        fetchedAt: Date.parse(NOW),
      },
    });
    render(`Codex-app-rollout [session:${LEGACY_SOURCE_SESSION_ID}]`);

    expect(card()?.getAttribute("data-cloud-session")).toBeNull();
    expect(card()?.getAttribute("data-session-snapshot")).toBe("true");
  });

  it("leaves other pill types inline on the read-only composer path", () => {
    render("config.ts [file:/repo/config.ts] and Triage [session:sess-1]");

    expect(
      container.querySelector("[data-testid='channel-message-pill-body']")
    ).not.toBeNull();
    expect(container.querySelector("[data-testid='markdown']")).toBeNull();
    expect(mocks.composerProps.at(-1)).toMatchObject({
      editable: false,
      minHeight: 0,
      overflowY: "visible",
      className: "text-sm leading-6 text-text-1",
    });
    expect(mocks.composerProps.at(-1)?.initialContent).toBe(
      "config.ts [file:/repo/config.ts] and"
    );
    expect(card()).not.toBeNull();
  });

  describe("work item references", () => {
    it("renders the resolved id, title, status and priority", async () => {
      mocks.readWorkItem.mockResolvedValue(
        workItemData("AUTH-12", "Rotate the signing key")
      );
      mocks.readProject.mockResolvedValue(projectData("auth", "Auth System"));

      await renderResolved(workItemPill("auth", "AUTH-12"));

      const [rendered] = cardsOf("channel-work-item-card");
      expect(rendered).toBeDefined();
      expect(rendered.getAttribute("data-work-item-missing")).toBeNull();
      expect(
        rendered.querySelector("[data-testid='channel-work-item-card-id']")
          ?.textContent
      ).toBe("AUTH-12");
      expect(rendered.textContent).toContain("Rotate the signing key");
      expect(rendered.textContent).toContain(
        "projects:workItems.statusLabels.in_progress"
      );
      expect(rendered.textContent).toContain(
        "projects:workItems.priorityLabels.high"
      );
      expect(rendered.textContent).toContain("Auth System");

      // The reference is gone from the prose.
      expect(container.querySelector("[data-testid='markdown']")).toBeNull();
    });

    it("falls back to the standalone read when the project read fails", async () => {
      mocks.readStandaloneWorkItem.mockResolvedValue(
        workItemData("SOLO-3", "Unfiled follow-up")
      );

      await renderResolved(workItemPill("loose", "SOLO-3"));

      const [rendered] = cardsOf("channel-work-item-card");
      expect(rendered.getAttribute("data-work-item-missing")).toBeNull();
      expect(rendered.textContent).toContain("Unfiled follow-up");
      // No project row: the slug stands in as the project name.
      expect(rendered.textContent).toContain("loose");
    });

    it("degrades to the posted title when the item cannot be read", async () => {
      await renderResolved(workItemPill("gone", "GONE-9"));

      const [rendered] = cardsOf("channel-work-item-card");
      expect(rendered.getAttribute("data-work-item-missing")).toBe("true");
      expect(rendered.textContent).toContain("GONE-9");
      expect(rendered.textContent).toContain(
        "cloud.channels.feed.workItemCardMissing"
      );
    });

    it("opens the work item panel when the card is clicked", async () => {
      mocks.readWorkItem.mockResolvedValue(
        workItemData("OPEN-1", "Ship the importer")
      );
      mocks.readProject.mockResolvedValue(projectData("opener", "Importer"));

      await renderResolved(workItemPill("opener", "OPEN-1"));

      act(() => {
        cardsOf("channel-work-item-card")[0]?.dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        );
      });

      expect(mocks.openWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          shortId: "OPEN-1",
          projectSlug: "opener",
          projectId: "project-opener",
          projectName: "Importer",
          orgId: "org-1",
          workItem: expect.objectContaining({ name: "Ship the importer" }),
        })
      );
    });

    it("reads once for a body that names the same item twice", async () => {
      mocks.readWorkItem.mockResolvedValue(
        workItemData("DUP-4", "Dedupe the loader")
      );
      mocks.readProject.mockResolvedValue(projectData("dupes", "Dupes"));

      await renderResolved(
        `${workItemPill("dupes", "DUP-4")} and ${workItemPill("dupes", "DUP-4")}`
      );

      expect(cardsOf("channel-work-item-card")).toHaveLength(1);
      expect(mocks.readWorkItem).toHaveBeenCalledTimes(1);
    });
  });

  describe("GitHub references", () => {
    const PR_URL = "https://github.com/org2AI/ORG2/pull/606";
    const ISSUE_URL = "https://github.com/org2AI/ORG2/issues/443";

    it("renders owner/repo#number for a pasted pull-request pill", () => {
      render(`org2AI/ORG2#606 [pr:${PR_URL}]`);

      const [rendered] = cardsOf("channel-github-card");
      expect(rendered.getAttribute("data-github-resource")).toBe("pr");
      expect(rendered.textContent).toContain("org2AI/ORG2#606");
      expect(rendered.textContent).toContain(
        "cloud.channels.feed.githubPullRequest"
      );
    });

    it("renders owner/repo#number for a typed issue URL", () => {
      render(`still blocked on ${ISSUE_URL}`);

      const [rendered] = cardsOf("channel-github-card");
      expect(rendered.getAttribute("data-github-resource")).toBe("issue");
      expect(rendered.textContent).toContain("org2AI/ORG2#443");
      expect(rendered.textContent).toContain("cloud.channels.feed.githubIssue");
      expect(
        container.querySelector("[data-testid='markdown']")?.textContent
      ).toBe("still blocked on");
    });

    it("renders a card for a typed pull-request URL", () => {
      render(`merging ${PR_URL} after lunch`);

      expect(cardsOf("channel-github-card")).toHaveLength(1);
      expect(cardsOf("channel-github-card")[0].textContent).toContain(
        "org2AI/ORG2#606"
      );
    });

    it("leaves a repository-root URL as prose", () => {
      render("the repo is https://github.com/org2AI/ORG2 by the way");

      expect(cardsOf("channel-github-card")).toHaveLength(0);
      expect(
        container.querySelector("[data-testid='markdown']")?.textContent
      ).toBe("the repo is https://github.com/org2AI/ORG2 by the way");
    });

    it("renders one card when the same issue is named twice", () => {
      render(`org2AI/ORG2#443 [issue:${ISSUE_URL}] — see also ${ISSUE_URL}`);

      expect(cardsOf("channel-github-card")).toHaveLength(1);
    });

    it("opens the URL through the external opener, not window.open", () => {
      render(`merging ${PR_URL}`);

      act(() => {
        cardsOf("channel-github-card")[0]?.dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        );
      });

      expect(mocks.openExternalLink).toHaveBeenCalledWith(PR_URL);
    });
  });

  it("renders a session, a work item and a GitHub reference together", async () => {
    mocks.readWorkItem.mockResolvedValue(
      workItemData("MIX-7", "Land the channel cards")
    );
    mocks.readProject.mockResolvedValue(projectData("mixed", "Mixed"));

    await renderResolved(
      `landed Triage-the-flaky-test [session:sess-1] for ${workItemPill(
        "mixed",
        "MIX-7"
      )} via https://github.com/org2AI/ORG2/pull/606`
    );

    expect(cardsOf("channel-session-card")).toHaveLength(1);
    expect(cardsOf("channel-work-item-card")).toHaveLength(1);
    expect(cardsOf("channel-github-card")).toHaveLength(1);
    expect(
      container.querySelector("[data-testid='markdown']")?.textContent
    ).toBe("landed for via");
  });
});
