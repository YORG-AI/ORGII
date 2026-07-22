import { GitFork, MoreHorizontal } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CloudSessionHoverCardContent } from "@src/components/SessionHoverCard/CloudSessionHoverCard";
import { NavigationMenuParentRow } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/NavigationMenu/NavigationMenuRow";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  buildCloudSessionThreads,
  collectCloudFlatListExcludedSessionIds,
  collectThreadedLocalSessionIds,
  isCloudThreadRowDisabled,
} from "./cloudSessionThreads";

// ModelIcon resolves svg-url imports that the vitest svg stub can't feed
// through renderToStaticMarkup — swap for a plain marker element.
vi.mock("@src/components/ModelIcon", () => ({
  default: ({
    agentType,
    modelName,
  }: {
    agentType?: string;
    modelName?: string;
  }) => createElement("i", { "data-model-icon": modelName ?? agentType ?? "" }),
}));

const ORG = "11111111-1111-1111-1111-111111111111";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeRow(
  sessionId: string,
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  const ownerUserId = overrides.ownerUserId ?? USER_A;
  return {
    id: `${ORG}:${ownerUserId}:${sessionId}`,
    orgId: ORG,
    ownerMemberId: "member-1",
    ownerUserId,
    ownerDisplayName: "Alice",
    ownerIdentityKind: "human",
    sourceSessionId: sessionId,
    title: `Session ${sessionId}`,
    eventsEpoch: 1,
    eventsFrozenSeq: 0,
    eventsCount: 1,
    eventsTailHash: "hash",
    ...overrides,
  };
}

function fork(
  sessionId: string,
  rootSessionId: string,
  sourceSessionId: string,
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return makeRow(sessionId, {
    forkedFrom: {
      sourceSessionId,
      rootSessionId,
      ownerDisplayName: "Alice",
    },
    ...overrides,
  });
}

