/** Returns the final repository-name segment for compact UI labels. */
export function compactRepositoryLabel(
  repository: string | null | undefined
): string {
  const normalized = repository?.trim().replace(/\\/g, "/") ?? "";
  if (!normalized) return "";
  const segments = normalized.split("/").filter(Boolean);
  const repositoryName = (segments.at(-1) ?? normalized)
    .split(/[?#]/, 1)[0]
    .replace(/\.git$/i, "");
  return repositoryName;
}
