import { normalizeRepoScopeKey } from "./collabSyncUtils";
import {
  peekMatchingOrgRepoScope,
  peekShareableScopeKeys,
  primeShareableScopeKey,
} from "./repoScopeResolver";

export interface OrgScopeFilterRepo {
  repo_url?: string | null;
  fs_uri?: string | null;
}

type ScopeKeysPeek = (input: string) => string[] | null | undefined;
type ScopePrime = (input: string) => void;
type ScopeMatcher = (
  repoScopeKeys: string[] | null | undefined,
  orgScopes: string[] | null | undefined
) => string | null | undefined;

function stripFileScheme(path: string): string {
  return path.startsWith("file://") ? path.slice("file://".length) : path;
}

export function getRepoScopeKeysForOrgFilter(
  repo: OrgScopeFilterRepo,
  peekKeys: ScopeKeysPeek = peekShareableScopeKeys
): string[] | null | undefined {
  // fs_uri resolves ALL of a checkout's remotes (origin + upstream), so a
  // fork whose upstream hits the org scope matches; repo_url is a single
  // remote and only a fallback when there is no checkout path.
  if (repo.fs_uri) return peekKeys(stripFileScheme(repo.fs_uri));
  if (repo.repo_url) {
    const key = normalizeRepoScopeKey(repo.repo_url);
    return key ? [key] : null;
  }
  return null;
}

function evaluateOrgScope(
  repo: OrgScopeFilterRepo,
  orgScopes: string[] | undefined,
  unresolvedResult: boolean,
  peekKeys: ScopeKeysPeek,
  prime: ScopePrime,
  match: ScopeMatcher
): boolean {
  if (!orgScopes || orgScopes.length === 0) return false;
  const keys = getRepoScopeKeysForOrgFilter(repo, peekKeys);
  if (keys === undefined) {
    if (repo.fs_uri) prime(stripFileScheme(repo.fs_uri));
    return unresolvedResult;
  }
  if (!keys || keys.length === 0) return false;
  const matched = match(keys, orgScopes);
  return matched === undefined ? unresolvedResult : matched !== null;
}

/** STRICT: only a resolved scope match counts (session grouping). */
export function repoMatchesOrgScopes(
  repo: OrgScopeFilterRepo,
  orgScopes: string[] | undefined,
  peekKeys: ScopeKeysPeek = peekShareableScopeKeys,
  prime: ScopePrime = primeShareableScopeKey,
  match: ScopeMatcher = peekMatchingOrgRepoScope
): boolean {
  return evaluateOrgScope(repo, orgScopes, false, peekKeys, prime, match);
}

/** OPTIMISTIC: a still-resolving checkout stays visible and is primed. */
export function repoEligibleForOrgScopedPicker(
  repo: OrgScopeFilterRepo,
  orgScopes: string[] | undefined,
  peekKeys: ScopeKeysPeek = peekShareableScopeKeys,
  prime: ScopePrime = primeShareableScopeKey,
  match: ScopeMatcher = peekMatchingOrgRepoScope
): boolean {
  return evaluateOrgScope(repo, orgScopes, true, peekKeys, prime, match);
}

/** A workspace is eligible when ANY member folder is; matches launch, which
 * lands the session on the primary — callers must scope launch accordingly. */
export function workspaceMatchesRepoFilter(
  folderPaths: readonly (string | null | undefined)[],
  predicate: (repo: OrgScopeFilterRepo) => boolean
): boolean {
  return folderPaths.some((path) => predicate({ fs_uri: path }));
}
