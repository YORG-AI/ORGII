/**
 * Repo path → shareable scope keys resolution (design §8.3, submission side).
 *
 * When a local checkout has git remotes, its shareable identity is the SET of
 * normalized remote URLs — fork workflows give one checkout several equally
 * valid identities (origin = personal fork, upstream = the team repo), and an
 * org scope naming ANY of them must match. Scope matching picks whichever key
 * is in the org's scopes and pushes THAT key as the session's repoScopeKey,
 * so the server-side scope check agrees. A repo WITHOUT a remote has no
 * shareable identity at all (git-remote-only sharing — the resolvers return
 * null for it).
 *
 * The remote lookup reuses the existing git HTTP IPC (`getGitRemotes`, Rust
 * server). The route's `repo_id` segment is a registered database id, so a
 * raw checkout path must also be sent through its explicit `path` query.
 * The client already swallows transport errors and returns `undefined`; a
 * transport failure is treated as "no keys right now" but is deliberately
 * NOT cached, so a repo is never permanently marked unshareable by a hiccup
 * (e.g. the git server still booting).
 */
import { exists } from "@tauri-apps/plugin-fs";
import { useSyncExternalStore } from "react";

import { getGitRemotes } from "@src/api/http/git/remotes";
import { resolveGitHubRepoNetworkIdentityLocal } from "@src/api/tauri/github";
import { createLogger } from "@src/hooks/logger";

import {
  isLocalRepoPath,
  normalizeRepoScopeKey,
  pickMatchingOrgScope,
} from "./collabSyncUtils";

// ============================================================================
// Shareable scope keys (git-remote-only sharing)
// ============================================================================

/**
 * Cache of `normalized local path → shareable keys`. Ordered origin-first
 * (the checkout's primary identity — display and fork-relay preference),
 * deduped. `null` is a POSITIVE result ("the repo really has no remote",
 * confirmed by a successful remotes read); transport failures never land
 * here. Shared by the sync engine (push eligibility) and the UI (share
 * dialog gating, repo picker) so one resolution serves every consumer.
 * Machine-global truth for the lifetime of the app run — a repo gaining a
 * remote is picked up after restart (or a `clearShareableScopeKeyCache` in
 * tests). Both resolver caches use a bounded LRU so a long-running renderer
 * cannot retain every repository it has ever encountered.
 */
export const MAX_RESOLVER_CACHE_ENTRIES = 256;
const shareableScopeKeyCache = new Map<string, string[] | null>();
const shareableScopeKeyInFlight = new Map<string, Promise<string[] | null>>();
// Transport failures are deliberately NOT cached as results, but a short
// negative-cache window keeps a render-path caller from re-firing the
// git-remotes IPC on every external re-render while the backend is down.
const SHAREABLE_SCOPE_FAILURE_TTL_MS = 30_000;
const shareableScopeKeyFailureAtMs = new Map<string, number>();

interface RepoNetworkScopeCacheEntry {
  value: string | null;
  /**
   * True when the provider lookup FAILED (transport/API error) rather than
   * answering "no network identity". A failed entry rate-limits retries for
   * its TTL but must never be read as proof of no identity: scope matching
   * that would need this key reports UNKNOWN instead of no-match, because
   * no-match retracts live shared rows and drops org tags.
   */
  failed: boolean;
  expiresAt: number;
}

const repoNetworkScopeCache = new Map<string, RepoNetworkScopeCacheEntry>();
const repoNetworkScopeInFlight = new Map<string, Promise<string | null>>();
export const REPO_NETWORK_LOOKUP_CONCURRENCY = 4;
let activeRepoNetworkLookups = 0;
const repoNetworkLookupWaiters: Array<() => void> = [];
const NETWORK_LOOKUP_FAILURE_TTL_MS = 30_000;
/**
 * Repeated failures back off geometrically (30s → 2m → 8m → 30m cap). An
 * unauthenticated client gets 60 GitHub requests/hour; a flat 30s retry on
 * just two failing repos burns ~240/hour, so the failure becomes
 * self-sustaining for the rest of every rate-limit window.
 */
const NETWORK_LOOKUP_FAILURE_TTL_MAX_MS = 30 * 60_000;
const networkLookupFailureStreaks = new Map<string, number>();
const log = createLogger("RepoScopeResolver");

function networkLookupFailureTtlMs(streak: number): number {
  const ttl =
    NETWORK_LOOKUP_FAILURE_TTL_MS * 4 ** Math.max(0, Math.min(streak - 1, 5));
  return Math.min(ttl, NETWORK_LOOKUP_FAILURE_TTL_MAX_MS);
}

