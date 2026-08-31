/**
 * Which workspace root a rendered markdown file reference resolves against.
 *
 * `activeWorkspaceRootAtom` is the folder the app has focused *right now*, so
 * resolving a transcript's relative href against it silently re-points every
 * file link whenever the reader switches projects: a session recorded in repo
 * A, read while repo B is focused, would open and preview B's copy of the
 * path. Chat events carry the repo that was active when the event was emitted
 * (`SessionEvent.repoPath`), which is frozen at write time and therefore
 * survives the reader moving around.
 *
 * Surfaces that render markdown outside a transcript (issue bodies, skill
 * editors, previews) provide nothing and keep the active-workspace fallback,
 * which is the correct root for them.
 */
import { useAtomValue } from "jotai";
import { createContext, useContext } from "react";

import { activeWorkspaceRootAtom } from "@src/store/workspace";

/** Repo path stamped on the event whose markdown is being rendered. */
export const MarkdownWorkspaceRootContext = createContext<string | undefined>(
  undefined
);
MarkdownWorkspaceRootContext.displayName = "MarkdownWorkspaceRootContext";

/**
 * Prefer the event's recorded repo, fall back to the focused workspace.
 * An empty or whitespace-only stamp is treated as absent — events written
 * before a repo was loaded carry `""` rather than being omitted.
 */
export function resolveMarkdownFileRootPath(
  eventRepoPath: string | undefined,
  activeWorkspaceRootPath: string | undefined
): string {
  return (eventRepoPath?.trim() || activeWorkspaceRootPath?.trim()) ?? "";
}

/** Root that file hrefs, local images and file previews resolve against. */
export function useMarkdownFileRootPath(): string {
  const eventRepoPath = useContext(MarkdownWorkspaceRootContext);
  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  return resolveMarkdownFileRootPath(eventRepoPath, activeWorkspaceRoot?.path);
}
