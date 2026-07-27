/**
 * Pure logic for the WorktreeSourceModal **Smart** tab — a single "unified
 * smart input" (inspired by orca's smart page) that identifies what the user
 * typed and produces a mixed suggestion list (PR / branch / name / custom ref).
 *
 * Extracted here so the classification + suggestion-merge logic is unit-testable
 * without React, the git HTTP client, or the GitHub Tauri commands. The modal
 * owns data fetching, icon mapping, i18n, and the PR-resolve confirm flow; this
 * module only turns `(query, loaded data)` into ordered, launch-ready
 * suggestions.
 */
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  type WorktreeBranchOption,
  branchToLaunchSource,
  compactText,
  customRefToLaunchSource,
  filterBranchOptions,
  shouldOfferCustomRef,
  sourceKey,
} from "./worktreeBranchSource";

/**
 * PR head/base metadata needed to resolve a concrete git base ref at confirm
 * time via `worktree_resolve_pr_base`. Shared with the modal (GitHub tab uses
 * the same shape) so the confirm flow is not duplicated.
 */
export interface PrResolveMeta {
  prNumber: number;
  headBranch?: string;
  baseBranch?: string;
}

/** Visual/semantic category of a smart suggestion — drives the row icon. */
export type SmartSuggestionKind =
  | "pr"
  | "issue"
  | "branch"
  | "name"
  | "customRef";

/** One row in the smart mixed-suggestion list. */
export interface SmartSuggestion {
  /** Stable list key. */
  id: string;
  kind: SmartSuggestionKind;
  /** The launch source produced when this row is confirmed. */
  source: WorktreeLaunchSource;
  /** Primary row label. */
  title: string;
  /** Secondary row label (English default, mirrors the other tabs). */
  detail: string;
  /** Present for `pr` rows only — enables `worktree_resolve_pr_base`. */
  pr?: PrResolveMeta;
}

/** Slim PR shape the smart logic needs (mapped from `OpenPRItem`). */
export interface SmartPrInput {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
}

/** Slim issue shape the smart logic needs (mapped from `GitHubIssue`). */
export interface SmartIssueInput {
  number: number;
  title: string;
}

/** Loaded data + repo context the smart builder merges the query against. */
export interface SmartSuggestionSources {
  prs: readonly SmartPrInput[];
  issues: readonly SmartIssueInput[];
  branches: readonly WorktreeBranchOption[];
  /** Current branch (base for smart/name suggestions). */
  branchName?: string;
  /** Repo display name (label for the repo-HEAD smart default row). */
  repoName?: string;
  /** Origin `owner/repo`, used to decide if a PR reference is resolvable. */
  repoFullName?: string;
}

export interface SmartSuggestionLimits {
  /** Max recent PRs in the empty-query default list. */
  prs: number;
  /** Max branches in the empty-query default list. */
  branches: number;
  /** Max total rows returned. */
  total: number;
}

export const DEFAULT_SMART_LIMITS: SmartSuggestionLimits = {
  prs: 5,
  branches: 6,
  total: 40,
};

/** Syntactic classification of the raw input (data-independent). */
export type SmartInputParse =
  | { type: "empty" }
  | { type: "prNumber"; number: number; hash: boolean }
  | { type: "crossRepoPr"; owner: string; repo: string; number: number }
  | {
      type: "prUrl";
      provider: "github" | "gitlab";
      host: string;
      owner: string;
      repo: string;
      number: number;
      resource: "pull" | "merge_request" | "issue";
    }
  | { type: "text"; value: string };

const CROSS_REPO_PR_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const HASH_NUMBER_RE = /^#(\d+)$/;
const PURE_DIGITS_RE = /^(\d+)$/;
const GITHUB_PULL_URL_RE =
  /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
const GITHUB_ISSUE_URL_RE =
  /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i;
