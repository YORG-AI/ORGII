const REPOSITORY_LABEL_MAX_LENGTH = 10;

export function compactRepositoryLabel(
  repository: string | null | undefined
): string {
  const normalized = repository?.trim().replace(/\\/g, "/") ?? "";
  if (!normalized) return "";
  const segments = normalized.split("/").filter(Boolean);
  const repositoryName = (segments.at(-1) ?? normalized)
    .split(/[?#]/, 1)[0]
    .replace(/\.git$/i, "");
  return repositoryName.slice(0, REPOSITORY_LABEL_MAX_LENGTH);
}
