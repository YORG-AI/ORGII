/**
 * EditorContent Content Components
 *
 * Barrel export for all content components.
 */

export { default as CodeViewerContent } from "./CodeViewerContent";
export type { CodeViewerContentProps } from "./CodeViewerContent";

export { default as GitDiffContent } from "./GitDiffContent";
export type { GitDiffContentProps } from "./GitDiffContent";

export { default as SourceControlMainContent } from "./SourceControlMainContent";
export { AllChangesView } from "./SourceControlMainContent";
export type { AllChangesViewProps } from "./SourceControlMainContent";

export { preloadSourceControlTabContent } from "./preloadSourceControl";

export { default as SearchEditorContent } from "./SearchEditorContent";
export type { SearchEditorContentProps } from "./SearchEditorContent/types";

// Re-export lightweight file previewers
export { ImagePreview, JsonTreeView } from "./FilePreviewContent";