const GITLAB_MR_URL_RE =
  /^https?:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)/i;

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function parsePrUrl(input: string): SmartInputParse | null {
  const pull = input.match(GITHUB_PULL_URL_RE);
  if (pull && Number(pull[4]) > 0) {
    return {
      type: "prUrl",
      provider: "github",
      host: pull[1],
      owner: pull[2],
      repo: stripGitSuffix(pull[3]),
      number: Number(pull[4]),
      resource: "pull",
    };
  }

  const issue = input.match(GITHUB_ISSUE_URL_RE);
  if (issue && Number(issue[4]) > 0) {
    return {
      type: "prUrl",
      provider: "github",
      host: issue[1],
      owner: issue[2],
      repo: stripGitSuffix(issue[3]),
      number: Number(issue[4]),
      resource: "issue",
    };
  }

  const mr = input.match(GITLAB_MR_URL_RE);
  if (mr && Number(mr[3]) > 0) {
    const path = mr[2];
    const parts = path.split("/").filter(Boolean);
    const repo = stripGitSuffix(parts.pop() || path);
    const owner = parts.join("/");
    return {
      type: "prUrl",
      provider: "gitlab",
      host: mr[1],
      owner,
      repo,
      number: Number(mr[3]),
      resource: "merge_request",
    };
  }

  return null;
}

/**
 * Classify the raw input by priority: empty → PR/MR URL → `owner/repo#123` →
 * `#123` → pure digits → free text. URLs are checked first because they contain
 * both `/` and `#`-like separators that later patterns would misread.
 */
export function parseSmartInput(raw: string): SmartInputParse {
  const trimmed = raw.trim();
  if (!trimmed) return { type: "empty" };

  const url = parsePrUrl(trimmed);
  if (url) return url;

  const cross = trimmed.match(CROSS_REPO_PR_RE);
  if (cross && Number(cross[3]) > 0) {
    return {
      type: "crossRepoPr",
      owner: cross[1],
      repo: stripGitSuffix(cross[2]),
      number: Number(cross[3]),
    };
  }

  const hash = trimmed.match(HASH_NUMBER_RE);
  if (hash && Number(hash[1]) > 0) {
    return { type: "prNumber", number: Number(hash[1]), hash: true };
  }

  const digits = trimmed.match(PURE_DIGITS_RE);
  if (digits && Number(digits[1]) > 0) {
    return { type: "prNumber", number: Number(digits[1]), hash: false };
  }

  return { type: "text", value: trimmed };
}

const NAME_LABEL_MAX = 36;

function normalizeBase(branchName?: string): string | undefined {
  return branchName?.trim() || undefined;
}

/** Slug a free-text worktree name into a stable `name:<slug>` sourceRef seed. */
export function slugFragment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  return slug || "worktree";
}

/**
 * Build a `name` launch source from free text. Shared by the smart tab and the
 * Name tab so the slug + label formatting stay identical. Returns null for
 * empty / whitespace input.
 */
export function nameToLaunchSource(
  name: string,
  branchName?: string
): WorktreeLaunchSource | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return {
    kind: "name",
    label: `Name: ${compactText(trimmed, NAME_LABEL_MAX)}`,
    baseBranch: normalizeBase(branchName),
    sourceRef: `name:${slugFragment(trimmed)}`,
    title: trimmed,
  };
}

// ---------------------------------------------------------------------------
// Suggestion builders
// ---------------------------------------------------------------------------

function prSuggestion(pr: SmartPrInput): SmartSuggestion {
  const label = compactText(`#${pr.number} ${pr.title}`);
  return {
    id: `pr:${pr.number}`,
    kind: "pr",
    source: {
      kind: "github",
      label,
      baseBranch: pr.headBranch || pr.baseBranch || undefined,
      sourceRef: `pr:${pr.number}`,
      title: pr.title,
    },
    title: label,
    detail: `${pr.headBranch} -> ${pr.baseBranch}`,
    pr: {
      prNumber: pr.number,
      headBranch: pr.headBranch || undefined,
      baseBranch: pr.baseBranch || undefined,
    },
  };
}

/**
 * PR suggestion for a bare number reference (`#123`). Enriches with the fetched
 * PR's title/head/base when it is in the loaded list; otherwise a generic row
 * that `worktree_resolve_pr_base` can still resolve by number via
 * `refs/pull/<n>/head`.
 */
