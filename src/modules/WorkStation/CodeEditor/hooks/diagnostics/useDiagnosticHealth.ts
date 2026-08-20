/**
 * useDiagnosticHealth Hook
 *
 * Provides diagnostic source health status for the Problems panel.
 * Reads from the diagnosticHealthAtom to show which sources are active,
 * failed, or unavailable, with actionable messages.
 */
import {
  type DiagnosticHealthState,
  type DiagnosticSourceInfo,
  type DiagnosticSourceStatus,
  diagnosticHealthAtom,
} from "@/src/store/workstation/codeEditor/diagnostics";
import { useAtomValue } from "jotai";
import { useMemo } from "react";

// ============================================
// Types
// ============================================

export interface SourceStatusMessage {
  /** Source name (e.g., "TypeScript LSP", "ESLint") */
  source: string;
  /** Current status */
  status: DiagnosticSourceStatus;
  /** User-facing message */
  message: string;
  /** Optional install command hint */
  installHint?: string;
}

export interface DiagnosticHealthSummary {
  /** Whether any diagnostic source is currently active */
  hasActiveSource: boolean;
  /** Whether all sources are still initializing */
  allInitializing: boolean;
  /** Whether any source has failed */
  hasFailed: boolean;
  /** Status messages for display */
  statusMessages: SourceStatusMessage[];
  /** Raw health state */
  health: DiagnosticHealthState;
}

// ============================================
// Constants
// ============================================

const LSP_DISPLAY_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  c: "C",
  cpp: "C++",
  java: "Java",
  csharp: "C#",
  ruby: "Ruby",
  php: "PHP",
  swift: "Swift",
  kotlin: "Kotlin",
  scala: "Scala",
  lua: "Lua",
  zig: "Zig",
  elixir: "Elixir",
  haskell: "Haskell",
  ocaml: "OCaml",
  clojure: "Clojure",
  vue: "Vue",
  svelte: "Svelte",
  shellscript: "Shell",
};

/**
 * Map language variants to their base language.
 * Variants that share the same LSP server are merged into one entry
 * in the Problems panel (e.g. typescript + typescriptreact → TypeScript).
 */
function getBaseLanguage(language: string): string {
  if (language.startsWith("typescript")) return "typescript";
  if (language.startsWith("javascript")) return "javascript";
  if (language === "scss" || language === "sass" || language === "less")
    return "css";
  if (language === "jsonc") return "json";
  if (language === "mdx") return "markdown";
  if (language === "clojurescript") return "clojure";
  return language;
}

/** Priority order: active > initializing > failed > unavailable > unknown */
const STATUS_PRIORITY: Record<DiagnosticSourceStatus, number> = {
  active: 4,
  initializing: 3,
  failed: 2,
  unavailable: 1,
  unknown: 0,
};

/**
 * Merge LSP entries that share the same base language.
 * Keeps the entry with the best status (active wins over failed).
 */
function mergeLspEntries(
  lspMap: Map<string, DiagnosticSourceInfo>
): Map<string, DiagnosticSourceInfo> {
  const merged = new Map<string, DiagnosticSourceInfo>();
  for (const [language, info] of lspMap) {
    const base = getBaseLanguage(language);
    const existing = merged.get(base);
    if (
      !existing ||
      STATUS_PRIORITY[info.status] > STATUS_PRIORITY[existing.status]
    ) {
      merged.set(base, { ...info, language: base });
    }
  }
  return merged;
}

// ============================================
// Hook
// ============================================

function buildLspMessage(info: DiagnosticSourceInfo): string {
  const displayName =
    LSP_DISPLAY_NAMES[info.language ?? ""] ?? info.language ?? "Unknown";

  switch (info.status) {
    case "initializing":
      return `${displayName} language server starting...`;
    case "active":
      return `${displayName} language server active`;
    case "failed":
      return info.error ?? `${displayName} language server failed`;
    case "unavailable":
      return `${displayName} language server not installed`;
    default:
      return `${displayName} language server status unknown`;
  }
}

function buildEslintMessage(info: DiagnosticSourceInfo): string {
  switch (info.status) {
    case "initializing":
      return "ESLint starting...";
    case "active":
      return "ESLint active";
    case "failed":
      return info.error ?? "ESLint failed to run";
    case "unavailable":
      return "ESLint not available in this project";
    default:
      return "ESLint status unknown";
  }
}

export function useDiagnosticHealth(): DiagnosticHealthSummary {
  const health = useAtomValue(diagnosticHealthAtom);

  return useMemo(() => {
    const statusMessages: SourceStatusMessage[] = [];
    let hasFailed = false;
    let allInitializing = true;
    let hasAnySource = false;

    // Process LSP sources (merged by base language)
    const mergedLsp = mergeLspEntries(health.lsp);
    for (const [_language, info] of mergedLsp) {
      hasAnySource = true;
      if (info.status !== "initializing") {
        allInitializing = false;
      }
      if (info.status === "failed" || info.status === "unavailable") {
        hasFailed = true;
      }
      statusMessages.push({
        source: `${LSP_DISPLAY_NAMES[info.language ?? ""] ?? info.language} LSP`,
        status: info.status,
        message: buildLspMessage(info),
        installHint: info.installHint,
      });
    }

    // Process ESLint
    if (health.eslint) {
      hasAnySource = true;
      if (health.eslint.status !== "initializing") {
        allInitializing = false;
      }
      if (
        health.eslint.status === "failed" ||
        health.eslint.status === "unavailable"
      ) {
        hasFailed = true;
      }
      statusMessages.push({
        source: "ESLint",
        status: health.eslint.status,
        message: buildEslintMessage(health.eslint),
      });
    }

    // If no sources at all, not initializing
    if (!hasAnySource) {
      allInitializing = false;
    }

    return {
      hasActiveSource: health.hasActiveSource,
      allInitializing,
      hasFailed,
      statusMessages,
      health,
    };
  }, [health]);
}