async function withRepoNetworkLookupPermit<T>(
  operation: () => Promise<T>
): Promise<T> {
  if (activeRepoNetworkLookups >= REPO_NETWORK_LOOKUP_CONCURRENCY) {
    await new Promise<void>((resolve) =>
      repoNetworkLookupWaiters.push(resolve)
    );
  }
  activeRepoNetworkLookups += 1;
  try {
    return await operation();
  } finally {
    activeRepoNetworkLookups -= 1;
    repoNetworkLookupWaiters.shift()?.();
  }
}

function readLruEntry<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function writeLruEntry<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_RESOLVER_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

type ShareableScopeKeyListener = (
  repoPath: string,
  keys: string[] | null
) => void;
const shareableScopeKeyListeners = new Set<ShareableScopeKeyListener>();
let shareableScopeKeyVersion = 0;

function notifyShareableScopeKeys(
  repoPath: string,
  keys: string[] | null
): void {
  shareableScopeKeyVersion += 1;
  for (const listener of shareableScopeKeyListeners) listener(repoPath, keys);
}

/**
 * Subscribe to cache fills. The listener signature is compatible with
 * `useSyncExternalStore` (which passes a zero-arg callback); richer consumers
 * (the sync engine) get the resolved path + keys to react precisely.
 */
export function subscribeShareableScopeKeys(
  listener: ShareableScopeKeyListener
): () => void {
  shareableScopeKeyListeners.add(listener);
  return () => shareableScopeKeyListeners.delete(listener);
}

/** Monotonic cache version — `useSyncExternalStore` snapshot. */
export function getShareableScopeKeyVersion(): number {
  return shareableScopeKeyVersion;
}

export function useShareableScopeKeyVersion(): number {
  return useSyncExternalStore(
    subscribeShareableScopeKeys,
    getShareableScopeKeyVersion
  );
}

/**
 * Synchronous cache read of ALL shareable keys for a checkout. `undefined` =
 * not resolved yet (call `primeShareableScopeKey`/`resolveShareableScopeKeys`);
 * `null` = resolved, repo has NO git remote (not shareable); array = the
 * origin-first, deduped shareable keys. Inputs that are already remote-style
 * keys resolve synchronously to themselves.
 */
export function peekShareableScopeKeys(
  input: string
): string[] | null | undefined {
  const normalizedInput = normalizeRepoScopeKey(input);
  if (!normalizedInput) return null;
  if (!isLocalRepoPath(normalizedInput)) return [normalizedInput];
  return readLruEntry(shareableScopeKeyCache, normalizedInput);
}

/**
 * Single-key convenience view of `peekShareableScopeKeys`: the checkout's
 * PRIMARY identity (origin remote, or the first remote). Kept for display
 * and legacy callers; scope MATCHING must use the full key set.
 */
export function peekShareableScopeKey(
  input: string
): string | null | undefined {
  const keys = peekShareableScopeKeys(input);
  if (keys === undefined) return undefined;
  return keys === null ? null : (keys[0] ?? null);
}

/**
 * Normalize a persisted set of raw Git remotes into the same scope-key shape
 * as the live checkout resolver. Imported-history callers use this pure path
 * so grouping old sessions never probes their historical working folders.
 */
export function shareableScopeKeysFromRemoteUrls(
  remoteUrls: readonly string[] | null | undefined
): string[] | null {
  const keys: string[] = [];
  for (const remoteUrl of remoteUrls ?? []) {
    const key = normalizeRepoScopeKey(remoteUrl);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.length > 0 ? keys : null;
}

type GitMarkerVerdict = "present" | "absent" | "unknown";

async function probeGitMarker(path: string): Promise<GitMarkerVerdict> {
  try {
    if (!(await exists(path))) return "absent";
  } catch {
    return "unknown";
  }
  let dir = path;
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      if (await exists(`${dir}/.git`)) return "present";
    } catch {
      return "unknown";
    }
    const cut = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
    if (cut <= 0) return "absent";
    dir = dir.slice(0, cut);
  }
  return "unknown";
}

/**
 * The git-remote-only resolver (design §8.3): returns the normalized keys of
 * ALL remotes (origin first) when the repo has any, and `null` when it does
 * not — that null IS the "not shareable" signal. A local path is never
 * returned. Concurrent calls for one path share one in-flight lookup.
 */
