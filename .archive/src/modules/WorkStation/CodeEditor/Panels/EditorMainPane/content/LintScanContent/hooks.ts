/**
 * Lint scan hooks — cached tool loading and lazy language composition.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import type { LintToolInfo } from "@src/modules/MainApp/Integrations/DevTools/LanguageServersPage/types";

import { LANGUAGE_DEFS } from "./config";
import type { LanguageStat } from "./types";

const log = createLogger("LintScanContent");

/**
 * Lightweight lint tool loader for the scan tab.
 * Uses lint_get_cached (instant, from Rust memory) to populate the grid
 * immediately. Falls back to lint_check_installed only if cache is empty,
 * and never blocks the UI.
 *
 * Unlike useLintTools (Settings page), this skips workspace config and
 * install/uninstall machinery to avoid spawning ~12 shell processes on mount.
 */
export function useCachedLintTools() {
  const [tools, setTools] = useState<LintToolInfo[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const { invoke } = await import("@tauri-apps/api/core");

      const cached = await invoke<LintToolInfo[]>("lint_get_cached");
      if (cancelled) return;
      if (cached.length > 0) {
        setTools(cached);
        return;
      }

      const fresh = await invoke<LintToolInfo[]>("lint_check_installed");
      if (!cancelled) setTools(fresh);
    };

    load().catch((err) => {
      if (!cancelled) {
        log.warn("[LintScanContent] Failed to load lint tools:", err);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return tools;
}

/** Lazy language composition — only fetches when `detect()` is called. */
export function useLanguageComposition(repoPath: string) {
  const [stats, setStats] = useState<LanguageStat[]>([]);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  const detect = useCallback(async () => {
    if (!repoPath || fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const allExtensions = LANGUAGE_DEFS.flatMap((lang) => lang.extensions);
      const allFiles = await invoke<string[]>("find_files_by_extension", {
        directory: repoPath,
        extensions: allExtensions,
      });

      const extCounts = new Map<string, number>();
      for (const filePath of allFiles) {
        const dotIdx = filePath.lastIndexOf(".");
        if (dotIdx === -1) continue;
        const ext = filePath.slice(dotIdx + 1).toLowerCase();
        extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      }

      const results: LanguageStat[] = [];
      for (const def of LANGUAGE_DEFS) {
        let count = 0;
        for (const ext of def.extensions) {
          count += extCounts.get(ext) ?? 0;
        }
        if (count > 0) {
          results.push({ ...def, fileCount: count });
        }
      }
      results.sort((langA, langB) => langB.fileCount - langA.fileCount);
      setStats(results);
    } catch (err) {
      log.warn("[LintScanContent] Language detection failed:", err);
      fetchedRef.current = false;
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  return { stats, loading, detect };
}
