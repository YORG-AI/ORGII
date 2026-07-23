/**
 * useGlobalTokens - Hook for managing global design tokens
 *
 * Scans the repository for CSS variable definitions and provides:
 * - Auto-discovered tokens from CSS/SCSS files
 * - Token values and sources
 * - Token categories for the browser design panel
 *
 * @see docs/architecture-guide/orgii-editor/orgii-project-format-0130.md
 */
import { invoke } from "@tauri-apps/api/core";
import { useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  type AsyncResourceFetchContext,
  useAsyncResource,
} from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import {
  type TokenDefinition,
  scannedTokensAtom,
} from "@src/store/workstation/browser/tokens/tokenAtoms";

const log = createLogger("useGlobalTokens");

// Re-export for consumers
export type { TokenDefinition } from "@src/store/workstation/browser/tokens/tokenAtoms";

// ============================================
// Types
// ============================================

export interface TokenDefinitionsResult {
  tokens: TokenDefinition[];
}

export interface TokenCategory {
  name: string;
  tokens: TokenDefinition[];
  expanded: boolean;
}

export interface UseGlobalTokensOptions {
  /** Repository path */
  repoPath?: string;
  /** Auto-scan on mount */
  autoScan?: boolean;
  /** Maximum directory depth for scanning */
  maxDepth?: number;
}

export interface UseGlobalTokensReturn {
  /** All discovered tokens */
  tokens: TokenDefinition[];
  /** Tokens grouped by category */
  categories: TokenCategory[];
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Scan repo for tokens */
  scan: () => Promise<void>;
  /** Search tokens by name */
  search: (query: string) => TokenDefinition[];
  /** Get token by name */
  getToken: (name: string) => TokenDefinition | undefined;
  /** Generate CSS for selected tokens */
  generateCSS: (tokenNames: string[]) => string;
}

// ============================================
// Helpers
// ============================================

/**
 * Categorize tokens by their prefix
 */
function categorizeTokens(tokens: TokenDefinition[]): TokenCategory[] {
  const categoryMap = new Map<string, TokenDefinition[]>();

  for (const token of tokens) {
    // Extract category from token name
    // e.g., "primary-6" -> "primary", "color-text-1" -> "color"
    const parts = token.name.split("-");
    const category = parts.length > 1 ? parts[0] : "other";

    const existing = categoryMap.get(category) ?? [];
    existing.push(token);
    categoryMap.set(category, existing);
  }

  // Convert to array and sort
  const categories: TokenCategory[] = [];

  // Priority categories first
  const priorityOrder = [
    "primary",
    "color",
    "danger",
    "warning",
    "success",
    "gray",
    "blue",
    "red",
    "green",
  ];

  for (const name of priorityOrder) {
    const tokens = categoryMap.get(name);
    if (tokens) {
      categories.push({ name, tokens, expanded: false });
      categoryMap.delete(name);
    }
  }

  // Add remaining categories alphabetically
  const remaining = Array.from(categoryMap.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  for (const [name, tokens] of remaining) {
    categories.push({ name, tokens, expanded: false });
  }

  return categories;
}

// ============================================
// Hook
// ============================================

export function useGlobalTokens(
  options: UseGlobalTokensOptions = {}
): UseGlobalTokensReturn {
  const { repoPath, autoScan = true, maxDepth = 5 } = options;
  const setScannedTokens = useSetAtom(scannedTokensAtom);

  const fetchTokens = useCallback(
    async (
      serializedScope: string,
      context: AsyncResourceFetchContext<TokenDefinition[]>
    ) => {
      const scope = JSON.parse(serializedScope) as {
        maxDepth: number;
        repoPath: string;
      };
      try {
        const result = await invoke<TokenDefinitionsResult>(
          "scan_global_tokens",
          {
            repoPath: scope.repoPath,
            maxDepth: scope.maxDepth,
          }
        );
        if (context.isCurrent()) setScannedTokens(result.tokens);
        return result.tokens;
      } catch (error) {
        log.error(
          "[useGlobalTokens] Scan failed:",
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    },
    [setScannedTokens]
  );
  const scopeKey = repoPath ? JSON.stringify({ maxDepth, repoPath }) : null;
  const resource = useAsyncResource<TokenDefinition[]>({
    autoLoad: autoScan,
    enabled: Boolean(scopeKey),
    fetcher: fetchTokens,
    initialData: [],
    scopeKey,
  });
  const tokens = resource.data;
  const categories = useMemo(() => categorizeTokens(tokens), [tokens]);
  const refreshTokens = resource.refresh;
  const scan = useCallback(async () => {
    if (!repoPath) {
      log.warn("[useGlobalTokens] No repo path provided");
      return;
    }
    await refreshTokens();
  }, [refreshTokens, repoPath]);

  /**
   * Search tokens by name
   */
  const search = useCallback(
    (query: string): TokenDefinition[] => {
      if (!query) return tokens;

      const lower = query.toLowerCase();
      return tokens.filter(
        (t) =>
          t.name.toLowerCase().includes(lower) ||
          t.value.toLowerCase().includes(lower)
      );
    },
    [tokens]
  );

  /**
   * Get token by name
   */
  const getToken = useCallback(
    (name: string): TokenDefinition | undefined => {
      return tokens.find((t) => t.name === name);
    },
    [tokens]
  );

  /**
   * Generate CSS for selected tokens
   */
  const generateCSS = useCallback(
    (tokenNames: string[]): string => {
      const declarations: string[] = [];

      for (const name of tokenNames) {
        const token = tokens.find((t) => t.name === name);
        if (token) {
          declarations.push(`--${token.name}: ${token.value};`);
        }
      }

      if (declarations.length === 0) return "";

      return `:root {\n  ${declarations.join("\n  ")}\n}`;
    },
    [tokens]
  );

  return {
    tokens,
    categories,
    loading: resource.loading,
    error: resource.error,
    scan,
    search,
    getToken,
    generateCSS,
  };
}

export default useGlobalTokens;