export async function resolveShareableScopeKeys(
  input: string
): Promise<string[] | null> {
  const normalizedInput = normalizeRepoScopeKey(input);
  if (!normalizedInput) return null;
  if (!isLocalRepoPath(normalizedInput)) return [normalizedInput];

  const cached = readLruEntry(shareableScopeKeyCache, normalizedInput);
  if (cached !== undefined) return cached;
  const pending = shareableScopeKeyInFlight.get(normalizedInput);
  if (pending) return pending;
  const failedAtMs = shareableScopeKeyFailureAtMs.get(normalizedInput);
  if (
    failedAtMs !== undefined &&
    Date.now() - failedAtMs < SHAREABLE_SCOPE_FAILURE_TTL_MS
  ) {
    return null;
  }

  // Deferred body (then-callback, not an IIFE) so the closure can compare
  // against `task` itself without tripping TS2454 (used before assigned).
  const task: Promise<string[] | null> = Promise.resolve().then(
    async (): Promise<string[] | null> => {
      // A deleted path — or a folder with no checkout anywhere above it —
      // can never yield remotes: cache the definitive null instead of
      // probing, so boot does not spray the git server (and the console's
      // network log) with 404s for every stale path a historical session
      // still references. The server resolves repos with
      // `Repository::discover` (a workspace may be a package/subfolder of
      // the checkout), so the `.git` marker is searched UPWARD the same
      // way; the marker is a file for worktrees. `exists()` throws for
      // paths outside the fs plugin's scope — treated as unknowable, the
      // probe decides.
      const marker = await probeGitMarker(normalizedInput);
      if (marker === "absent") {
        if (shareableScopeKeyInFlight.get(normalizedInput) === task) {
          writeLruEntry(shareableScopeKeyCache, normalizedInput, null);
          notifyShareableScopeKeys(normalizedInput, null);
        }
        return null;
      }
      const data = await getGitRemotes({
        repo_id: normalizedInput,
        repo_path: normalizedInput,
      });
      if (data === undefined) {
        // Transport failure (git server down / repo unknown): report "no
        // keys" but do NOT cache the result — retries resume after the
        // short negative-cache window.
        shareableScopeKeyFailureAtMs.set(normalizedInput, Date.now());
        return null;
      }
      shareableScopeKeyFailureAtMs.delete(normalizedInput);
      const remotes = data.remotes ?? [];
      // Origin-first ordering: the checkout's own remote stays the PRIMARY
      // identity (single-key consumers, fork-relay preference); the rest
      // (upstream, forks) follow in listing order.
      const ordered = [
        ...remotes.filter((remote) => remote.name === "origin"),
        ...remotes.filter((remote) => remote.name !== "origin"),
      ];
      const result = shareableScopeKeysFromRemoteUrls(
        ordered.map((remote) => remote.url || remote.fetch_url)
      );
      // Guard against a cache cleared while this lookup was in flight
      // (tests, future invalidation): a stale task must not repopulate it.
      if (shareableScopeKeyInFlight.get(normalizedInput) === task) {
        writeLruEntry(shareableScopeKeyCache, normalizedInput, result);
        notifyShareableScopeKeys(normalizedInput, result);
      }
      return result;
    }
  );
  void task
    .finally(() => {
      if (shareableScopeKeyInFlight.get(normalizedInput) === task) {
        shareableScopeKeyInFlight.delete(normalizedInput);
      }
    })
    .catch(() => undefined);
  shareableScopeKeyInFlight.set(normalizedInput, task);
  return task;
}

/**
 * Single-key convenience view of `resolveShareableScopeKeys` (primary
 * identity — see `peekShareableScopeKey`).
 */
export async function resolveShareableScopeKey(
  input: string
): Promise<string | null> {
  const keys = await resolveShareableScopeKeys(input);
  return keys === null ? null : (keys[0] ?? null);
}

/**
 * Fire-and-forget resolution kick — safe from render paths and sync engine
 * cycles (result lands in the cache; subscribers are notified).
 */
export function primeShareableScopeKey(input: string): void {
  void resolveShareableScopeKeys(input).catch(() => null);
}

/** Test seam: drop every cached / in-flight resolution. */
export function clearShareableScopeKeyCache(): void {
  shareableScopeKeyCache.clear();
  shareableScopeKeyInFlight.clear();
  shareableScopeKeyFailureAtMs.clear();
  repoNetworkScopeCache.clear();
  repoNetworkScopeInFlight.clear();
  networkLookupFailureStreaks.clear();
}

// ============================================================================
// Provider repository identity (GitHub fork network)
// ============================================================================

function githubRepoFullName(scopeKey: string): string | null {
  const normalized = normalizeRepoScopeKey(scopeKey);
  if (!normalized.startsWith("github.com/") || isLocalRepoPath(normalized)) {
    return null;
  }
  const fullName = normalized.slice("github.com/".length);
  return fullName.split("/").length === 2 ? fullName : null;
}

