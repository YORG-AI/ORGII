export function shouldShowMainChatComposer({
  showInteractArea,
  isReadOnlySurface,
  hasBlockingDownloadSurface,
}: {
  showInteractArea: boolean;
  isReadOnlySurface: boolean;
  /**
   * True only for a download with NO local transcript behind it (first
   * fetch of a fresh share). Incremental refreshes of an existing copy
   * must not hide the composer — see ChatView's gate derivation.
   */
  hasBlockingDownloadSurface: boolean;
}): boolean {
  return showInteractArea && !isReadOnlySurface && !hasBlockingDownloadSurface;
}

export function shouldShowExternalHistoryContinuationComposer({
  isImportedHistory,
  readOnly,
  hasBlockingDownloadSurface,
}: {
  isImportedHistory: boolean;
  readOnly: boolean;
  hasBlockingDownloadSurface: boolean;
}): boolean {
  return !hasBlockingDownloadSurface && isImportedHistory && !readOnly;
}
