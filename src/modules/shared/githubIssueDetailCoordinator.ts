import type { Store } from "jotai/vanilla/store";

import {
  type GitHubIssue,
  type GitHubIssueTimelineItem,
  type GitHubIssueUser,
  type GitHubRepoPermissions,
  getGitCredentialForRemote,
} from "@src/api/tauri/github";
import { ScopedResourceCache } from "@src/services/git/scopedResourceCache";

const GITHUB_ENDPOINT = "github.com";
const ISSUE_DETAIL_TTL_MS = 30_000;
const REPO_METADATA_TTL_MS = 2 * 60_000;
const VIEWER_TTL_MS = 5 * 60_000;
const REMOTE_TTL_MS = 5 * 60_000;

const MAX_ISSUE_DETAILS = 24;
const MAX_REPO_RESOURCES = 16;
const MAX_AUTH_IDENTITIES = 4;
const MAX_ISSUE_DETAIL_BYTES = 4 * 1024 * 1024;
const MAX_ISSUE_ENTRY_BYTES = 512 * 1024;

export interface GitHubIssueDetailBundle {
  issue: GitHubIssue | null;
  timeline: GitHubIssueTimelineItem[];
  error: string | null;
}

interface CoordinatorRuntime {
  authScopes: ScopedResourceCache<string>;
  issueDetails: ScopedResourceCache<GitHubIssueDetailBundle>;
  timelines: ScopedResourceCache<GitHubIssueTimelineItem[]>;
  viewers: ScopedResourceCache<string>;
  permissions: ScopedResourceCache<GitHubRepoPermissions>;
  duplicateCandidates: ScopedResourceCache<GitHubIssue[]>;
  assignableUsers: ScopedResourceCache<GitHubIssueUser[]>;
  remoteUrls: ScopedResourceCache<string | null>;
}

export interface GitHubIssueDetailCoordinatorStats {
  authScopes: ReturnType<ScopedResourceCache<string>["getStats"]>;
  issueDetails: ReturnType<
    ScopedResourceCache<GitHubIssueDetailBundle>["getStats"]
  >;
  timelines: ReturnType<
    ScopedResourceCache<GitHubIssueTimelineItem[]>["getStats"]
  >;
  viewers: ReturnType<ScopedResourceCache<string>["getStats"]>;
  permissions: ReturnType<
    ScopedResourceCache<GitHubRepoPermissions>["getStats"]
  >;
  duplicateCandidates: ReturnType<
    ScopedResourceCache<GitHubIssue[]>["getStats"]
  >;
  assignableUsers: ReturnType<
    ScopedResourceCache<GitHubIssueUser[]>["getStats"]
  >;
  remoteUrls: ReturnType<ScopedResourceCache<string | null>["getStats"]>;
}

let runtimeByStore = new WeakMap<Store, CoordinatorRuntime>();

function estimateSerializedBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function createRuntime(): CoordinatorRuntime {
  return {
    authScopes: new ScopedResourceCache<string>({
      maxEntries: 1,
      maxInFlight: 1,
      // Credential selection can change without a React/store reset. Keep
      // only the in-flight coalescing benefit; every later request rechecks
      // the non-secret identity before choosing any account-scoped cache key.
      maxAgeMs: 0,
    }),
    issueDetails: new ScopedResourceCache<GitHubIssueDetailBundle>({
      maxEntries: MAX_ISSUE_DETAILS,
      maxInFlight: MAX_ISSUE_DETAILS,
      maxAgeMs: ISSUE_DETAIL_TTL_MS,
      maxBytes: MAX_ISSUE_DETAIL_BYTES,
      maxEntryBytes: MAX_ISSUE_ENTRY_BYTES,
      estimateSize: estimateSerializedBytes,
    }),
    timelines: new ScopedResourceCache<GitHubIssueTimelineItem[]>({
      maxEntries: MAX_ISSUE_DETAILS,
      maxInFlight: MAX_ISSUE_DETAILS,
      maxAgeMs: ISSUE_DETAIL_TTL_MS,
      maxBytes: MAX_ISSUE_DETAIL_BYTES,
      maxEntryBytes: MAX_ISSUE_ENTRY_BYTES,
      estimateSize: estimateSerializedBytes,
    }),
    viewers: new ScopedResourceCache<string>({
      maxEntries: MAX_AUTH_IDENTITIES,
      maxInFlight: MAX_AUTH_IDENTITIES,
      maxAgeMs: VIEWER_TTL_MS,
    }),
    permissions: new ScopedResourceCache<GitHubRepoPermissions>({
      maxEntries: MAX_REPO_RESOURCES,
      maxInFlight: MAX_REPO_RESOURCES,
      maxAgeMs: REPO_METADATA_TTL_MS,
    }),
    duplicateCandidates: new ScopedResourceCache<GitHubIssue[]>({
      maxEntries: MAX_REPO_RESOURCES,
      maxInFlight: MAX_REPO_RESOURCES,
      maxAgeMs: ISSUE_DETAIL_TTL_MS,
      maxBytes: MAX_ISSUE_DETAIL_BYTES,
      maxEntryBytes: MAX_ISSUE_ENTRY_BYTES,
      estimateSize: estimateSerializedBytes,
    }),
    assignableUsers: new ScopedResourceCache<GitHubIssueUser[]>({
      maxEntries: MAX_REPO_RESOURCES,
      maxInFlight: MAX_REPO_RESOURCES,
      maxAgeMs: REPO_METADATA_TTL_MS,
      maxBytes: MAX_ISSUE_DETAIL_BYTES,
      maxEntryBytes: MAX_ISSUE_ENTRY_BYTES,
      estimateSize: estimateSerializedBytes,
    }),
    remoteUrls: new ScopedResourceCache<string | null>({
      maxEntries: MAX_REPO_RESOURCES,
      maxInFlight: MAX_REPO_RESOURCES,
      maxAgeMs: REMOTE_TTL_MS,
    }),
  };
}

function runtimeFor(store: Store): CoordinatorRuntime {
  let runtime = runtimeByStore.get(store);
  if (!runtime) {
    runtime = createRuntime();
    runtimeByStore.set(store, runtime);
  }
  return runtime;
}

/**
 * Resolve a non-secret identity for the active GitHub credential. The token is
 * deliberately discarded immediately; only endpoint + connection metadata is
 * retained in request/cache keys.
 */
export async function resolveGitHubDetailAuthScope(): Promise<string> {
  const credential = await getGitCredentialForRemote(
    `https://${GITHUB_ENDPOINT}`
  );
  return credential
    ? `${GITHUB_ENDPOINT}:${credential.connection_id}:${credential.source}:${credential.username}`
    : `${GITHUB_ENDPOINT}:anonymous`;
}

export function loadGitHubDetailAuthScope(store: Store): Promise<string> {
  return runtimeFor(store).authScopes.load(
    GITHUB_ENDPOINT,
    resolveGitHubDetailAuthScope
  );
}

export function githubIssueResourceKey(
  authScope: string,
  repoFullName: string,
  issueNumber: number
): string {
  return `${authScope}|${repoFullName.toLowerCase()}#${issueNumber}`;
}

function repoResourceKey(authScope: string, repoFullName: string): string {
  return `${authScope}|${repoFullName.toLowerCase()}`;
}

export function loadGitHubIssueDetailBundle(
  store: Store,
  resourceKey: string,
  loader: () => Promise<GitHubIssueDetailBundle>,
  options?: { force?: boolean }
): Promise<GitHubIssueDetailBundle> {
  return runtimeFor(store).issueDetails.load(resourceKey, loader, {
    ...options,
    shouldCache: (bundle) => Boolean(bundle.issue && !bundle.error),
  });
}