/**
 * Synchronous network-root cache view. Non-GitHub remote keys are already
 * their own exact identity. A GitHub key is `undefined` until its repository
 * metadata has resolved, then the normalized `source.full_name` shared by
 * every fork in the network (or null during a bounded failure backoff).
 */
export function peekRepoNetworkScopeKey(
  input: string
): string | null | undefined {
  const normalized = normalizeRepoScopeKey(input);
  if (!normalized || isLocalRepoPath(normalized)) return null;
  if (!githubRepoFullName(normalized)) return normalized;
  const entry = readLruEntry(repoNetworkScopeCache, normalized);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    repoNetworkScopeCache.delete(normalized);
    return undefined;
  }
  return entry.value;
}

/** Resolve a remote key to its provider-level repository identity. */
export async function resolveRepoNetworkScopeKey(
  input: string
): Promise<string | null> {
  const normalized = normalizeRepoScopeKey(input);
  if (!normalized || isLocalRepoPath(normalized)) return null;
  const fullName = githubRepoFullName(normalized);
  if (!fullName) return normalized;
  const cached = peekRepoNetworkScopeKey(normalized);
  if (cached !== undefined) return cached;
  const pending = repoNetworkScopeInFlight.get(normalized);
  if (pending) return pending;

  const task = withRepoNetworkLookupPermit(() =>
    resolveGitHubRepoNetworkIdentityLocal(fullName)
  )
    .then((identity) => {
      const sourceKey = normalizeRepoScopeKey(
        `github.com/${identity.source_full_name}`
      );
      return {
        value: sourceKey && !isLocalRepoPath(sourceKey) ? sourceKey : null,
        failed: false,
      };
    })
    .catch((error: unknown) => {
      const streak = (networkLookupFailureStreaks.get(normalized) ?? 0) + 1;
      networkLookupFailureStreaks.set(normalized, streak);
      log.rateLimited(
        `network-identity-${normalized}`,
        60_000,
        `GitHub network identity lookup failed for ${fullName} ` +
          `(streak ${streak}, next retry in ` +
          `${Math.round(networkLookupFailureTtlMs(streak) / 1000)}s): ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return { value: null, failed: true };
    })
    .then(({ value, failed }) => {
      if (!failed) networkLookupFailureStreaks.delete(normalized);
      if (repoNetworkScopeInFlight.get(normalized) === task) {
        writeLruEntry(repoNetworkScopeCache, normalized, {
          value,
          failed,
          expiresAt:
            value === null
              ? Date.now() +
                networkLookupFailureTtlMs(
                  failed
                    ? (networkLookupFailureStreaks.get(normalized) ?? 1)
                    : 1
                )
              : Number.POSITIVE_INFINITY,
        });
        // Reuse the existing cache-version subscription: repo pickers and
        // share dialogs already subscribe to it and will re-evaluate their
        // synchronous eligibility when the fork-network identity lands.
        notifyShareableScopeKeys(normalized, value ? [value] : null);
      }
      return value;
    })
    .finally(() => {
      if (repoNetworkScopeInFlight.get(normalized) === task) {
        repoNetworkScopeInFlight.delete(normalized);
      }
    });
  repoNetworkScopeInFlight.set(normalized, task);
  return task;
}

export function primeRepoNetworkScopeKey(input: string): void {
  void resolveRepoNetworkScopeKey(input).catch(() => null);
}

/**
 * Exact remote match first; on GitHub, fall back to a confirmed common
 * `source.full_name`. The returned string is always the ORIGINAL org scope,
 * because the cloud backend validates that wire value against its stored
 * governance scopes.
 *
 * `undefined` means a GitHub network lookup was primed and is still pending.
 */
export function peekMatchingOrgRepoScope(
  repoScopeKeys: string[] | null | undefined,
  orgScopes: string[] | null | undefined
): string | null | undefined {
  const exact = pickMatchingOrgScope(repoScopeKeys, orgScopes ?? undefined);
  if (exact !== null) return exact;
  if (!repoScopeKeys?.length || !orgScopes?.length) return null;

  let unresolved = false;
  const resolveCachedRoot = (scopeKey: string): string | null | undefined => {
    if (peekRepoNetworkLookupFailed(scopeKey)) {
      unresolved = true;
      return undefined;
    }
    const root = peekRepoNetworkScopeKey(scopeKey);
    if (root === undefined) {
      unresolved = true;
      primeRepoNetworkScopeKey(scopeKey);
    }
    return root;
  };
  // Prime both sides in one pass so repo and org identities share the same
  // bounded provider batch instead of resolving in alternating sync waves.
  const repoRoots = repoScopeKeys.map(resolveCachedRoot);
  const orgRoots = orgScopes.map(resolveCachedRoot);
  for (const repoRoot of repoRoots) {
    if (!repoRoot) continue;
    for (let index = 0; index < orgRoots.length; index += 1) {
      const orgRoot = orgRoots[index];
      if (orgRoot && repoRoot === orgRoot) return orgScopes[index]!;
    }
  }
  return unresolved ? undefined : null;
}

/** True when a cached network lookup for `input` is a rate-limited FAILURE. */
function peekRepoNetworkLookupFailed(input: string): boolean {
  const normalized = normalizeRepoScopeKey(input);
  if (!normalized || isLocalRepoPath(normalized)) return false;
  if (!githubRepoFullName(normalized)) return false;
  const entry = readLruEntry(repoNetworkScopeCache, normalized);
  return Boolean(entry && entry.failed && entry.expiresAt > Date.now());
}

/**
 * `undefined` ⇒ UNKNOWN: no direct match, and at least one network-identity
 * lookup that a match could hinge on has FAILED (transient GitHub/API
 * error). Callers on destructive paths (out-of-scope retract/untag) must
 * defer on unknown — treating a failed lookup as "no match" retracted live
 * rows and dropped org tags whenever the identity API blipped, then pushed
 * them again once the 30s failure TTL expired (scope flapping).
 */
export async function resolveMatchingOrgRepoScope(
  repoScopeKeys: string[] | null | undefined,
  orgScopes: string[] | null | undefined
): Promise<string | null | undefined> {
  const immediate = peekMatchingOrgRepoScope(repoScopeKeys, orgScopes);
  if (immediate != null) return immediate;
  await Promise.all(
    [...(repoScopeKeys ?? []), ...(orgScopes ?? [])].map((key) =>
      resolveRepoNetworkScopeKey(key)
    )
  );
  const matched = peekMatchingOrgRepoScope(repoScopeKeys, orgScopes) ?? null;
  if (matched !== null) return matched;
  if (
    [...(repoScopeKeys ?? []), ...(orgScopes ?? [])].some(
      peekRepoNetworkLookupFailed
    )
  ) {
    return undefined;
  }
  return null;
}

// ============================================================================
// Reverse resolution: remote scope key → local checkout (fork relay)
// ============================================================================

/**
 * Find a LOCAL checkout ANY of whose git remotes resolves to `scopeKey` — the
 * reverse of `resolveShareableScopeKeys`, using the same resolver (and its
 * cache) so both directions agree on normalization. Multi-remote aware: a
 * teammate may have pushed the TEAM repo's key (their upstream) while our
 * checkout's primary identity is a personal fork — the upstream remote still
 * identifies it as the same repo. Used at fork time: a teammate's `repoPath`
 * is THEIR absolute path and is meaningless on this machine; the fork's
 * workspace must instead be one of OUR checkouts of the same repo, matched
 * by the cross-machine `repoScopeKey`.
 *
 * `candidatePaths` is the caller-enumerated local repo set (known repos +
 * paths of local sessions); non-local-path entries are ignored. Candidates
 * are probed in order — first match wins — and resolution failures on one
 * candidate never abort the scan. Returns null when no local checkout
 * matches (the caller opens the fork without a workspace and surfaces a
 * non-blocking hint, rather than shipping a dead foreign path).
 */
export async function resolveLocalCheckoutForScopeKey(
  scopeKey: string | null | undefined,
  candidatePaths: readonly string[],
  resolve: (
    path: string
  ) => Promise<string[] | null> = resolveShareableScopeKeys
): Promise<string | null> {
  if (!scopeKey) return null;
  const normalizedKey = normalizeRepoScopeKey(scopeKey);
  if (!normalizedKey || isLocalRepoPath(normalizedKey)) return null;

  const seen = new Set<string>();
  for (const candidate of candidatePaths) {
    if (!candidate) continue;
    const normalizedPath = normalizeRepoScopeKey(candidate);
    if (!normalizedPath || !isLocalRepoPath(normalizedPath)) continue;
    if (seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    try {
      const candidateKeys = await resolve(normalizedPath);
      if (
        candidateKeys?.includes(normalizedKey) ||
        (await resolveMatchingOrgRepoScope(candidateKeys, [normalizedKey])) !=
          null
      ) {
        return normalizedPath;
      }
    } catch {
      // A single unresolvable candidate (transport hiccup) must not hide a
      // later match.
    }
  }
  return null;
}
