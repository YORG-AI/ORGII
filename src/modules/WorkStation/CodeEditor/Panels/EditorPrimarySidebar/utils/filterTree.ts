/**
 * Tree Filtering Utility
 *
 * Two modes of operation:
 * 1. filterTree() - Client-side filtering of already-loaded tree (instant, limited scope)
 * 2. buildTreeFromSearchResults() - Build tree from flat search results (comprehensive)
 *
 * For comprehensive search, use buildTreeFromSearchResults with searchFilesNative results.
 * This matches Spotlight's search mechanism for consistency.
 *
 * Used by EditorPrimarySidebar for file filtering.
 */
import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";

// ============================================
// Types
// ============================================

export interface FilterTreeOptions {
  /** Search query string */
  query: string;
  /** Whether to match case-sensitively (default: false) */
  caseSensitive?: boolean;
  /** Whether to match against full path, not just name (default: true) */
  matchPath?: boolean;
  /** Whether to use fuzzy matching (default: true) */
  fuzzyMatch?: boolean;
}

export interface FilterTreeResult {
  /** Filtered tree with only matching branches */
  filteredTree: TreePanelNode[];
  /** Total number of matching files */
  matchCount: number;
  /** Set of paths that matched the query */
  matchingPaths: Set<string>;
}

// ============================================
// Fuzzy Matching
// ============================================

/**
 * Simple fuzzy match - checks if all characters in query appear in target in order
 * Similar to VS Code's file finder behavior
 *
 * @example
 * fuzzyMatch("cpt", "component") // true (c...o-m-p-o-n-e-n-t)
 * fuzzyMatch("abc", "axbxc") // true
 * fuzzyMatch("abc", "acb") // false (b before c)
 */
function fuzzyMatch(query: string, target: string): boolean {
  if (query.length === 0) return true;
  if (query.length > target.length) return false;

  let queryIndex = 0;
  for (let targetIndex = 0; targetIndex < target.length; targetIndex++) {
    if (query[queryIndex] === target[targetIndex]) {
      queryIndex++;
      if (queryIndex === query.length) return true;
    }
  }
  return false;
}

/**
 * Check if a node matches the search query
 */
function nodeMatchesQuery(
  node: TreePanelNode,
  query: string,
  options: FilterTreeOptions
): boolean {
  const {
    caseSensitive = false,
    matchPath = true,
    fuzzyMatch: useFuzzy = true,
  } = options;

  // Prepare strings for comparison
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const targetName = caseSensitive ? node.name : node.name.toLowerCase();
  const targetPath = caseSensitive ? node.path : node.path.toLowerCase();

  // Check name match
  if (useFuzzy) {
    if (fuzzyMatch(normalizedQuery, targetName)) return true;
  } else {
    if (targetName.includes(normalizedQuery)) return true;
  }

  // Check path match if enabled
  if (matchPath) {
    if (useFuzzy) {
      if (fuzzyMatch(normalizedQuery, targetPath)) return true;
    } else {
      if (targetPath.includes(normalizedQuery)) return true;
    }
  }

  return false;
}

// ============================================
// Tree Filtering
// ============================================

/**
 * Recursively filter tree nodes, keeping directories that contain matches
 *
 * @returns Tuple of [filteredNodes, hasMatch] where hasMatch indicates
 *          if any descendant matched (used for parent inclusion)
 */
function filterNodes(
  nodes: TreePanelNode[],
  options: FilterTreeOptions,
  matchingPaths: Set<string>
): [TreePanelNode[], boolean] {
  const { query } = options;
  const result: TreePanelNode[] = [];
  let hasAnyMatch = false;

  for (const node of nodes) {
    const isDirectory = node.type === "directory";
    const nodeMatches = nodeMatchesQuery(node, query, options);

    if (isDirectory && node.children) {
      // Recursively filter children
      const [filteredChildren, childrenHaveMatch] = filterNodes(
        node.children,
        options,
        matchingPaths
      );

      // Include directory if:
      // 1. Directory name itself matches, OR
      // 2. Any descendant matches
      if (nodeMatches || childrenHaveMatch) {
        hasAnyMatch = true;

        // If directory matches, include all children (expanded)
        // If only children match, include filtered children
        const includedChildren = nodeMatches ? node.children : filteredChildren;

        result.push({
          ...node,
          children: includedChildren,
          expanded: true, // Auto-expand to show matches
        });

        if (nodeMatches) {
          matchingPaths.add(node.path);
        }
      }
    } else if (isDirectory) {
      // Empty directory - only include if name matches
      if (nodeMatches) {
        hasAnyMatch = true;
        matchingPaths.add(node.path);
        result.push({
          ...node,
          expanded: true,
        });
      }
    } else {
      // File node - include if matches
      if (nodeMatches) {
        hasAnyMatch = true;
        matchingPaths.add(node.path);
        result.push(node);
      }
    }
  }

  return [result, hasAnyMatch];
}

