/**
 * usePrFileContent
 *
 * Loads the before/after content for a selected PR file straight from the
 * GitHub Contents API by commit SHA (`github_get_content`). No local clone or
 * `git fetch` is needed, so the diff auto-loads.
 *
 * Content is fetched in parallel (old@baseSha, new@headSha), de-duplicated by
 * (repo, ref, path), and kept in a small module-scope LRU so re-selecting a
 * file or toggling view modes doesn't refetch.
 */
import { useCallback, useEffect, useState } from "react";

import {
  type GitHubFileContent,
  type PrFile,
  getContentLocal,
} from "@src/api/tauri/github";

type FileContentLoadState = "idle" | "loading" | "ready" | "error";

const CONTENT_CACHE_MAX_ENTRIES = 16;
const CONTENT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const CONTENT_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
interface ContentCacheEntry {
  value: GitHubFileContent;
  byteSize: number;
}
const contentCache = new Map<string, ContentCacheEntry>();
const contentInFlight = new Map<string, Promise<GitHubFileContent>>();
let contentCacheBytes = 0;

function cacheKey(repoFullName: string, ref: string, path: string): string {
  return `${repoFullName}@${ref}:${path}`;
}

async function fetchContent(
  repoFullName: string,
  path: string,
  ref: string
): Promise<GitHubFileContent> {
  const key = cacheKey(repoFullName, ref, path);
  const cachedEntry = contentCache.get(key);
  if (cachedEntry) {
    // LRU promote
    contentCache.delete(key);
    contentCache.set(key, cachedEntry);
    return cachedEntry.value;
  }
  const existing = contentInFlight.get(key);
  if (existing) return existing;

  const promise = getContentLocal(repoFullName, path, ref)
    .then((result) => {
      contentInFlight.delete(key);
      const byteSize = result.content.length * 2 + 64;
      if (byteSize <= CONTENT_CACHE_MAX_ENTRY_BYTES) {
        const previous = contentCache.get(key);
        if (previous) {
          contentCacheBytes -= previous.byteSize;
          contentCache.delete(key);
        }
        while (
          contentCache.size >= CONTENT_CACHE_MAX_ENTRIES ||
          contentCacheBytes + byteSize > CONTENT_CACHE_MAX_BYTES
        ) {
          const oldestKey = contentCache.keys().next().value as
            | string
            | undefined;
          if (!oldestKey) break;
          const oldest = contentCache.get(oldestKey);
          if (oldest) contentCacheBytes -= oldest.byteSize;
          contentCache.delete(oldestKey);
        }
        contentCache.set(key, { value: result, byteSize });
        contentCacheBytes += byteSize;
      }
      return result;
    })
    .catch((err) => {
      contentInFlight.delete(key);
      throw err;
    });
  contentInFlight.set(key, promise);
  return promise;
}

export interface UsePrFileContentParams {
  repoFullName: string | null;
  /** The selected changed file (null = nothing selected). */
  file: PrFile | null;
  /** Base commit SHA the PR diffs against. */
  baseRef: string | null;
  /** PR head commit SHA. */
  headRef: string | null;
}

export interface UsePrFileContentResult {
  oldContent: string;
  newContent: string;
  isBinary: boolean;
  truncated: boolean;
  loadState: FileContentLoadState;
  error: string | null;
  reload: () => void;
}

export function usePrFileContent({
  repoFullName,
  file,
  baseRef,
  headRef,
}: UsePrFileContentParams): UsePrFileContentResult {
  const [oldContent, setOldContent] = useState("");
  const [newContent, setNewContent] = useState("");
  const [isBinary, setIsBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loadState, setLoadState] = useState<FileContentLoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const status = file?.status;
  const filename = file?.filename;
  const previousFilename = file?.previous_filename;

  useEffect(() => {
    let cancelled = false;

    // All state updates live inside the async loader (never synchronously in
    // the effect body) so we don't trip `react-hooks/set-state-in-effect`.
    const load = async () => {
      if (!repoFullName || !filename || !headRef) {
        if (!cancelled) setLoadState("idle");
        return;
      }
      if (!cancelled) {
        setLoadState("loading");
        setError(null);
      }

      const isAdded = status === "added";
      const isRemoved = status === "removed" || status === "deleted";
      // A rename reads the old side from the previous path at the base ref.
      const oldPath = previousFilename ?? filename;

      try {
        const [oldResult, newResult] = await Promise.all([
          isAdded || !baseRef
            ? Promise.resolve<GitHubFileContent | null>(null)
            : fetchContent(repoFullName, oldPath, baseRef),
          isRemoved
            ? Promise.resolve<GitHubFileContent | null>(null)
            : fetchContent(repoFullName, filename, headRef),
        ]);
        if (cancelled) return;
        setOldContent(oldResult?.content ?? "");
        setNewContent(newResult?.content ?? "");
        setIsBinary(Boolean(oldResult?.is_binary || newResult?.is_binary));
        setTruncated(Boolean(oldResult?.truncated || newResult?.truncated));
        setLoadState("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoadState("error");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    repoFullName,
    filename,
    status,
    previousFilename,
    baseRef,
    headRef,
    reloadKey,
  ]);

  return {
    oldContent,
    newContent,
    isBinary,
    truncated,
    loadState,
    error,
    reload,
  };
}
