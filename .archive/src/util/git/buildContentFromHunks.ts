/**
 * Build old and new content from hunks when full content is not provided
 *
 * NOTE: This is now DEPRECATED as the Rust API provides full old_content/new_content.
 * This function is kept only as a fallback for edge cases where content is missing.
 *
 * When reconstructing from hunks, we can only show the changed sections + context,
 * not the full file. This means line numbers won't match the original file.
 */
import { GitDiffHunk } from "@src/api/http/git";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("buildContentFromHunks");

export const buildContentFromHunks = (
  hunks: GitDiffHunk[]
): { oldContent: string; newContent: string } => {
  if (!hunks || hunks.length === 0) {
    return { oldContent: "", newContent: "" };
  }

  log.warn(
    "[buildContentFromHunks] Using fallback hunk reconstruction - line numbers may not match original file"
  );

  const oldLines: string[] = [];
  const newLines: string[] = [];

  // Process each hunk and collect lines
  for (const hunk of hunks) {
    // Process lines in this hunk
    for (const line of hunk.lines) {
      // Remove trailing newline if present (will be added back on join)
      const content = line.content.replace(/\n$/, "");

      if (line.type === "context") {
        // Context lines exist in both old and new
        oldLines.push(content);
        newLines.push(content);
      } else if (line.type === "deletion") {
        // Deletion only in old file
        oldLines.push(content);
      } else if (line.type === "addition") {
        // Addition only in new file
        newLines.push(content);
      }
    }
  }

  return {
    oldContent: oldLines.join("\n"),
    newContent: newLines.join("\n"),
  };
};
