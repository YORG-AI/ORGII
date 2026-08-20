/**
 * resolveFileAgainstRoots — multi-root resolution for relative file
 * references coming from chat (file pills, markdown code-block links).
 *
 * A relative path in an agent message is relative to whatever root the
 * AGENT was working in — which in a multi-root workspace is not
 * necessarily the folder the WorkStation file tree currently shows.
 * Historically the click handlers joined the path onto the active
 * WorkStation root only, producing "Unable to locate the file" whenever
 * the session ran in a different repo (or in one of its /add-dir roots).
 *
 * The resolver probes an ordered list of candidate roots and returns the
 * first that actually contains the file. Ordering encodes intent:
 *
 *   1. the session's own workspace root — the message came from this
 *      session's agent, so its root is the most likely base;
 *   2. the session's additional directories (agent /add-dir grants,
 *      IDE-synced folders) in workspace order;
 *   3. the active WorkStation root — preserves pre-multi-root behavior
 *      and covers clicks without session context;
 *   4. the remaining IDE workspace folders.
 *
 * Ambiguity (same relative path existing under several roots) is decided
 * by that same order — session root wins on purpose.
 */

export interface CandidateRootsInput {
  /** The active session's persisted workspace root, if any. */
  sessionRepoPath?: string | null;
  /** The active session's additional directories (absolute paths). */
  sessionAdditionalDirs?: readonly string[];
  /** WorkStation's current root (`activeWorkspaceRootPathAtom`). */
  activeRootPath?: string | null;
  /** All IDE workspace folder paths (multi-root). */
  workspaceFolderPaths?: readonly string[];
}

function normalizeRoot(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** Ordered, deduplicated candidate roots. */
export function buildCandidateRoots(input: CandidateRootsInput): string[] {
  const ordered = [
    input.sessionRepoPath,
    ...(input.sessionAdditionalDirs ?? []),
    input.activeRootPath,
    ...(input.workspaceFolderPaths ?? []),
  ];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const normalized = normalizeRoot(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

/** Whether `absolutePath` falls under any of `roots` (path-segment aware). */
export function isUnderAnyRoot(
  absolutePath: string,
  roots: readonly string[]
): boolean {
  return roots.some(
    (root) => absolutePath === root || absolutePath.startsWith(`${root}/`)
  );
}

/**
 * Probe `relativePath` against each root in order; resolve to the first
 * absolute path that exists, or `null` when no root contains it.
 *
 * `pathExists` is injected so the policy stays a pure, unit-testable
 * function (production passes `exists` from `@tauri-apps/plugin-fs`).
 * Probe failures on one root (permission errors etc.) are treated as
 * "not here" and the scan continues.
 */
export async function resolveFileAgainstRoots(
  relativePath: string,
  roots: readonly string[],
  pathExists: (absolutePath: string) => Promise<boolean>
): Promise<string | null> {
  const cleanRelative = relativePath.replace(/^\.\//, "");
  if (!cleanRelative) return null;
  for (const root of roots) {
    const candidate = `${root}/${cleanRelative}`;
    let found = false;
    try {
      found = await pathExists(candidate);
    } catch {
      found = false;
    }
    if (found) return candidate;
  }
  return null;
}