describe("buildCloudSessionThreads", () => {
  it("groups descendants flat under the root, sorted by lastActivityAt desc", () => {
    const rows = [
      makeRow("root-1", { lastActivityAt: "2026-07-01T00:00:00Z" }),
      fork("fork-1", "root-1", "root-1", {
        lastActivityAt: "2026-07-02T00:00:00Z",
      }),
      // Second-depth fork (fork of fork-1) still sits FLAT under root-1.
      fork("fork-2", "root-1", "fork-1", {
        lastActivityAt: "2026-07-03T00:00:00Z",
      }),
    ];
    const threads = buildCloudSessionThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0].rootKey).toBe("root-1");
    expect(threads[0].root?.bareSessionId).toBe("root-1");
    expect(threads[0].descendants.map((d) => d.bareSessionId)).toEqual([
      "fork-2",
      "fork-1",
    ]);
  });

  it("drops rows with deletedAt", () => {
    const rows = [
      makeRow("root-1"),
      makeRow("gone", { deletedAt: "2026-07-01T00:00:00Z" }),
    ];
    const threads = buildCloudSessionThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0].rootKey).toBe("root-1");
  });

  it("promotes a lone fork to an attributed orphan root when the root aged out", () => {
    const rows = [fork("fork-1", "aged-out-root", "aged-out-root")];
    const threads = buildCloudSessionThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0].root?.bareSessionId).toBe("fork-1");
    expect(threads[0].root?.isOrphan).toBe(true);
    expect(threads[0].descendants).toHaveLength(0);
  });

  it("nests a fork-of-fork under its present parent when the root aged out", () => {
    const rows = [
      fork("fork-parent", "aged-out-root", "aged-out-root", {
        ownerUserId: USER_B,
      }),
      fork("fork-child", "aged-out-root", "fork-parent"),
      fork("fork-grandchild", "aged-out-root", "fork-child"),
    ];
    const threads = buildCloudSessionThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0].root?.bareSessionId).toBe("fork-parent");
    expect(threads[0].root?.isOrphan).toBe(true);
    // Subtree renders flat under the promoted parent, not beside it.
    expect(
      threads[0].descendants
        .map((descendant) => descendant.bareSessionId)
        .sort()
    ).toEqual(["fork-child", "fork-grandchild"]);
    expect(threads[0].descendants.every((d) => !d.isOrphan)).toBe(true);
  });

  it("renders cycle-stranded forks top-level instead of dropping them", () => {
    const rows = [
      fork("fork-a", "aged-out-root", "fork-b", { ownerUserId: USER_B }),
      fork("fork-b", "aged-out-root", "fork-a", { ownerUserId: USER_B }),
    ];
    const threads = buildCloudSessionThreads(rows);
    expect(threads).toHaveLength(2);
    for (const thread of threads) {
      expect(thread.root?.isOrphan).toBe(true);
      expect(thread.descendants).toHaveLength(0);
    }
  });

  it("sorts threads by max lastActivityAt in the thread, desc", () => {
    const rows = [
      makeRow("old-root", { lastActivityAt: "2026-07-04T00:00:00Z" }),
      makeRow("busy-root", { lastActivityAt: "2026-06-01T00:00:00Z" }),
      // The fork's recency should pull busy-root's thread to the top.
      fork("busy-fork", "busy-root", "busy-root", {
        lastActivityAt: "2026-07-05T00:00:00Z",
      }),
    ];
    const threads = buildCloudSessionThreads(rows);
    expect(threads.map((thread) => thread.rootKey)).toEqual([
      "busy-root",
      "old-root",
    ]);
  });

  it("keeps whole threads when ANY row matches the member filter", () => {
    const rows = [
      makeRow("root-1", { ownerUserId: USER_A }),
      fork("fork-1", "root-1", "root-1", { ownerUserId: USER_B }),
      makeRow("root-2", { ownerUserId: USER_A }),
    ];
    const threads = buildCloudSessionThreads(rows, { memberFilter: USER_B });
    expect(threads).toHaveLength(1);
    expect(threads[0].rootKey).toBe("root-1");
    // Thread integrity: the non-matching root stays in the kept thread.
    expect(threads[0].root?.row.ownerUserId).toBe(USER_A);
    expect(threads[0].descendants).toHaveLength(1);
  });

  it("flags rows whose bare id is a local session as isMine", () => {
    const rows = [
      makeRow("root-1", { ownerUserId: USER_B }),
      makeRow("root-2", { ownerUserId: USER_B }),
      // The viewer's fork under root-2 — its thread stays (teammate root).
      fork("fork-mine", "root-2", "root-2"),
    ];
    const threads = buildCloudSessionThreads(rows, {
      localOwnSessionIds: new Set(["fork-mine"]),
      viewerUserId: USER_A,
    });
    const withMine = threads.find((thread) => thread.rootKey === "root-2");
    const theirs = threads.find((thread) => thread.rootKey === "root-1");
    expect(withMine?.descendants[0]?.isMine).toBe(true);
    expect(theirs?.root?.isMine).toBe(false);
  });

  it("does not treat a teammate row as mine when a shared local history has the same id", () => {
    const threads = buildCloudSessionThreads(
      [makeRow("shared-codex-id", { ownerUserId: USER_B })],
      {
        localOwnSessionIds: new Set(["shared-codex-id"]),
        viewerUserId: USER_A,
      }
    );

    expect(threads).toHaveLength(1);
    expect(threads[0].root.isMine).toBe(false);
  });

  it("drops threads whose every row is the viewer's own (solo shared session)", () => {
    // TEAM section = collaboration context: a solo shared session with no
    // teammate activity stays in the flat local list, not the team section.
    const rows = [
      makeRow("solo-mine"),
      makeRow("teammate-root", { ownerUserId: USER_B }),
    ];
    const threads = buildCloudSessionThreads(rows, {
      localOwnSessionIds: new Set(["solo-mine"]),
      viewerUserId: USER_A,
    });
    expect(threads.map((thread) => thread.rootKey)).toEqual(["teammate-root"]);
    // And therefore nothing is excluded from the flat local list.
    expect(collectThreadedLocalSessionIds(threads)).toEqual(new Set<string>());
  });

  it("keeps the viewer's own root once a teammate forked it", () => {
    const rows = [
      makeRow("root-mine"),
      fork("fork-theirs", "root-mine", "root-mine", { ownerUserId: USER_B }),
    ];
    const threads = buildCloudSessionThreads(rows, {
      localOwnSessionIds: new Set(["root-mine"]),
      viewerUserId: USER_A,
    });
    expect(threads).toHaveLength(1);
    expect(threads[0].root?.isMine).toBe(true);
    expect(threads[0].descendants[0]?.row.ownerUserId).toBe(USER_B);
  });

  it("uses the bare session id even when the row id carries org/user prefixes", () => {
    const rows = [
      fork("fork-1", "root-1", "root-1"),
      makeRow("root-1", { ownerUserId: USER_B }),
    ];
    const threads = buildCloudSessionThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0].root?.bareSessionId).toBe("root-1");
  });
});

