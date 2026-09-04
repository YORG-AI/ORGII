export const parseUrlParams = (url: string) => {
  // Extract seId
  const seId = url.match(/[?&]seId=([^&]+)/)?.[1];

  // Extract and decode selectedModules (needs to be decoded twice)
  const selectedModulesMatch = url.match(/[?&]selectedModules=([^&]+)/)?.[1];
  const selectedModules = selectedModulesMatch
    ? JSON.parse(decodeURIComponent(decodeURIComponent(selectedModulesMatch)))
    : null;

  // Extract timestamp
  const timestamp = url.match(/[?&]timestamp=(\d+)/)?.[1];

  // Extract mode
  const mode = url.match(/[?&]mode=([^&]+)/)?.[1];
  // Extract projectId
  const projectId = url.match(/[?&]projectId=([^&]+)/)?.[1];

  return {
    seId,
    selectedModules,
    timestamp: Number(timestamp),
    mode,
    projectId,
  };
};
