import { getPathSegments } from "@src/util/file/pathUtils";

import type { TreeNode } from "./types";

/**
 * Get a display path rooted at the repository when possible.
 * Path segments are parsed independently of the host OS because session
 * events can contain paths produced on a different platform.
 */
export function getRepoRelativePath(
  absolutePath: string,
  repoPath?: string
): string {
  const pathParts = getPathSegments(absolutePath);

  if (!repoPath) {
    const githubIdx = pathParts.findIndex(
      (part, index) =>
        part.toLowerCase() === "github" &&
        pathParts[index - 1]?.toLowerCase() === "documents"
    );
    if (githubIdx !== -1 && githubIdx + 1 < pathParts.length) {
      return pathParts.slice(githubIdx + 1).join("/");
    }
    return pathParts.join("/") || absolutePath;
  }

  const repoName = getPathSegments(repoPath).at(-1);
  if (!repoName) return pathParts.join("/") || absolutePath;

  // Windows paths are case-insensitive. Comparing normalized segment names
  // also keeps mixed-separator payloads working when the drive/root casing
  // differs between the event and the configured repository path.
  const normalizedRepoName = repoName.toLocaleLowerCase();
  const repoIdx = pathParts.findIndex(
    (part) => part.toLocaleLowerCase() === normalizedRepoName
  );

  return repoIdx !== -1
    ? pathParts.slice(repoIdx).join("/")
    : pathParts.join("/") || absolutePath;
}

/** Build the single-branch hierarchy displayed by FileTreePreview. */
export function buildFileTree(filePath: string): TreeNode[] {
  const parts = getPathSegments(filePath);
  const tree: TreeNode[] = [];
  let currentLevel = tree;

  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1;
    const node: TreeNode = {
      name: part,
      isFile: isLast,
      isHighlighted: isLast,
      children: [],
    };
    currentLevel.push(node);
    currentLevel = node.children;
  });

  return tree;
}
