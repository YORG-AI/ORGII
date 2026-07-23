export type ChangelogSectionKey = "highlights" | "improvements" | "fixes";

export interface ChangelogReleaseSection {
  key: ChangelogSectionKey;
  items: string[];
}

export interface ChangelogRelease {
  version: string;
  date: string;
  summary: string;
  sections: ChangelogReleaseSection[];
}

/**
 * Curated product notes keyed to shipped versions. Keep newest releases first.
 * This intentionally replaces the old generated month/day commit digest: the
 * in-product Changelog is a release surface, not a repository activity feed.
 */
export const CHANGELOG_RELEASES: ChangelogRelease[] = [
  {
    version: "v1.2.1",
    date: "2026-07-22",
    summary:
      "A reliability and workflow release focused on runtime visibility, work management, collaboration, and safer background activity.",
    sections: [
      {
        key: "highlights",
        items: [
          "Refined Runtime cards and refresh controls.",
          "Improved Kanban presentation, pagination, and impact summaries.",
          "Consolidated cloud and local organization management.",
        ],
      },
      {
        key: "improvements",
        items: [
          "Added human work logs and clearer external session ownership.",
          "Grouped MCP activity with related chat commands.",
          "Deferred usage request-round loading until it is needed.",
        ],
      },
      {
        key: "fixes",
        items: [
          "Stopped cross-organization polling fan-out and teardown retries.",
          "Stabilized cloud auth handoffs, worktree cleanup, and session navigation.",
          "Fixed Windows file paths in file-tree previews.",
        ],
      },
    ],
  },
  {
    version: "v1.2.0",
    date: "2026-07-22",
    summary:
      "A platform release that unified organization workflows and strengthened session isolation across workspaces.",
    sections: [
      {
        key: "highlights",
        items: [
          "Unified organization management into one shared experience.",
          "Completed session workspace isolation across the Workstation.",
        ],
      },
      {
        key: "improvements",
        items: [
          "Coalesced tutorial highlight layout updates for smoother guidance.",
          "Simplified ownership of pending plan-approval state.",
        ],
      },
      {
        key: "fixes",
        items: [
          "Closed remaining cloud lifecycle and authorization gaps.",
          "Improved GitHub issue layout and metadata consistency.",
        ],
      },
    ],
  },
  {
    version: "v1.1.25-beta.5",
    date: "2026-07-21",
    summary:
      "A collaboration hardening release with tighter lifecycle bounds and lower idle resource use.",
    sections: [
      {
        key: "highlights",
        items: [
          "Hardened multi-instance cloud collaboration and handoff behavior.",
          "Added safer beta-channel release publishing.",
        ],
      },
      {
        key: "improvements",
        items: [
          "Lazy-loaded imported session turn bodies.",
          "Bound shared-session caches and background synchronization work.",
        ],
      },
      {
        key: "fixes",
        items: [
          "Kept unauthenticated builds offline and quieted inactive retries.",
          "Made secondary runtime history paths portable.",
        ],
      },
    ],
  },
];
