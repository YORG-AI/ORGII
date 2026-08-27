/**
 * FilePreviewers
 *
 * Barrel export for all file preview components.
 */

export { PreviewBottomBar, formatFileSize } from "./PreviewBottomBar";
export type { PreviewBottomBarProps } from "./PreviewBottomBar";

export { ImagePreview } from "./ImagePreview";
export type { ImagePreviewProps } from "./ImagePreview";

export { VideoPreview } from "./VideoPreview";
export type { VideoPreviewProps } from "./VideoPreview";

export { JsonTreeView } from "./JsonTreeView";
export type { JsonTreeViewProps } from "./JsonTreeView";

export { DbPreviewView } from "./DbPreviewView";
export type { DbPreviewViewProps } from "./DbPreviewView";

export { PdfPreview } from "./PdfPreview";
export type { PdfPreviewProps } from "./PdfPreview";

// DocxPreview (mammoth + its XML/Promise deps, ~475 KB) and PptxPreview
// (jszip, ~95 KB) are deliberately NOT re-exported as values: every mount
// site lazy-loads them from their leaf modules (`React.lazy(() =>
// import("./DocxPreview"))`), and a value re-export here would pull both
// document parsers into any chunk that imports `ImagePreview` or
// `JsonTreeView` from this barrel. Types only.
export type { DocxPreviewProps } from "./DocxPreview";
export type { PptxPreviewProps } from "./PptxPreview";

export { PagesPreview } from "./PagesPreview";
export type { PagesPreviewProps } from "./PagesPreview";
