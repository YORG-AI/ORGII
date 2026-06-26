import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

export const GIT_SETTINGS_REGISTRY = {
  "git.pullStrategy": {
    schema: z.enum(["merge", "rebase", "ff-only"]),
    default: "rebase" as const,
    description:
      'How git pull integrates remote changes: "rebase" (default, linear history), "merge" (preserves history), or "ff-only" (strict, refuses if diverged)',
    category: "git",
    enumLabels: {
      rebase: "Rebase (default)",
      merge: "Merge",
      "ff-only": "Fast-forward only",
    },
  },
  "git.autoFetch": {
    schema: z.boolean(),
    default: true,
    description: "Automatically fetch from remote in the background",
    category: "git",
  },
  "git.autoFetchInterval": {
    schema: z.number().int().min(30).max(3600),
    default: 180,
    description: "Interval in seconds between automatic fetches (30-3600)",
    category: "git",
  },
  "git.attribution.coauthorEnabled": {
    schema: z.boolean(),
    default: true,
    description:
      "Add an ORGII coauthor trailer to Git commits created from ORGII",
    category: "git",
  },
  "git.attribution.prEnabled": {
    schema: z.boolean(),
    default: true,
    description: "Add ORGII attribution to pull requests created from ORGII",
    category: "git",
  },
  "git.autoCreatePr": {
    schema: z.boolean(),
    default: false,
    description:
      "Automatically create a pull request in Workstation Source Control when a feature branch is fully pushed and clean",
    category: "git",
  },
  "git.worktree.maxCount": {
    schema: z.number().int().min(1).max(32),
    default: 8,
    description:
      "Maximum number of concurrent agent worktrees per repository (1-32). When the limit is reached, merge or discard existing sessions first.",
    category: "git",
  },
  "git.worktree.cleanupIntervalHours": {
    schema: z.number().int().min(1).max(168),
    default: 6,
    description:
      "Interval in hours between background cleanup passes for stale agent worktrees (1-168).",
    category: "git",
  },
} as const satisfies Record<string, SettingDefinition>;
