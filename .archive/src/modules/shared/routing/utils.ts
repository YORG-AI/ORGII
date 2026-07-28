/**
 * Routing Utility Functions
 */

/**
 * Extract session ID from query parameter (?seId=xxx)
 */
export function extractSessionId(path: string, search?: string): string | null {
  if (search) {
    const params = new URLSearchParams(search);
    const seId = params.get("seId");
    if (seId) return seId;
  }
  return null;
}

/**
 * Build full workstation path with session ID query param and optional project ID
 */
export function buildSessionPath(
  seId: string,
  projectId?: string | null
): string {
  const basePath = `/orgii/workstation/code`;
  const params = new URLSearchParams({ seId });
  if (projectId) params.set("projectId", projectId);
  return `${basePath}?${params.toString()}`;
}