describe("collectThreadedLocalSessionIds", () => {
  it("collects only isMine rows from the given threads", () => {
    const threads = buildCloudSessionThreads(
      [
        // Teammate root keeps the thread in the team section; the viewer's
        // fork under it renders threaded and is excluded from the flat list.
        makeRow("root-1", { ownerUserId: USER_B }),
        fork("fork-1", "root-1", "root-1"),
        makeRow("root-2", { ownerUserId: USER_B }),
      ],
      {
        localOwnSessionIds: new Set(["fork-1"]),
        viewerUserId: USER_A,
      }
    );
    expect(collectThreadedLocalSessionIds(threads)).toEqual(
      new Set(["fork-1"])
    );
  });

  it("keeps own sessions in the flat list when a member filter drops their thread", () => {
    // Viewer (USER_A) forked USER_B's root-2; the member filter shows only
    // USER_B's root-1 thread. root-2's thread (which carries the viewer's
    // fork) is filtered out of the team section, so the fork must NOT be in
    // the exclusion set — otherwise it would vanish from BOTH lists.
    const rows = [
      makeRow("root-1", { ownerUserId: USER_B }),
      makeRow("root-2", {
        ownerUserId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      }),
      fork("fork-mine", "root-2", "root-2"),
    ];
    const filteredThreads = buildCloudSessionThreads(rows, {
      memberFilter: USER_B,
      localOwnSessionIds: new Set(["fork-mine"]),
      viewerUserId: USER_A,
    });
    expect(collectThreadedLocalSessionIds(filteredThreads)).toEqual(
      new Set<string>()
    );
    // Without the filter the fork renders in the team section and IS
    // excluded from the flat list.
    const allThreads = buildCloudSessionThreads(rows, {
      localOwnSessionIds: new Set(["fork-mine"]),
      viewerUserId: USER_A,
    });
    expect(collectThreadedLocalSessionIds(allThreads)).toEqual(
      new Set(["fork-mine"])
    );
  });
});

describe("collectCloudFlatListExcludedSessionIds", () => {
  it("keeps teammate replay caches out of My Sessions when their Team row is filtered out", () => {
    const importedSession = {
      session_id: "imported-cache-1",
      importedFrom: {
        orgId: ORG,
        sourceSessionId: "shared-by-teammate",
      },
    };

    expect(
      collectCloudFlatListExcludedSessionIds([], [importedSession], ORG)
    ).toEqual(new Set(["imported-cache-1"]));
  });

  it("does not hide replay caches belonging to a different org", () => {
    const importedSession = {
      session_id: "other-org-cache",
      importedFrom: {
        orgId: "other-org",
        sourceSessionId: "shared-by-teammate",
      },
    };

    expect(
      collectCloudFlatListExcludedSessionIds([], [importedSession], ORG)
    ).toEqual(new Set());
  });
});

