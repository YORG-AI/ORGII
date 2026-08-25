/**
 * Diagnostic Health Atom
 *
 * Tracks the health status of diagnostic sources (LSP, ESLint).
 * Updated from the CodeMirror linter extension (outside React) via
 * getInstrumentedStore() — the same store the React tree uses.
 * Read by React components to show actionable status in the Problems panel.
 */
import { atom } from "jotai";

import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

// ============================================
// Types
// ============================================

export type DiagnosticSourceStatus =
  | "unknown"
  | "initializing"
  | "active"
  | "failed"
  | "unavailable";

export interface DiagnosticSourceInfo {
  status: DiagnosticSourceStatus;
  /** Human-readable error message */
  error?: string;
  /** Language ID (e.g., "typescript") */
  language?: string;
  /** Install hint for missing tools */
  installHint?: string;
  /** Timestamp of last status change */
  lastUpdated: number;
}

export interface DiagnosticHealthState {
  /** LSP source status per language */
  lsp: Map<string, DiagnosticSourceInfo>;
  /** ESLint source status per file path */
  eslint: DiagnosticSourceInfo | null;
  /** Whether any source is currently active */
  hasActiveSource: boolean;
}

// ============================================
// Atom
// ============================================

const DEFAULT_HEALTH: DiagnosticHealthState = {
  lsp: new Map(),
  eslint: null,
  hasActiveSource: false,
};

export const diagnosticHealthAtom = atom<DiagnosticHealthState>(DEFAULT_HEALTH);

// ============================================
// Updater Functions (callable from outside React)
// ============================================

/** Get the app's Jotai store (same one the React tree uses). */
function getStore() {
  if (!isStoreInitialized()) return null;
  return getInstrumentedStore();
}

function computeHasActiveSource(state: DiagnosticHealthState): boolean {
  if (state.eslint?.status === "active") return true;
  for (const [_key, info] of state.lsp) {
    if (info.status === "active") return true;
  }
  return false;
}

/**
 * Update LSP health status for a language.
 * Callable from CodeMirror extensions (outside React).
 */
export function updateLspHealth(
  language: string,
  status: DiagnosticSourceStatus,
  error?: string,
  installHint?: string
): void {
  const store = getStore();
  if (!store) return;
  const current = store.get(diagnosticHealthAtom);
  const nextLsp = new Map(current.lsp);
  nextLsp.set(language, {
    status,
    error,
    language,
    installHint,
    lastUpdated: Date.now(),
  });
  const nextState: DiagnosticHealthState = {
    ...current,
    lsp: nextLsp,
    hasActiveSource: false, // recomputed below
  };
  nextState.hasActiveSource = computeHasActiveSource(nextState);
  store.set(diagnosticHealthAtom, nextState);
}

/**
 * Update ESLint health status.
 * Callable from CodeMirror extensions (outside React).
 */
export function updateEslintHealth(
  status: DiagnosticSourceStatus,
  error?: string
): void {
  const store = getStore();
  if (!store) return;
  const current = store.get(diagnosticHealthAtom);
  const nextState: DiagnosticHealthState = {
    ...current,
    eslint: {
      status,
      error,
      lastUpdated: Date.now(),
    },
    hasActiveSource: false, // recomputed below
  };
  nextState.hasActiveSource = computeHasActiveSource(nextState);
  store.set(diagnosticHealthAtom, nextState);
}

/**
 * Reset all health status (e.g., on repo change).
 */
export function resetDiagnosticHealth(): void {
  const store = getStore();
  if (!store) return;
  store.set(diagnosticHealthAtom, DEFAULT_HEALTH);
}

// ============================================
// LSP Install Prompt
// ============================================

export interface LspInstallPromptState {
  /** Language to install (e.g., "javascript", "python") */
  language: string;
  /** Install hint / command from backend */
  installHint: string;
}

/** Current install prompt (null = no prompt showing) */
export const lspInstallPromptAtom = atom<LspInstallPromptState | null>(null);

/** Languages the user has dismissed this session - won't prompt again */
const dismissedLspPromptsAtom = atom<Set<string>>(new Set<string>());

/**
 * Show an LSP install prompt for a language.
 * Only shows if the language hasn't been dismissed this session.
 */
export function showLspInstallPrompt(
  language: string,
  installHint: string
): void {
  const store = getStore();
  if (!store) return;
  const dismissed = store.get(dismissedLspPromptsAtom);
  if (dismissed.has(language)) return;
  // Don't overwrite an existing prompt for a different language
  const current = store.get(lspInstallPromptAtom);
  if (current !== null) return;
  store.set(lspInstallPromptAtom, { language, installHint });
}

/**
 * Dismiss the current install prompt. Won't show again for this language this session.
 */
export function dismissLspInstallPrompt(): void {
  const store = getStore();
  if (!store) return;
  const current = store.get(lspInstallPromptAtom);
  if (current) {
    const dismissed = new Set(store.get(dismissedLspPromptsAtom));
    dismissed.add(current.language);
    store.set(dismissedLspPromptsAtom, dismissed);
  }
  store.set(lspInstallPromptAtom, null);
}

// ============================================
// LSP Retry Trigger
// ============================================

/** Increment to trigger LSP retry after install. Linter extension subscribes to this. */
export const lspRetryTriggerAtom = atom(0);

/**
 * Signal the linter extension to retry LSP connection (e.g., after
 * install or after the user clicks Retry).
 *
 * Also clears the Rust-side broken-cooldown for every server so the
 * retry can actually re-spawn instead of being short-circuited by the
 * 5-minute cooldown. The `lsp_revive_all` call is fire-and-forget; if
 * Tauri is unavailable (e.g. during tests) we still bump the trigger.
 */
export function triggerLspRetry(): void {
  const store = getStore();
  if (!store) return;
  const current = store.get(lspRetryTriggerAtom);

  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<number>("lsp_revive_all"))
    .catch(() => {
      // Non-Tauri environment / command not available — the retry will
      // still happen, it just won't clear cooldown. Fail open.
    });

  store.set(lspRetryTriggerAtom, current + 1);
}