function prNumberSuggestion(
  number: number,
  sources: SmartSuggestionSources
): SmartSuggestion {
  const match = sources.prs.find((pr) => pr.number === number);
  if (match) return prSuggestion(match);
  return {
    id: `pr:${number}`,
    kind: "pr",
    source: {
      kind: "github",
      label: `#${number}`,
      sourceRef: `pr:${number}`,
      title: `PR #${number}`,
    },
    title: `#${number}`,
    detail: "Pull request",
    pr: { prNumber: number },
  };
}

function issueSuggestion(issue: SmartIssueInput): SmartSuggestion {
  const label = compactText(`#${issue.number} ${issue.title}`);
  return {
    id: `issue:${issue.number}`,
    kind: "issue",
    source: {
      kind: "github",
      label,
      sourceRef: `issue:${issue.number}`,
      title: issue.title,
    },
    title: label,
    detail: "Issue",
  };
}

function branchSuggestion(option: WorktreeBranchOption): SmartSuggestion {
  return {
    id: `branch:${option.name}`,
    kind: "branch",
    source: branchToLaunchSource(option),
    title: option.name,
    detail: option.isRemote ? "Remote branch" : "Local branch",
  };
}

function customRefSuggestion(query: string): SmartSuggestion | null {
  const source = customRefToLaunchSource(query);
  if (!source) return null;
  const ref = query.trim();
  return {
    id: `customRef:${ref}`,
    kind: "customRef",
    source,
    title: `Use "${ref}" as ref`,
    detail: "Tag, commit, or any git ref",
  };
}

function nameSuggestion(
  query: string,
  branchName?: string
): SmartSuggestion | null {
  const source = nameToLaunchSource(query, branchName);
  if (!source) return null;
  return {
    id: `name:${source.sourceRef}`,
    kind: "name",
    source,
    title: compactText(query, NAME_LABEL_MAX),
    detail: "New worktree name",
  };
}

/**
 * A PR/MR reference that cannot be resolved to a git base from this repo
 * (cross-repo, foreign host, or GitLab — the backend only fetches
 * `refs/pull/<n>/head` on origin). We parse it and keep it launchable as a
 * **named** worktree (isolate from HEAD, no fabricated base) and say so in the
 * detail — honest per the "don't fake a base" constraint.
 */
function foreignReferenceSuggestion(
  parse: Extract<SmartInputParse, { type: "crossRepoPr" | "prUrl" }>,
  sources: SmartSuggestionSources
): SmartSuggestion | null {
  const marker =
    parse.type === "prUrl" && parse.provider === "gitlab" ? "!" : "#";
  const refLabel = `${parse.owner ? `${parse.owner}/` : ""}${parse.repo}${marker}${parse.number}`;
  const base = nameToLaunchSource(
    `${parse.repo}-${parse.number}`,
    sources.branchName
  );
  if (!base) return null;
  return {
    id: `ref:${refLabel}`,
    kind: "name",
    source: { ...base, title: refLabel },
    title: refLabel,
    detail: "Reference — base not resolvable here; creates a named worktree",
  };
}

// ---------------------------------------------------------------------------
// Default (empty-query) suggestions
// ---------------------------------------------------------------------------

function defaultSuggestions(
  sources: SmartSuggestionSources,
  limits: SmartSuggestionLimits
): SmartSuggestion[] {
  return [
    ...sources.prs.slice(0, limits.prs).map(prSuggestion),
    ...sources.branches.slice(0, limits.branches).map(branchSuggestion),
  ];
}

// ---------------------------------------------------------------------------
// Free-text mixed suggestions (scored)
// ---------------------------------------------------------------------------

interface Scored {
  suggestion: SmartSuggestion;
  score: number;
}