/**
 * Filter a tree structure to show only nodes matching the query
 *
 * Preserves tree hierarchy - directories containing matches are kept
 * and auto-expanded to reveal matching files.
 *
 * @param nodes - Root nodes of the tree
 * @param options - Filter options (query, case sensitivity, etc.)
 * @returns Filtered tree with match statistics
 *
 * @example
 * ```typescript
 * const { filteredTree, matchCount } = filterTree(treeData, {
 *   query: "comp",
 *   matchPath: true,
 * });
 * ```
 */
export function filterTree(
  nodes: TreePanelNode[],
  options: FilterTreeOptions
): FilterTreeResult {
  // Handle empty query - return original tree
  if (!options.query || options.query.trim().length === 0) {
    return {
      filteredTree: nodes,
      matchCount: 0,
      matchingPaths: new Set(),
    };
  }

  const matchingPaths = new Set<string>();
  const [filteredTree] = filterNodes(nodes, options, matchingPaths);

  // Count only file matches (not directories)
  let matchCount = 0;
  for (const path of matchingPaths) {
    // Simple heuristic: files typically have extensions
    if (path.includes(".") && !path.endsWith("/")) {
      matchCount++;
    }
  }

  return {
    filteredTree,
    matchCount,
    matchingPaths,
  };
}

/**
 * Count total nodes in a tree (for determining if client-side filter is appropriate)
 */
export function countTreeNodes(nodes: TreePanelNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count++;
    if (node.children) {
      count += countTreeNodes(node.children);
    }
  }
  return count;
}

// ============================================
// Build Tree from Search Results
// ============================================

/**
 * File search result from searchFilesNative
 */
export interface FileSearchResultItem {
  path: string;
  filename: string;
  type: "file" | "folder";
  score: number;
}

/**
 * Build a hierarchical tree structure from flat search results
 *
 * This matches Spotlight's search mechanism - uses searchFilesNative results
 * and builds a tree for display in the explorer.
 *
 * @param results - Flat array of file search results
 * @param repoPath - Repository root path (to create relative paths)
 * @returns TreePanelNode[] with auto-expanded directories
 *
 * @example
 * ```typescript
 * const results = await searchFilesNative({ root_path: repoPath, query: "index" });
 * const tree = buildTreeFromSearchResults(
 *   results.files.map(f => ({ path: f.path, filename: f.filename, type: "file", score: f.score })),
 *   repoPath
 * );
 * ```
 */
export function buildTreeFromSearchResults(
  results: FileSearchResultItem[],
  repoPath: string
): TreePanelNode[] {
  if (results.length === 0) return [];

  const root: TreePanelNode[] = [];
  const directoryMap = new Map<string, TreePanelNode>();

  // Sort by path for consistent tree structure
  const sortedResults = [...results].sort((resultA, resultB) =>
    resultA.path.localeCompare(resultB.path)
  );

  // Deduplicate results by path — the backend may return the same path
  // as both a file and folder result, or multiple times via symlinks.
  const seenPaths = new Set<string>();

  for (const result of sortedResults) {
    if (seenPaths.has(result.path)) continue;
    seenPaths.add(result.path);

    // Convert absolute path to relative path
    let relativePath = result.path;
    if (relativePath.startsWith(repoPath)) {
      relativePath = relativePath.substring(repoPath.length);
      if (relativePath.startsWith("/")) {
        relativePath = relativePath.substring(1);
      }
    }

    const parts = relativePath.split("/");
    let currentPath = repoPath;
    let currentLevel = root;

    // Process each directory level
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const isLastPart = index === parts.length - 1;
      currentPath = `${currentPath}/${part}`;

      if (isLastPart) {
        // Check if this node was already created as an intermediate directory.
        // A folder can appear as both a search result AND as a parent of
        // another result — without this check it gets added twice.
        const existing = directoryMap.get(currentPath);
        if (!existing) {
          const node: TreePanelNode = {
            id: result.path,
            name: part,
            path: result.path,
            type: result.type === "folder" ? "directory" : "file",
            expanded: result.type === "folder",
            ...(result.type === "folder" ? { children: [] } : {}),
          };
          currentLevel.push(node);

          // Register folder results in directoryMap so later results
          // that pass through this folder find it instead of duplicating.
          if (result.type === "folder") {
            directoryMap.set(currentPath, node);
          }
        }
      } else {
        // This is an intermediate directory
        let dirNode = directoryMap.get(currentPath);

        if (!dirNode) {
          // Create new directory node (auto-expanded to show matches)
          dirNode = {
            id: currentPath,
            name: part,
            path: currentPath,
            type: "directory",
            children: [],
            expanded: true, // Auto-expand to show matching files
          };
          directoryMap.set(currentPath, dirNode);
          currentLevel.push(dirNode);
        }

        // Move to the next level
        currentLevel = dirNode.children!;
      }
    }
  }

  return root;
}