describe("isCloudThreadRowDisabled", () => {
  it("never disables isMine rows, even without published segments", () => {
    const threads = buildCloudSessionThreads(
      [
        // Teammate root keeps the thread visible; the viewer's unpublished
        // fork must still be clickable (routes to the LOCAL session).
        makeRow("root-1", { ownerUserId: USER_B }),
        fork("fork-mine", "root-1", "root-1", { eventsEpoch: undefined }),
      ],
      {
        localOwnSessionIds: new Set(["fork-mine"]),
        viewerUserId: USER_A,
      }
    );
    expect(isCloudThreadRowDisabled(threads[0].descendants[0])).toBe(false);
  });

  it("disables teammate rows without published segments only", () => {
    const threads = buildCloudSessionThreads([
      makeRow("root-1", { eventsEpoch: undefined, ownerUserId: USER_B }),
      makeRow("root-2", { ownerUserId: USER_B }),
    ]);
    const unpublished = threads.find((t) => t.rootKey === "root-1")!.root!;
    const published = threads.find((t) => t.rootKey === "root-2")!.root!;
    expect(isCloudThreadRowDisabled(unpublished)).toBe(true);
    expect(isCloudThreadRowDisabled(published)).toBe(false);
  });
});

function renderForkParent(item: NavigationMenuItem): string {
  return renderToStaticMarkup(
    createElement(NavigationMenuParentRow, {
      item,
      isChild: false,
      isOpen: true,
      submenuSelected: false,
      collapsed: false,
      t: (key: string) => key,
      renderIcon: () => null,
      renderMenuItem: () => createElement("div"),
      onMenuItemContextMenu: vi.fn(),
      onRowMouseEnter: vi.fn(),
      onRowActionClick: vi.fn(),
      onToggleSubmenu: vi.fn(),
      compactRows: true,
    })
  );
}

describe("cloud fork parent hover rendering", () => {
  it("emits owner details, Fork, and More in the parent hover scope", () => {
    const markup = renderForkParent({
      id: "cloudremote-org|row",
      key: "cloudremote-org|row",
      label: "Forked session",
      shortcut: "@alice · forked from @bob · 2m",
      showMoreActions: true,
      rowActions: [
        { icon: GitFork, label: "Fork", onClick: vi.fn() },
        { icon: MoreHorizontal, label: "More", onClick: vi.fn() },
      ],
      children: [{ id: "child", key: "child", label: "Child" }],
    });

    expect(markup).toContain("group/parent");
    expect(markup).toContain("group-hover/parent:opacity-100");
    expect(markup).toContain("@alice · forked from @bob · 2m");
    expect(markup).toContain('aria-label="Fork"');
    expect(markup).toContain('aria-label="More"');
  });
});

describe("cloud teammate hover card", () => {
  it("renders owner, fork lineage, repo/branch, and last activity", () => {
    const markup = renderToStaticMarkup(
      createElement(CloudSessionHoverCardContent, {
        row: makeRow("s1", {
          title: "Fix realtime flow",
          repoScopeKey: "yorgai/org2",
          branch: "feat/org2-cloud-auth",
          lastActivityAt: "2026-07-10T12:00:00Z",
          cliAgentType: "claude_code_cli",
          model: "claude-sonnet-5",
          forkedFrom: {
            sourceSessionId: "s0",
            rootSessionId: "s0",
            ownerDisplayName: "Bob",
          },
        }),
      })
    );

    expect(markup).toContain("Fix realtime flow");
    expect(markup).toContain("@Alice");
    // Fork lineage row renders (test i18n loads only the sessions namespace,
    // so the un-interpolated defaultValue is what proves the row exists).
    expect(markup).toContain("forked from @");
    expect(markup).toContain("org2");
    expect(markup).toContain("feat/org2-cloud-auth");
    // Owner agent/model row (pushed with the metadata since 2026-07-11).
    expect(markup).toContain("Claude Code CLI");
    expect(markup).toContain("claude-sonnet-5");
  });

  it("renders a watcher row with the live viewer names", () => {
    const markup = renderToStaticMarkup(
      createElement(CloudSessionHoverCardContent, {
        row: makeRow("s1"),
        viewers: [{ displayName: "Bob" }, { displayName: "Carol" }],
      })
    );

    expect(markup).toContain('data-testid="cloud-session-watchers"');
    expect(markup).toContain("Bob, Carol");
  });
});
