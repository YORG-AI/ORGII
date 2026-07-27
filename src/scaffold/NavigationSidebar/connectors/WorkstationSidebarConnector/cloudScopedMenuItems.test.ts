import { describe, expect, it } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import {
  CLOUD_MY_SESSIONS_LOAD_MORE_ID,
  CLOUD_MY_SESSIONS_SECTION_ID,
  buildCloudScopedMenuItems,
} from "./cloudScopedMenuItems";

describe("buildCloudScopedMenuItems", () => {
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
      mySessionsLabel: "My sessions",
      mySessionsVisibleCount: 20,
    });

    expect(result.slice(-21).map((item) => item.id)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `session-${index}`),
      CLOUD_MY_SESSIONS_LOAD_MORE_ID,
    ]);
  });
});
