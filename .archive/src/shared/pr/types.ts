/**
 * Single normalized pull-request domain type shared across surfaces.
 *
 * The app fetches PRs in several raw shapes — `LocalFindPRResponse` and
 * `LocalPRResponse` (Tauri GitHub API), the loosely-typed `getPRLocal` JSON,
 * `ProofOfWork.pr_*` (agent workflow), and the inline `PrDetail` the
 * WorkStation card used to declare. Rather than thread those near-duplicate
 * shapes around, normalize each at its fetch boundary into this type.
 *
 * Only `url` and `status` are guaranteed; richer fields (number, title, diff
 * stats, branches) are optional so partial sources (e.g. `ProofOfWork`, which
 * only carries a URL + status) can be represented without inventing data.
 */
import { normalizePrStatus } from "./prStatus";

export interface NormalizedPullRequest {
  /** PR web URL (GitHub `html_url`). */
  url: string;
  /** Normalized status — one of the {@link PrStatus} values for known states. */
  status: string;
  /** PR number, when known. */
  number?: number;
  /** PR title, when known. */
  title?: string;
  /** Additions count from the diff, when known. */
  additions?: number;
  /** Deletions count from the diff, when known. */
  deletions?: number;
  /** Number of changed files, when known. */
  changedFiles?: number;
  /** Head / source branch, when known. */
  sourceBranch?: string;
  /** Base / target branch, when known. */
  targetBranch?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Map a loosely-typed GitHub PR JSON object (as returned by `getPRLocal`) into
 * a {@link NormalizedPullRequest}. `merged` / `draft` booleans override the raw
 * `state` via {@link normalizePrStatus}. Pass `fallback` to supply a url/number
 * parsed from the PR link when the JSON omits them.
 */
export function toNormalizedPullRequest(
  raw: Record<string, unknown>,
  fallback?: { url?: string; number?: number }
): NormalizedPullRequest {
  return {
    url: asString(raw["html_url"]) ?? fallback?.url ?? "",
    status: normalizePrStatus({
      state: asString(raw["state"]),
      merged: Boolean(raw["merged"]),
      draft: Boolean(raw["draft"]),
    }),
    number: asNumber(raw["number"]) ?? fallback?.number,
    title: asString(raw["title"]),
    additions: asNumber(raw["additions"]),
    deletions: asNumber(raw["deletions"]),
    changedFiles: asNumber(raw["changed_files"]),
  };
}
