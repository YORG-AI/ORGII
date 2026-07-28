import type { OpsGitHubQueryState } from "./githubWorkItemsViewCache";

export const GITHUB_QUERY_SCOPE = {
  ALL: "all",
  ISSUE: "issue",
  PR: "pr",
} as const;

export const GITHUB_QUERY_STATE = {
  ALL: "all",
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
} as const;

export type GitHubQueryScope =
  (typeof GITHUB_QUERY_SCOPE)[keyof typeof GITHUB_QUERY_SCOPE];
export type GitHubQueryState =
  (typeof GITHUB_QUERY_STATE)[keyof typeof GITHUB_QUERY_STATE];
export type GitHubIssuePageState = "open" | "closed";

export interface ParsedGitHubSearchQuery {
  scope: GitHubQueryScope;
  state: OpsGitHubQueryState | null;
  labels: string[];
  author: string | null;
  assignee: string | null;
  freeText: string;
}

interface GitHubSearchToken {
  value: string;
  raw: string;
}

function tokenizeGitHubSearchQuery(rawQuery: string): GitHubSearchToken[] {
  const tokens: GitHubSearchToken[] = [];
  let value = "";
  let raw = "";
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (!value && !raw) return;
    tokens.push({ value, raw });
    value = "";
    raw = "";
  };

  for (const char of rawQuery) {
    if (/\s/.test(char) && quote === null) {
      flush();
      continue;
    }
    raw += char;
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    value += char;
  }
  flush();
  return tokens;
}

function serializeGitHubTokenValue(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function serializeGitHubSearchQuery(
  query: ParsedGitHubSearchQuery
): string {
  const parts: string[] = [];
  if (query.scope === GITHUB_QUERY_SCOPE.ISSUE) parts.push("is:issue");
  if (query.scope === GITHUB_QUERY_SCOPE.PR) parts.push("is:pr");
  if (query.state === GITHUB_QUERY_STATE.OPEN) parts.push("is:open");
  if (query.state === GITHUB_QUERY_STATE.CLOSED) parts.push("is:closed");
  if (query.state === GITHUB_QUERY_STATE.MERGED) parts.push("is:merged");
  if (query.state === GITHUB_QUERY_STATE.ALL) parts.push("state:all");
  if (query.assignee)
    parts.push(`assignee:${serializeGitHubTokenValue(query.assignee)}`);
  if (query.author)
    parts.push(`author:${serializeGitHubTokenValue(query.author)}`);
  for (const label of query.labels) {
    parts.push(`label:${serializeGitHubTokenValue(label)}`);
  }
  if (query.freeText) parts.push(query.freeText);
  return parts.join(" ");
}

export function parseGitHubSearchQuery(
  rawQuery: string
): ParsedGitHubSearchQuery {
  const query: ParsedGitHubSearchQuery = {
    scope: GITHUB_QUERY_SCOPE.ALL,
    state: null,
    labels: [],
    author: null,
    assignee: null,
    freeText: "",
  };
  const freeTextTokens: string[] = [];
  let sawIssueScope = false;
  let sawPrScope = false;

  for (const { value: token, raw } of tokenizeGitHubSearchQuery(
    rawQuery.trim()
  )) {
    const normalized = token.toLowerCase();
    if (normalized === "is:issue") {
      sawIssueScope = true;
      query.scope = sawPrScope
        ? GITHUB_QUERY_SCOPE.ALL
        : GITHUB_QUERY_SCOPE.ISSUE;
      continue;
    }
    if (normalized === "is:pr" || normalized === "is:pull-request") {
      sawPrScope = true;
      query.scope = sawIssueScope
        ? GITHUB_QUERY_SCOPE.ALL
        : GITHUB_QUERY_SCOPE.PR;
      continue;
    }
    if (normalized === "is:open") {
      query.state = GITHUB_QUERY_STATE.OPEN;
      continue;
    }
    if (normalized === "is:closed") {
      query.state = GITHUB_QUERY_STATE.CLOSED;
      continue;
    }
    if (normalized === "is:merged") {
      query.scope = GITHUB_QUERY_SCOPE.PR;
      query.state = GITHUB_QUERY_STATE.MERGED;
      continue;
    }

    const [rawKey, ...rest] = token.split(":");
    const qualifierValue = rest.join(":").trim();
    const key = rawKey.toLowerCase();
    if (!qualifierValue) {
      freeTextTokens.push(raw);
      continue;
    }
    if (key === "label") {
      query.labels.push(qualifierValue);
      continue;
    }
    if (key === "author") {
      query.author = qualifierValue;
      continue;
    }
    if (key === "assignee") {
      query.assignee = qualifierValue;
      continue;
    }
    if (key === "state") {
      const normalizedValue = qualifierValue.toLowerCase();
      if (
        normalizedValue === GITHUB_QUERY_STATE.OPEN ||
        normalizedValue === GITHUB_QUERY_STATE.CLOSED ||
        normalizedValue === GITHUB_QUERY_STATE.MERGED ||
        normalizedValue === GITHUB_QUERY_STATE.ALL
      ) {
        query.state = normalizedValue;
        continue;
      }
    }
    freeTextTokens.push(raw);
  }

  query.freeText = freeTextTokens.join(" ").trim();
  return query;
}

export function getIssuePageStatesForQuery(
  query: ParsedGitHubSearchQuery
): GitHubIssuePageState[] {
  if (query.scope === GITHUB_QUERY_SCOPE.PR) return [];
  if (query.state === GITHUB_QUERY_STATE.OPEN) return ["open"];
  if (query.state === GITHUB_QUERY_STATE.CLOSED) return ["closed"];
  return ["open", "closed"];
}
