/**
 * Pure helpers for the WorktreeSourceModal **Branch** tab.
 *
 * The Branch tab lets the user pick a real repository branch (local or remote)
 * to use as the base ref for an isolated worktree, or fall back to an arbitrary
 * custom ref (tag / commit sha / any ref git can resolve). Extracted here so the
 * branch → `WorktreeLaunchSource` mapping, search filtering, and custom-ref
 * detection are unit-testable without React / the git HTTP client.
 */
import { categorizeBranches } from "@src/scaffold/GlobalSpotlight/utils/branchUtils";
import type { Branch } from "@src/store/repo";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

/** Max characters for a truncated source label (shared with the modal). */
export const SOURCE_LABEL_MAX = 52;

/**
 * Collapse internal whitespace and truncate with an ellipsis so labels stay on
 * a single line inside the fixed-width modal.
 */
export function compactText(
  value: string,
  maxLength = SOURCE_LABEL_MAX
): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

/**
 * A branch entry the modal can render + turn into a launch source. `name` is
 * the git-resolvable short ref: `main` for locals, `origin/develop` for remotes
 * (both accepted directly by `git worktree add <base>`).
 */
export interface WorktreeBranchOption {
  /** Git-resolvable ref: `main` (local) or `origin/develop` (remote). */
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  lastCommitDate?: string;
  /**
   * Filesystem path of the git worktree that has this branch checked out, if
   * any. Populated from `getGitWorktrees` (local branches only) so the picker
   * can surface a **Worktrees** section like the Spotlight branch selector.
   */
  worktreePath?: string;
}

/** Raw branch shape returned by `gitApi.getGitBranches`. */
export interface RawGitBranch {
  name?: string;
  branch_type?: string;
  is_current?: boolean;
  last_commit_date?: string;
}

export function sourceKey(source: WorktreeLaunchSource): string {
  return [
    source.kind,
    source.sourceRef ?? "",
    source.baseBranch ?? "",
    source.label,
  ].join(":");
}

/**
 * Map raw `getGitBranches` rows to `WorktreeBranchOption`s. Drops entries
 * without a usable name and de-duplicates by name (keeping the first, which —
 * after sorting upstream is not guaranteed — is fine because names are unique
 * across local/remote in git's short-ref form).
 */
export function toBranchOptions(
  branches: readonly RawGitBranch[] | undefined | null
): WorktreeBranchOption[] {
  if (!branches) return [];
  const seen = new Set<string>();
  const options: WorktreeBranchOption[] = [];
  for (const branch of branches) {
    const name = branch.name?.trim();
    if (!name) continue;
    if (name === "HEAD" || name.includes("HEAD ->")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({
      name,
      isRemote: branch.branch_type === "remote",
      isCurrent: Boolean(branch.is_current),
      lastCommitDate: branch.last_commit_date || undefined,
    });
  }
  return options;
}

/**
 * Adapt cached `Branch` rows (the shape stored in the shared
 * `branchCacheAtom` / written by `useBranchFetch`) into
 * `WorktreeBranchOption`s. Lets the worktree picker reuse the app-wide branch
 * cache instead of maintaining a second one. Drops entries without a usable
 * name and de-duplicates by name (git short-refs are unique across
 * local/remote), mirroring `toBranchOptions`.
 */
export function branchCacheEntryToOptions(
  branches: readonly Branch[] | undefined | null
): WorktreeBranchOption[] {
  if (!branches) return [];
  const seen = new Set<string>();
  const options: WorktreeBranchOption[] = [];
  for (const branch of branches) {
    const name = branch.name?.trim();
    if (!name) continue;
    if (name === "HEAD" || name.includes("HEAD ->")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({
      name,
      isRemote: Boolean(branch.isRemote),
      isCurrent: Boolean(branch.isCurrent),
      lastCommitDate: branch.lastCommitDate || undefined,
    });
  }
  return options;
}

/**
 * Sort so the picker surfaces the most useful branches first:
 * current branch → locals → remotes, then most-recent commit, then alpha.
 */
export function sortBranchOptions(
  options: readonly WorktreeBranchOption[]
): WorktreeBranchOption[] {
  return [...options].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
    if (
      a.lastCommitDate &&
      b.lastCommitDate &&
      a.lastCommitDate !== b.lastCommitDate
    ) {
      return (
        new Date(b.lastCommitDate).getTime() -
        new Date(a.lastCommitDate).getTime()
      );
    }
    if (a.lastCommitDate && !b.lastCommitDate) return -1;
    if (!a.lastCommitDate && b.lastCommitDate) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Case-insensitive substring filter over branch names. */
export function filterBranchOptions(
  options: readonly WorktreeBranchOption[],
  query: string
): WorktreeBranchOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...options];
  return options.filter((option) =>
    option.name.toLowerCase().includes(normalized)
  );
}

/**
 * A trimmed, non-empty query is offered as a custom ref **unless** it exactly
 * matches an existing branch name (in which case the real branch row already
 * covers it). This keeps the "Base branch or ref" escape hatch — tags, commit
 * shas, and any git-resolvable ref stay usable when no branch matches.
 */
export function shouldOfferCustomRef(
  query: string,
  options: readonly WorktreeBranchOption[]
): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return !options.some((option) => option.name === trimmed);
}

