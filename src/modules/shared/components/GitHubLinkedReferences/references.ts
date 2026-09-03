import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";
import type { WorkItem } from "@src/types/core/workItem";

export type GitHubReferenceKind = "issue" | "pr" | "unknown";

export interface ExtractedGitHubReference {
  repoFullName: string | null;
  number: number;
  kind: GitHubReferenceKind;
  source: string;
}

export interface ResolvedGitHubReference {
  repoFullName: string | null;
  number: number;
  kind: GitHubReferenceKind;
  title: string;
  state: string | null;
  htmlUrl: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  error: boolean;
}

interface LoadGitHubReferencesOptions {
  defaultRepoFullName?: string | null;
  resolveDefaultRepoFullName?: () => Promise<string | null>;
  getIssue: (repoFullName: string, issueNumber: number) => Promise<GitHubIssue>;
  concurrency?: number;
}

const GITHUB_REFERENCE_PATTERN =
  /https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/(issues|pull)\/(\d+)|\b([\w.-]+)\/([\w.-]+)#(\d+)\b|(^|[^\w./-])#(\d+)\b/gim;

function normalizeRepoFullName(owner: string, repo: string): string {
  return `${owner}/${repo.replace(/\.git$/i, "")}`;
}

function referenceKey(reference: ExtractedGitHubReference): string {
  return `${reference.repoFullName?.toLowerCase() ?? "current"}#${reference.number}`;
}

export function parseGitHubRepoFromItemUrl(url: string): string | null {
  const match = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/(?:issues|pull)\/\d+/i
  );
  return match ? normalizeRepoFullName(match[1], match[2]) : null;
}

/** Build the searchable prose shared by every Work Item detail host. */
export function getWorkItemReferenceText(
  workItem: Pick<WorkItem, "spec" | "comments">,
  additionalText: readonly (string | null | undefined)[] = []
): string {
  return [
    workItem.spec,
    ...(workItem.comments ?? []).map((comment) => comment.content),
    ...additionalText,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

/** Build the searchable prose shared by every GitHub Issue detail host. */
export function getIssueReferenceText(
  issue: Pick<GitHubIssue, "body">,
  timeline: readonly Pick<GitHubIssueTimelineItem, "body">[]
): string {
  return [issue.body, ...timeline.map((item) => item.body)]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

/** Extract GitHub URLs, `owner/repo#123`, and same-repo `#123` references. */
export function extractGitHubReferences(
  text: string,
  options?: {
    defaultRepoFullName?: string | null;
    exclude?: { repoFullName: string; number: number };
  }
): ExtractedGitHubReference[] {
  const references: ExtractedGitHubReference[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(GITHUB_REFERENCE_PATTERN)) {
    let repoFullName: string | null = null;
    let number = 0;
    let kind: GitHubReferenceKind = "unknown";
    let source = match[0];

    if (match[1] && match[2] && match[3] && match[4]) {
      repoFullName = normalizeRepoFullName(match[1], match[2]);
      number = Number(match[4]);
      kind = match[3].toLowerCase() === "pull" ? "pr" : "issue";
    } else if (match[5] && match[6] && match[7]) {
      repoFullName = normalizeRepoFullName(match[5], match[6]);
      number = Number(match[7]);
    } else if (match[9]) {
      repoFullName = options?.defaultRepoFullName ?? null;
      number = Number(match[9]);
      const prefix = match[8] ?? "";
      source = match[0].slice(prefix.length);
    }

    if (!Number.isSafeInteger(number) || number <= 0) continue;
    if (
      options?.exclude &&
      repoFullName?.toLowerCase() ===
        options.exclude.repoFullName.toLowerCase() &&
      number === options.exclude.number
    ) {
      continue;
    }

    const reference = { repoFullName, number, kind, source };
    const key = referenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }

  return references;
}

function fallbackUrl(
  repoFullName: string | null,
  number: number,
  kind: GitHubReferenceKind
): string | null {
  if (!repoFullName) return null;
  const path = kind === "pr" ? "pull" : "issues";
  return `https://github.com/${repoFullName}/${path}/${number}`;
}

function isPullRequestUrl(url: string): boolean {
  return /\/pull\/\d+(?:[/?#]|$)/i.test(url);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapItem(items[index]);
      }
    })
  );

  return results;
}

/** Resolve reference metadata on demand, with bounded GitHub request fan-out. */
export async function loadGitHubReferences(
  references: readonly ExtractedGitHubReference[],
  {
    defaultRepoFullName,
    resolveDefaultRepoFullName,
    getIssue,
    concurrency = 4,
  }: LoadGitHubReferencesOptions
): Promise<ResolvedGitHubReference[]> {
  let resolvedDefaultRepo = defaultRepoFullName ?? null;
  if (
    !resolvedDefaultRepo &&
    references.some((reference) => !reference.repoFullName) &&
    resolveDefaultRepoFullName
  ) {
    try {
      resolvedDefaultRepo = await resolveDefaultRepoFullName();
    } catch {
      resolvedDefaultRepo = null;
    }
  }

  const concreteReferences = Array.from(
    references
      .reduce((resolved, reference) => {
        const concrete = {
          ...reference,
          repoFullName: reference.repoFullName ?? resolvedDefaultRepo,
        };
        const key = referenceKey(concrete);
        if (!resolved.has(key)) resolved.set(key, concrete);
        return resolved;
      }, new Map<string, ExtractedGitHubReference>())
      .values()
  );

  return mapWithConcurrency(
    concreteReferences,
    concurrency,
    async (reference): Promise<ResolvedGitHubReference> => {
      const unresolvedUrl = fallbackUrl(
        reference.repoFullName,
        reference.number,
        reference.kind
      );
      if (!reference.repoFullName) {
        return {
          ...reference,
          title: reference.source,
          state: null,
          htmlUrl: null,
          authorLogin: null,
          authorAvatarUrl: null,
          error: true,
        };
      }

      try {
        const item = await getIssue(reference.repoFullName, reference.number);
        return {
          ...reference,
          kind: isPullRequestUrl(item.html_url) ? "pr" : "issue",
          title: item.title,
          state: item.state,
          htmlUrl: item.html_url,
          authorLogin: item.user.login,
          authorAvatarUrl: item.user.avatar_url,
          error: false,
        };
      } catch {
        return {
          ...reference,
          title: reference.source,
          state: null,
          htmlUrl: unresolvedUrl,
          authorLogin: null,
          authorAvatarUrl: null,
          error: true,
        };
      }
    }
  );
}
