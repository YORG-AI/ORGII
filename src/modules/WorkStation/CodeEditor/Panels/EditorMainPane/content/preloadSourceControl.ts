/**
 * Preload the Source Control main-pane chunks.
 *
 * Fires the two dynamic imports (`SourceControlMainContent`, `GitDiffContent`)
 * so opening Source Control feels instant. Relocated verbatim from the
 * now-deleted `TabContentRenderer`, which used to own this preload alongside
 * its (no-op) `source-control` case. Re-exported from `./index` so
 * `CodeEditor/index.tsx`'s import stays valid.
 */
const loadSourceControlMainContent = () => import("./SourceControlMainContent");
const loadGitDiffContent = () => import("./GitDiffContent");

export function preloadSourceControlTabContent(): void {
  void loadSourceControlMainContent();
  void loadGitDiffContent();
}
