/**
 * Search Actions (Zod-based)
 *
 * Actions for searching codebase and files.
 * Uses the Search sidebar for visual text search experience.
 * Returns structured search results in `data` for LLM consumption.
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { openEditorSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { SearchService } from "@src/services/search";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import type { SearchResultFile } from "@src/store/workstation/codeEditor/search";

// ============================================
// Helper: Format search results for LLM
// ============================================

function formatSearchResultsForLLM(
  results: SearchResultFile[],
  query: string
): string {
  if (results.length === 0) {
    return `No results found for "${query}"`;
  }

  const totalMatches = results.reduce(
    (sum, file) => sum + file.matches.length,
    0
  );
  const lines: string[] = [];
  lines.push(
    `Found ${totalMatches} match(es) in ${results.length} file(s) for "${query}":`
  );

  // Show up to 20 files, 5 matches per file
  const maxFiles = 20;
  const maxMatchesPerFile = 5;
  const displayedFiles = results.slice(0, maxFiles);

  for (const file of displayedFiles) {
    lines.push(`\n${file.file_path}:`);
    const displayedMatches = file.matches.slice(0, maxMatchesPerFile);
    for (const match of displayedMatches) {
      lines.push(`  ${match.line}: ${match.text.trim()}`);
    }
    if (file.matches.length > maxMatchesPerFile) {
      lines.push(
        `  ... and ${file.matches.length - maxMatchesPerFile} more match(es)`
      );
    }
  }

  if (results.length > maxFiles) {
    lines.push(`\n... and ${results.length - maxFiles} more file(s)`);
  }

  return lines.join("\n");
}

// ============================================
// Search Actions Factory
// ============================================

/**
 * Create search actions with repoPath closure
 */
export function createSearchZodActions(repoPath: string) {
  const searchCodebase = defineZodAction(
    {
      id: ACTION_ID.SEARCH_CODEBASE,
      category: "search",
      layer: "action",
      description:
        "Search for text across the entire codebase. Returns matching file paths and line contents.",
      params: z.object({
        query: z
          .string()
          .min(1, "Query cannot be empty")
          .describe("Search query (text or regex pattern)"),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe("Case sensitive search"),
      }),
      shortcut: getShortcutKeys("search_files"),
      examples: [
        "search for TODO",
        "find all usages of useState",
        "grep error",
      ],
    },
    async ({ query, caseSensitive }) => {
      await WorkStationViewService.openSearchSidebar(query);

      // Also run the actual search to get structured results
      try {
        const results = await SearchService.searchCodebase(query, repoPath, {
          caseSensitive: caseSensitive ?? false,
        });

        const totalMatches = results.reduce(
          (sum, file) => sum + file.matches.length,
          0
        );

        return {
          success: true,
          message: `Found ${totalMatches} match(es) in ${results.length} file(s)`,
          data: {
            query,
            text: formatSearchResultsForLLM(results, query),
            results,
            totalFiles: results.length,
            totalMatches,
          },
        };
      } catch (error) {
        return {
          success: false,
          message: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  );

  const searchFiles = defineZodAction(
    {
      id: ACTION_ID.SEARCH_FILES,
      category: "search",
      layer: "action",
      description: "Search for files by name using spotlight",
      params: z.object({
        query: z
          .string()
          .min(1, "Query cannot be empty")
          .describe("File name pattern"),
      }),
      shortcut: getShortcutKeys("quick_open"),
      examples: ["find file config", "search for package.json"],
    },
    async ({ query }) => {
      openEditorSpotlight(query);

      return {
        success: true,
        message: `Searching for: ${query}`,
      };
    }
  );

  return [searchCodebase, searchFiles];
}

// Default export for static registration (when repoPath not needed)
export const searchZodActions = createSearchZodActions("");