/** Build a `branch` launch source from a picked branch option. */
export function branchToLaunchSource(
  option: WorktreeBranchOption
): WorktreeLaunchSource {
  if (option.worktreePath) {
    return {
      kind: "worktree",
      label: `Worktree: ${compactText(option.name, 34)}`,
      baseBranch: option.name,
      sourceRef: `worktree:${option.worktreePath}`,
      title: option.name,
      existingWorktreePath: option.worktreePath,
    };
  }
  return refToLaunchSource(option.name);
}

/**
 * Build a `branch` launch source from an arbitrary user-entered ref. Returns
 * null for an empty / whitespace-only input.
 */
export function customRefToLaunchSource(
  input: string
): WorktreeLaunchSource | null {
  const ref = input.trim();
  if (!ref) return null;
  return refToLaunchSource(ref);
}

function refToLaunchSource(ref: string): WorktreeLaunchSource {
  return {
    kind: "branch",
    label: `Branch: ${compactText(ref, 36)}`,
    baseBranch: ref,
    sourceRef: `branch:${ref}`,
    title: ref,
  };
}

/** Section key for a grouped branch list (mirrors the Spotlight selector). */
export type BranchGroupKey = "recent" | "worktrees" | "other";

/** A labelled section of branch options for the grouped Branch-tab list. */
export interface BranchOptionGroup {
  key: BranchGroupKey;
  /**
   * i18n label key under `selectors.branch.labels` (common namespace) —
   * `recent` → "Recent", `worktrees` → "Worktrees", `otherBranches` → "Other
   * Branches". Reuses the same section labels the Spotlight branch selector
   * renders so the two pickers stay in sync.
   */
  labelKey: "recent" | "worktrees" | "otherBranches";
  options: WorktreeBranchOption[];
}

const DEFAULT_BRANCH_NAMES = ["main", "master", "develop", "dev"] as const;

function isDefaultBranch(option: WorktreeBranchOption): boolean {
  return DEFAULT_BRANCH_NAMES.includes(
    option.name.toLowerCase() as (typeof DEFAULT_BRANCH_NAMES)[number]
  );
}

/**
 * Group branch options into **Recent** / **Worktrees** / **Other** sections,
 * reusing the exact bucketing (`categorizeBranches`) the Spotlight
 * `BranchPalette` / `BranchDropdown` use — so the worktree-source picker and
 * the "Switch Session Branch" selector categorise identically.
 *
 * `worktreePaths` (branch name → worktree path, from `getGitWorktrees`) is
 * merged onto matching **local** options so they land in the Worktrees bucket.
 * The current branch and conventional default branches are promoted to the
 * top of Recent. Remaining `default` + `other` branches are flattened into a
 * single "Other Branches" tail (same as `BranchDropdown`).
 */
export function groupBranchOptions(
  options: readonly WorktreeBranchOption[],
  worktreePaths?: ReadonlyMap<string, string>,
  currentBranchName?: string
): BranchOptionGroup[] {
  const normalizedCurrentBranchName = currentBranchName?.trim();
  const withPaths: WorktreeBranchOption[] = options.map((option) => {
    const worktreePath = worktreePaths?.get(option.name);
    const isCurrent =
      option.isCurrent || option.name === normalizedCurrentBranchName;
    return worktreePath || isCurrent !== option.isCurrent
      ? { ...option, isCurrent, ...(worktreePath ? { worktreePath } : {}) }
      : option;
  });

  const categorized = categorizeBranches(withPaths);
  const groups: BranchOptionGroup[] = [];

  const preferred = sortBranchOptions(
    withPaths.filter((option) => option.isCurrent)
  );
  const preferredNames = new Set(preferred.map((option) => option.name));
  for (const option of sortBranchOptions(withPaths.filter(isDefaultBranch))) {
    if (!preferredNames.has(option.name)) {
      preferred.push(option);
      preferredNames.add(option.name);
    }
  }

  const recent = [
    ...preferred,
    ...categorized.recent.filter((option) => !preferredNames.has(option.name)),
  ];

  if (recent.length > 0) {
    groups.push({
      key: "recent",
      labelKey: "recent",
      options: recent,
    });
  }
  const worktrees = categorized.worktrees.filter(
    (option) => !preferredNames.has(option.name)
  );
  if (worktrees.length > 0) {
    groups.push({
      key: "worktrees",
      labelKey: "worktrees",
      options: worktrees,
    });
  }
  const tail = [...categorized.default, ...categorized.other].filter(
    (option) => !preferredNames.has(option.name)
  );
  if (tail.length > 0) {
    groups.push({ key: "other", labelKey: "otherBranches", options: tail });
  }

  return groups;
}

/**
 * Relative "last commit" timestamp for a branch row (e.g. "Yesterday",
 * "4 hr ago", "2 days ago"). Reuses the shared `formatRelativeTime` "short"
 * style — the same formatter the Spotlight branch selector uses for its
 * right-aligned timestamps. Returns "" when the branch has no commit date.
 */
export function formatBranchTimestamp(option: WorktreeBranchOption): string {
  return option.lastCommitDate
    ? formatRelativeTime(option.lastCommitDate, "short")
    : "";
}
