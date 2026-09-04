import { describe, expect, it } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  SESSION_LIST_CATEGORIES,
  type SessionListCategory,
} from "@src/store/session";

import { attachSessionPaginationPlan } from "../useSessionMenuItems/paginationHelpers";
import {
  CLOUD_MY_SESSIONS_LOAD_MORE_ID,
  CLOUD_MY_SESSIONS_SECTION_ID,
  CLOUD_PINNED_SECTION_ID,
  buildCloudScopedMenuItems,
} from "./cloudScopedMenuItems";

describe("buildCloudScopedMenuItems", () => {
  const category = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
  const backendPager = (phase: "ready" | "loading" | "error", label: string) =>
    attachSessionPaginationPlan(
      {
        id: "load-more-unified",
        key: "load-more-unified",
        label,
      },
      {
        targets: [{ category, phase }],
      }
    );
  const streamPager = (
    targetCategory: SessionListCategory,
    phase: "ready" | "loading" | "error",
    label: string
  ) =>
    attachSessionPaginationPlan(
      {
        id: `load-more-${targetCategory}`,
        key: `load-more-${targetCategory}`,
        label,
      },
      {
        targets: [{ category: targetCategory, phase }],
      }
    );

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

  it("honors the five-row session-group preference in cloud scope", () => {
    const sessionItems = Array.from(
      { length: 7 },
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
      mySessionsVisibleCount: 5,
    });

    expect(result.slice(-6).map((item) => item.id)).toEqual([
      ...Array.from({ length: 5 }, (_, index) => `session-${index}`),
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
      mySessionsLabel: "My sessions",
    });

    expect(
      result.some((item) => item.id === `separator-${CLOUD_PINNED_SECTION_ID}`)
    ).toBe(false);
  });

  it("does not leave a normal pager in My sessions when every local row is pinned", () => {
    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      sessionMenuItems: [
        {
          id: "session-pinned",
          key: "session-pinned",
          label: "Pinned one",
          pinned: true,
        },
        backendPager("ready", "Load more"),
      ],
      mySessionsLabel: "My sessions",
      pinnedLabel: "Pinned",
    });

    expect(result.map((item) => item.id)).toEqual([
      `separator-${CLOUD_PINNED_SECTION_ID}`,
      "session-pinned",
      "separator-cloud-team-sessions",
      `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`,
    ]);
  });

  it("keeps a failed backend page retryable when My sessions is empty", () => {
    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      sessionMenuItems: [backendPager("error", "Retry")],
      mySessionsLabel: "My sessions",
    });

    expect(result.at(-1)).toMatchObject({
      id: CLOUD_MY_SESSIONS_LOAD_MORE_ID,
      label: "Retry",
      disabled: false,
      sessionPaginationPlan: {
        targets: [{ category, phase: "error" }],
      },
    });
  });

  it("removes ordinary ready targets from a pinned-only retry plan", () => {
    const failedCategory = SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const mixedPager = attachSessionPaginationPlan(
      {
        id: "load-more-unified",
        key: "load-more-unified",
        label: "Retry",
      },
      {
        targets: [
          { category, phase: "ready" },
          { category: failedCategory, phase: "error" },
        ],
      }
    );
    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      sessionMenuItems: [
        {
          id: "session-pinned",
          key: "session-pinned",
          label: "Pinned one",
          pinned: true,
        },
        mixedPager,
      ],
      mySessionsLabel: "My sessions",
    });

    expect(result.at(-1)).toMatchObject({
      id: CLOUD_MY_SESSIONS_LOAD_MORE_ID,
      label: "Retry",
      sessionPaginationPlan: {
        targets: [{ category: failedCategory, phase: "error" }],
      },
    });
  });

  it("combines every backend stream target into the cloud pager plan", () => {
    const secondCategory = SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const result = buildCloudScopedMenuItems({
      cloudMenuItems: [
        {
          id: "separator-cloud-team-sessions",
          key: "separator-cloud-team-sessions",
          label: "Team sessions",
        },
      ],
      sessionMenuItems: [
        { id: "session-one", key: "session-one", label: "Session one" },
        streamPager(category, "ready", "Load more"),
        streamPager(secondCategory, "error", "Retry"),
      ],
      mySessionsLabel: "My sessions",
    });

    expect(result.at(-1)).toMatchObject({
      id: CLOUD_MY_SESSIONS_LOAD_MORE_ID,
      label: "Retry",
      disabled: false,
      sessionPaginationPlan: {
        targets: [
          { category, phase: "ready" },
          { category: secondCategory, phase: "error" },
        ],
      },
    });
  });

  it("keeps local rows expandable while a backend stream is loading", () => {
    const localRows = Array.from(
      { length: 11 },
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
      sessionMenuItems: [
        ...localRows,
        streamPager(category, "loading", "Loading"),
      ],
      mySessionsLabel: "My sessions",
      loadMoreLabel: "Load more",
    });

    expect(result.at(-1)).toMatchObject({
      id: CLOUD_MY_SESSIONS_LOAD_MORE_ID,
      label: "Load more",
      disabled: false,
      sessionPaginationPlan: {
        targets: [{ category, phase: "loading" }],
      },
    });
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
