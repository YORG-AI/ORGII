import { GITHUB_PR_FILES_API_LIMIT } from "@src/api/tauri/github";

/** Display the GitHub PR-files response ceiling as a lower bound. */
export function formatPrFilesCount(fileCount: number): number | string {
  return fileCount >= GITHUB_PR_FILES_API_LIMIT
    ? `${GITHUB_PR_FILES_API_LIMIT}+`
    : fileCount;
}