export function primeGitHubIssueDetailBundle(
  store: Store,
  resourceKey: string,
  bundle: GitHubIssueDetailBundle
): void {
  runtimeFor(store).issueDetails.set(resourceKey, bundle);
}

export function invalidateGitHubIssueDetailBundle(
  store: Store,
  resourceKey: string
): void {
  runtimeFor(store).issueDetails.delete(resourceKey);
}

export function loadGitHubIssueTimeline(
  store: Store,
  resourceKey: string,
  loader: () => Promise<GitHubIssueTimelineItem[]>,
  options?: { force?: boolean }
): Promise<GitHubIssueTimelineItem[]> {
  return runtimeFor(store).timelines.load(resourceKey, loader, options);
}

export function primeGitHubIssueTimeline(
  store: Store,
  resourceKey: string,
  timeline: GitHubIssueTimelineItem[]
): void {
  runtimeFor(store).timelines.set(resourceKey, timeline);
}

export function invalidateGitHubIssueTimeline(
  store: Store,
  resourceKey: string
): void {
  runtimeFor(store).timelines.delete(resourceKey);
}

export function loadGitHubViewer(
  store: Store,
  authScope: string,
  loader: () => Promise<string>
): Promise<string> {
  return runtimeFor(store).viewers.load(authScope, loader);
}

export function primeGitHubViewer(
  store: Store,
  authScope: string,
  viewerLogin: string
): void {
  runtimeFor(store).viewers.set(authScope, viewerLogin);
}

export function loadGitHubRepoPermissions(
  store: Store,
  authScope: string,
  repoFullName: string,
  loader: () => Promise<GitHubRepoPermissions>
): Promise<GitHubRepoPermissions> {
  return runtimeFor(store).permissions.load(
    repoResourceKey(authScope, repoFullName),
    loader
  );
}

export function primeGitHubRepoPermissions(
  store: Store,
  authScope: string,
  repoFullName: string,
  permissions: GitHubRepoPermissions
): void {
  runtimeFor(store).permissions.set(
    repoResourceKey(authScope, repoFullName),
    permissions
  );
}

export function loadGitHubDuplicateCandidates(
  store: Store,
  authScope: string,
  repoFullName: string,
  issueNumber: number,
  loader: () => Promise<GitHubIssue[]>
): Promise<GitHubIssue[]> {
  return runtimeFor(store).duplicateCandidates.load(
    `${repoResourceKey(authScope, repoFullName)}#duplicates-for:${issueNumber}`,
    loader
  );
}

export function loadGitHubAssignableUsers(
  store: Store,
  authScope: string,
  repoFullName: string,
  loader: () => Promise<GitHubIssueUser[]>
): Promise<GitHubIssueUser[]> {
  return runtimeFor(store).assignableUsers.load(
    repoResourceKey(authScope, repoFullName),
    loader
  );
}

export function loadGitHubRemoteUrl(
  store: Store,
  repoPath: string,
  loader: () => Promise<string | null>
): Promise<string | null> {
  return runtimeFor(store).remoteUrls.load(repoPath, loader);
}

export function getGitHubIssueDetailCoordinatorStats(
  store: Store
): GitHubIssueDetailCoordinatorStats {
  const runtime = runtimeFor(store);
  return {
    authScopes: runtime.authScopes.getStats(),
    issueDetails: runtime.issueDetails.getStats(),
    timelines: runtime.timelines.getStats(),
    viewers: runtime.viewers.getStats(),
    permissions: runtime.permissions.getStats(),
    duplicateCandidates: runtime.duplicateCandidates.getStats(),
    assignableUsers: runtime.assignableUsers.getStats(),
    remoteUrls: runtime.remoteUrls.getStats(),
  };
}

export function resetGitHubIssueDetailCoordinator(store?: Store): void {
  if (store) {
    runtimeByStore.delete(store);
    return;
  }
  runtimeByStore = new WeakMap<Store, CoordinatorRuntime>();
}
