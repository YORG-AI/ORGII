export function shouldShowMainChatComposer({
  showInteractArea,
  isReadOnlySurface,
  hasCloudDownloadSurface,
}: {
  showInteractArea: boolean;
  isReadOnlySurface: boolean;
  hasCloudDownloadSurface: boolean;
}): boolean {
  return showInteractArea && !isReadOnlySurface && !hasCloudDownloadSurface;
}

export function shouldShowExternalHistoryForkComposer({
  isImportedHistory,
  readOnly,
  canResume,
  hasCloudDownloadSurface,
}: {
  isImportedHistory: boolean;
  readOnly: boolean;
  canResume: boolean;
  hasCloudDownloadSurface: boolean;
}): boolean {
  return (
    !hasCloudDownloadSurface && isImportedHistory && !readOnly && canResume
  );
}
