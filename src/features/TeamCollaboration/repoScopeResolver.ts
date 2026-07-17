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
import { getGitRemotes } from "@src/api/http/git/remotes";

import { isLocalRepoPath, normalizeRepoScopeKey } from "./collabSyncUtils";

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
 * tests).
 */
const shareableScopeKeyCache = new Map<string, string[] | null>();
const shareableScopeKeyInFlight = new Map<string, Promise<string[] | null>>();

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
  return shareableScopeKeyCache.get(normalizedInput);
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

  const cached = shareableScopeKeyCache.get(normalizedInput);
  if (cached !== undefined) return cached;
  const pending = shareableScopeKeyInFlight.get(normalizedInput);
  if (pending) return pending;

  // Deferred body (then-callback, not an IIFE) so the closure can compare
  // against `task` itself without tripping TS2454 (used before assigned).
  const task: Promise<string[] | null> = Promise.resolve().then(
    async (): Promise<string[] | null> => {
      const data = await getGitRemotes({
        repo_id: normalizedInput,
        repo_path: normalizedInput,
      });
      if (data === undefined) {
        // Transport failure (git server down / repo unknown): report "no
        // keys" but do NOT cache — the next consumer retries.
        return null;
      }
      const remotes = data.remotes ?? [];
      // Origin-first ordering: the checkout's own remote stays the PRIMARY
      // identity (single-key consumers, fork-relay preference); the rest
      // (upstream, forks) follow in listing order.
      const ordered = [
        ...remotes.filter((remote) => remote.name === "origin"),
        ...remotes.filter((remote) => remote.name !== "origin"),
      ];
      const keys: string[] = [];
      for (const remote of ordered) {
        const remoteUrl = remote.url || remote.fetch_url;
        const key = remoteUrl ? normalizeRepoScopeKey(remoteUrl) : "";
        if (key && !keys.includes(key)) keys.push(key);
      }
      const result = keys.length > 0 ? keys : null;
      // Guard against a cache cleared while this lookup was in flight
      // (tests, future invalidation): a stale task must not repopulate it.
      if (shareableScopeKeyInFlight.get(normalizedInput) === task) {
        shareableScopeKeyCache.set(normalizedInput, result);
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
      if ((await resolve(normalizedPath))?.includes(normalizedKey)) {
        return normalizedPath;
      }
    } catch {
      // A single unresolvable candidate (transport hiccup) must not hide a
      // later match.
    }
  }
  return null;
}
