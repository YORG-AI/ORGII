import { describe, expect, it } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";

import {
  CLOUD_MY_SESSIONS_LOAD_MORE_ID,
  CLOUD_MY_SESSIONS_SECTION_ID,
  CLOUD_PINNED_SECTION_ID,
  buildCloudScopedMenuItems,
} from "./cloudScopedMenuItems";

describe("buildCloudScopedMenuItems", () => {
  const session = (sessionId: string, updatedAt: string): Session => ({
    session_id: sessionId,
    status: "completed",
    created_at: updatedAt,
    updated_at: updatedAt,
  });
  const sessionMap = (...sessions: Session[]) =>
    new Map(sessions.map((entry) => [entry.session_id, entry]));
  const localSections: NavigationMenuItem[] = [
    { id: "separator-today", key: "separator-today", label: "Today" },
    { id: "session-today", key: "session-today", label: "Today session" },
    {
      id: "separator-yesterday",
      key: "separator-yesterday",
      label: "Yesterday",
    },
    {
      id: "session-yesterday",
      key: "session-yesterday",
      label: "Yesterday session",
    },
  ];

  it("keeps regular grouping unchanged outside cloud scope", () => {
    expect(
      buildCloudScopedMenuItems({
        cloudMenuItems: [],
        sessionMenuItems: localSections,
        sessionById: sessionMap(),
        mySessionsLabel: "My sessions",
      })
    ).toEqual(localSections);
  });

  it("flattens regular rows into one My sessions section in cloud scope", () => {
    const teamItems: NavigationMenuItem[] = [
      {
        id: "separator-cloud-team-sessions",
        key: "separator-cloud-team-sessions",
        label: "Team sessions",
      },
      { id: "team-session", key: "team-session", label: "Team session" },
    ];

    const result = buildCloudScopedMenuItems({
      cloudMenuItems: teamItems,
      sessionMenuItems: localSections,
      sessionById: sessionMap(
        session("session-today", "2026-07-27T12:00:00Z"),
        session("session-yesterday", "2026-07-26T12:00:00Z")
      ),
      mySessionsLabel: "My sessions",
    });

    expect(result).toEqual([
      ...teamItems,
      {
        id: `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`,
        key: `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`,
        label: "My sessions",
      },
      localSections[1],
      localSections[3],
    ]);
  });

  it("restores one newest-activity queue after hidden subgroup ordering", () => {
    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      // Simulates pinned/workspace grouping putting an older row first.
      sessionMenuItems: [
        { id: "older-pinned", key: "older-pinned", label: "Older pinned" },
        { id: "separator-workspace", key: "separator-workspace", label: "A" },
        { id: "newest", key: "newest", label: "Newest" },
        { id: "middle", key: "middle", label: "Middle" },
      ],
      sessionById: sessionMap(
        session("older-pinned", "2026-07-25T12:00:00Z"),
        session("newest", "2026-07-27T12:00:00Z"),
        session("middle", "2026-07-26T12:00:00Z")
      ),
      mySessionsLabel: "My sessions",
    });

    const mySectionIndex = result.findIndex(
      (item) => item.id === `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`
    );
    expect(result.slice(mySectionIndex + 1).map((item) => item.id)).toEqual([
      "newest",
      "middle",
      "older-pinned",
    ]);
  });

  it("renders the My sessions section even when it has no local rows", () => {
    expect(
      buildCloudScopedMenuItems({
        cloudMenuItems: [
          {
            id: "separator-cloud-team-sessions",
            key: "separator-cloud-team-sessions",
            label: "Team sessions",
          },
        ],
        sessionMenuItems: [],
        sessionById: sessionMap(),
        mySessionsLabel: "My sessions",
      })
    ).toEqual([
      {
        id: "separator-cloud-team-sessions",
        key: "separator-cloud-team-sessions",
        label: "Team sessions",
      },
      {
        id: `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`,
        key: `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`,
        label: "My sessions",
      },
    ]);
  });

  it("shows only 10 My sessions and replaces subgroup pagers with one top-level pager", () => {
    const sessionItems = Array.from(
      { length: 24 },
      (_, index): NavigationMenuItem => ({
        id: `session-${index}`,
        key: `session-${index}`,
        label: `Session ${index}`,
      })
    );
    sessionItems.splice(4, 0, {
      id: "load-more-group-time:today",
      key: "load-more-group-time:today",
      label: "Load more",
    });
    sessionItems.splice(12, 0, {
      id: "load-more-cli_agent",
      key: "load-more-cli_agent",
      label: "Load more",
    });
    sessionItems.splice(18, 0, {
      id: "separator-older",
      key: "separator-older",
      label: "Older",
    });

    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      sessionMenuItems: sessionItems,
      sessionById: sessionMap(
        ...Array.from({ length: 24 }, (_, index) =>
          session(
            `session-${index}`,
            new Date(Date.UTC(2026, 6, 27, 0, 0, 24 - index)).toISOString()
          )
        )
      ),
      mySessionsLabel: "My sessions",
      loadMoreLabel: "Load more",
    });
    const mySectionIndex = result.findIndex(
      (item) => item.id === `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`
    );
    const myItems = result.slice(mySectionIndex + 1);

    expect(myItems.map((item) => item.id)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `session-${index}`),
      CLOUD_MY_SESSIONS_LOAD_MORE_ID,
    ]);
    expect(myItems.filter((item) => item.label === "Load more")).toHaveLength(
      1
    );
  });

  it("advances My sessions in 10-row pages", () => {
    const sessionItems = Array.from(
      { length: 21 },
      (_, index): NavigationMenuItem => ({
        id: `session-${index}`,
        key: `session-${index}`,
        label: `Session ${index}`,
      })
    );

    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      sessionMenuItems: sessionItems,
      sessionById: sessionMap(
        ...Array.from({ length: 21 }, (_, index) =>
          session(
            `session-${index}`,
            new Date(Date.UTC(2026, 6, 27, 0, 0, 21 - index)).toISOString()
          )
        )
      ),
      mySessionsLabel: "My sessions",
      mySessionsVisibleCount: 20,
    });

    expect(result.slice(-21).map((item) => item.id)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `session-${index}`),
      CLOUD_MY_SESSIONS_LOAD_MORE_ID,
    ]);
  });

  it("keeps the Pinned section above Team and My sessions", () => {
    const teamItems: NavigationMenuItem[] = [
      {
        id: "separator-cloud-team-sessions",
        key: "separator-cloud-team-sessions",
        label: "Team sessions",
      },
    ];

    const result = buildCloudScopedMenuItems({
      cloudMenuItems: teamItems,
      sessionMenuItems: [
        {
          id: "session-pinned",
          key: "session-pinned",
          label: "Pinned one",
          pinned: true,
        },
        { id: "separator-today", key: "separator-today", label: "Today" },
        { id: "session-today", key: "session-today", label: "Today one" },
      ],
      sessionById: sessionMap(),
      mySessionsLabel: "My sessions",
      pinnedLabel: "Pinned",
    });

    // Pinned is user intent, not a date bucket: it survives the flattening
    // that removes Today/Older, stays at the top, and does not leak into My
    // sessions.
    expect(result.map((item) => item.id)).toEqual([
      `separator-${CLOUD_PINNED_SECTION_ID}`,
      "session-pinned",
      "separator-cloud-team-sessions",
      `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`,
      "session-today",
    ]);
  });

  it("omits the Pinned section when nothing is pinned", () => {
    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      sessionMenuItems: [
        { id: "separator-today", key: "separator-today", label: "Today" },
        { id: "session-today", key: "session-today", label: "Today one" },
      ],
      sessionById: sessionMap(),
      mySessionsLabel: "My sessions",
    });

    expect(
      result.some((item) => item.id === `separator-${CLOUD_PINNED_SECTION_ID}`)
    ).toBe(false);
  });

  it("does not mistake a date group's own pager for a backend stream pager", () => {
    // `load-more-group-*` and `load-more-<category>` share a prefix; only the
    // latter means "the backend can fetch another page".
    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      sessionMenuItems: [
        { id: "separator-today", key: "separator-today", label: "Today" },
        { id: "session-today", key: "session-today", label: "Today one" },
        {
          id: "load-more-group-time:today",
          key: "load-more-group-time:today",
          label: "Show more",
        },
      ],
      sessionById: sessionMap(),
      mySessionsLabel: "My sessions",
    });

    expect(result.map((item) => item.id)).toEqual([
      "separator-cloud-team-sessions",
      `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`,
      "session-today",
    ]);
  });

  it("lifts a pinned team session into the same Pinned section", () => {
    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
        {
          id: "cloudremote-org-1|row-9",
          key: "cloudremote-org-1|row-9",
          label: "Teammate session",
          pinned: true,
        },
        {
          id: "cloudremote-org-1|row-8",
          key: "cloudremote-org-1|row-8",
          label: "Another teammate session",
        },
      ],
      sessionMenuItems: [
        { id: "separator-today", key: "separator-today", label: "Today" },
        { id: "session-today", key: "session-today", label: "Today one" },
      ],
      sessionById: sessionMap(),
      mySessionsLabel: "My sessions",
      pinnedLabel: "Pinned",
    });

    // One Pinned section holds both kinds — a pin means "keep this where I can
    // see it", which is not a promise scoped to one section. It stays above
    // both Team and My sessions.
    expect(result.map((item) => item.id)).toEqual([
      `separator-${CLOUD_PINNED_SECTION_ID}`,
      "cloudremote-org-1|row-9",
      "separator-cloud-team-sessions",
      "cloudremote-org-1|row-8",
      `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`,
      "session-today",
    ]);
  });
});
