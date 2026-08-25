// @vitest-environment jsdom
//
// Covers the posted-reference half of "drop something into a channel":
// sessions become cards, every other reference becomes a Markdown link, and
// a session whose live row is gone remains available from its snapshot.
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
import { visitedSessionIdsAtom } from "@src/store/session/visitedSessionsAtom";
import type { LocalChannelMessage } from "@src/store/ui/localChannelMessagesAtom";

import ChannelMessageRow from "./ChannelMessageRow";

const mocks = vi.hoisted(() => ({
  agentIconRender: vi.fn(),
  openCloudSession: vi.fn(),
  openSession: vi.fn(),
  turnCount: 7,
}));

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
    mocks.turnCount = 7;
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

  it("does not rerender a local card when an unrelated session is visited", () => {
    render("Triage-the-flaky-test [session:sess-1]");
    expect(mocks.agentIconRender).toHaveBeenCalledTimes(1);

    act(() => {
      store.set(visitedSessionIdsAtom, ["unrelated-session"]);
    });

    expect(mocks.agentIconRender).toHaveBeenCalledTimes(1);
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

  it("renders non-session pills as Markdown links instead of blue tags", () => {
    render("config.ts [file:/repo/config.ts] and Triage [session:sess-1]");

    expect(
      container.querySelector("[data-testid='markdown']")?.textContent
    ).toBe("[config.ts](/repo/config.ts) and");
    expect(
      container.querySelector("[data-testid='channel-message-pill-body']")
    ).toBeNull();
    expect(card()).not.toBeNull();
  });

  it("renders work-item references as Markdown links, not cards", () => {
    render(workItemPill("auth", "AUTH-12"));

    expect(cardsOf("channel-work-item-card")).toHaveLength(0);
    expect(
      container.querySelector("[data-testid='markdown']")?.textContent
    ).toBe("[AUTH-12](workitem://auth/AUTH-12/1700000000000)");
  });

  describe("ordinary web references", () => {
    const PR_URL = "https://github.com/org2AI/ORG2/pull/606";
    const ISSUE_URL = "https://github.com/org2AI/ORG2/issues/443";

    it("renders a pasted pull-request pill as a Markdown link", () => {
      render(`org2AI/ORG2#606 [pr:${PR_URL}]`);

      expect(cardsOf("channel-github-card")).toHaveLength(0);
      expect(
        container.querySelector("[data-testid='markdown']")?.textContent
      ).toBe(`[org2AI/ORG2#606](${PR_URL})`);
    });

    it("resolves an embedded PR token to its GitHub Markdown link", () => {
      const encoded = btoa(
        encodeURIComponent(
          JSON.stringify({
            prNumber: 606,
            prTitle: "Remove reference tags",
            prUrl: PR_URL,
          })
        )
      );
      render(`#606-Remove-reference-tags [pr:pr://606::${encoded}]`);

      expect(
        container.querySelector("[data-testid='markdown']")?.textContent
      ).toBe(`[#606-Remove-reference-tags](${PR_URL})`);
    });

    it("keeps a typed issue URL in Markdown prose", () => {
      render(`still blocked on ${ISSUE_URL}`);

      expect(cardsOf("channel-github-card")).toHaveLength(0);
      expect(
        container.querySelector("[data-testid='markdown']")?.textContent
      ).toBe(`still blocked on ${ISSUE_URL}`);
    });
  });

  it("renders only the session as a card in a mixed message", () => {
    render(
      `landed Triage-the-flaky-test [session:sess-1] for ${workItemPill(
        "mixed",
        "MIX-7"
      )} via https://github.com/org2AI/ORG2/pull/606`
    );

    expect(cardsOf("channel-session-card")).toHaveLength(1);
    expect(cardsOf("channel-work-item-card")).toHaveLength(0);
    expect(cardsOf("channel-github-card")).toHaveLength(0);
    expect(
      container.querySelector("[data-testid='markdown']")?.textContent
    ).toBe(
      "landed for [MIX-7](workitem://mixed/MIX-7/1700000000000) via https://github.com/org2AI/ORG2/pull/606"
    );
  });
});
