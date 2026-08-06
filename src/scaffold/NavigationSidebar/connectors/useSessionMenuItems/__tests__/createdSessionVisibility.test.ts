import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NavigationMenuLeafRow } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/NavigationMenu/NavigationMenuRow";

import { buildSessionMenuItem } from "../menuItemBuilders";

beforeEach(() => {
  vi.resetModules();
});

describe("newly created session visibility", () => {
  it("renders a registered creation as a Sidebar row before roster refresh", async () => {
    const { createInstrumentedStore } =
      await import("@src/util/core/state/instrumentedStore");
    const store = createInstrumentedStore();
    const { sessionsAtom } =
      await import("@src/store/session/sessionAtom/atoms");
    const { registerCreatedSession } =
      await import("@src/store/session/sessionAtom/mutations");
    const { sessionPaginationAtom } =
      await import("@src/store/session/sessionAtom/paginationAtoms");
    const { createSidebarRosterMatcher } =
      await import("@src/store/session/sessionAtom/sidebarRoster");

    const initialPagination = store.get(sessionPaginationAtom);
    store.set(sessionPaginationAtom, {
      ...initialPagination,
      standalone_agent: {
        ...initialPagination.standalone_agent,
        sessionIds: ["sdeagent-existing"],
        cursor: {
          updatedAt: "2026-08-05T10:00:00Z",
          sessionId: "sdeagent-existing",
        },
        generation: 1,
      },
    });

    registerCreatedSession({
      session_id: "sdeagent-new-visible",
      name: "New visible session",
      status: "running",
      category: "rust_agent",
      created_at: "2026-08-05T11:00:00Z",
      updated_at: "2026-08-05T11:00:00Z",
    });

    const matcher = createSidebarRosterMatcher(
      store.get(sessionPaginationAtom)
    );
    const [visibleSession] = store.get(sessionsAtom).filter(matcher);
    if (!visibleSession) throw new Error("created session was filtered out");
    expect(visibleSession.session_id).toBe("sdeagent-new-visible");

    const item = buildSessionMenuItem({
      session: visibleSession,
      untitledSession: "Untitled",
      visitedSessions: new Set(),
    });
    const html = renderToStaticMarkup(
      createElement(NavigationMenuLeafRow, {
        item,
        isChild: false,
        isSelected: false,
        collapsed: false,
        t: (key) => key,
        renderIcon: () => null,
        onMenuItemClick: () => undefined,
        onRowMouseEnter: () => undefined,
        onRowActionClick: () => undefined,
      })
    );

    expect(html).toContain(
      'data-testid="sidebar-session-item-sdeagent-new-visible"'
    );
    expect(html).toContain("New visible session");
  });
});