function textSuggestions(
  query: string,
  sources: SmartSuggestionSources
): SmartSuggestion[] {
  const lower = query.toLowerCase();
  const scored: Scored[] = [];

  for (const pr of sources.prs) {
    const hay =
      `#${pr.number} ${pr.title} ${pr.headBranch} ${pr.baseBranch}`.toLowerCase();
    if (!hay.includes(lower)) continue;
    const exact = `#${pr.number}` === query || String(pr.number) === query;
    scored.push({
      suggestion: prSuggestion(pr),
      score: exact
        ? 0
        : `#${pr.number} ${pr.title}`.toLowerCase().startsWith(lower)
          ? 1
          : 2,
    });
  }

  for (const issue of sources.issues) {
    const hay = `#${issue.number} ${issue.title}`.toLowerCase();
    if (!hay.includes(lower)) continue;
    scored.push({ suggestion: issueSuggestion(issue), score: 2 });
  }

  for (const branch of filterBranchOptions(sources.branches, query)) {
    const name = branch.name.toLowerCase();
    scored.push({
      suggestion: branchSuggestion(branch),
      score: name === lower ? 0 : name.startsWith(lower) ? 1 : 2,
    });
  }

  if (shouldOfferCustomRef(query, sources.branches)) {
    const custom = customRefSuggestion(query);
    if (custom) scored.push({ suggestion: custom, score: 2.5 });
  }

  const name = nameSuggestion(query, sources.branchName);
  if (name) scored.push({ suggestion: name, score: 3 });

  return scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) =>
      a.score !== b.score ? a.score - b.score : a.index - b.index
    )
    .map((entry) => entry.suggestion);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Turn the raw query + loaded data into an ordered, de-duplicated mixed
 * suggestion list. Exact matches (branch name / PR number) float to the top;
 * free text always keeps a trailing "name" fallback so the input is never a
 * dead end.
 */
export function buildSmartSuggestions(
  raw: string,
  sources: SmartSuggestionSources,
  limits: SmartSuggestionLimits = DEFAULT_SMART_LIMITS
): SmartSuggestion[] {
  const parse = parseSmartInput(raw);
  let suggestions: SmartSuggestion[];

  switch (parse.type) {
    case "empty":
      suggestions = defaultSuggestions(sources, limits);
      break;

    case "prNumber": {
      const rows: SmartSuggestion[] = [
        prNumberSuggestion(parse.number, sources),
      ];
      const issue = sources.issues.find((i) => i.number === parse.number);
      if (issue) rows.push(issueSuggestion(issue));
      suggestions = rows;
      break;
    }

    case "crossRepoPr": {
      const isOrigin =
        !!sources.repoFullName &&
        `${parse.owner}/${parse.repo}`.toLowerCase() ===
          sources.repoFullName.toLowerCase();
      const foreign = foreignReferenceSuggestion(parse, sources);
      suggestions = isOrigin
        ? [prNumberSuggestion(parse.number, sources)]
        : foreign
          ? [foreign]
          : [];
      break;
    }

    case "prUrl": {
      const isOrigin =
        parse.provider === "github" &&
        !!sources.repoFullName &&
        `${parse.owner}/${parse.repo}`.toLowerCase() ===
          sources.repoFullName.toLowerCase();
      if (parse.resource === "issue") {
        if (isOrigin) {
          const issue = sources.issues.find(
            (i) => i.number === parse.number
          ) ?? {
            number: parse.number,
            title: `#${parse.number}`,
          };
          suggestions = [issueSuggestion(issue)];
        } else {
          const foreign = foreignReferenceSuggestion(parse, sources);
          suggestions = foreign ? [foreign] : [];
        }
      } else if (isOrigin) {
        suggestions = [prNumberSuggestion(parse.number, sources)];
      } else {
        const foreign = foreignReferenceSuggestion(parse, sources);
        suggestions = foreign ? [foreign] : [];
      }
      break;
    }

    case "text":
    default:
      suggestions = textSuggestions(
        parse.type === "text" ? parse.value : raw,
        sources
      );
      break;
  }

  const seen = new Set<string>();
  const deduped: SmartSuggestion[] = [];
  for (const suggestion of suggestions) {
    const key = sourceKey(suggestion.source);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(suggestion);
  }
  return deduped.slice(0, limits.total);
}
