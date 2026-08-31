/**
 * LSP Client Manager
 *
 * Manages multiple LSP clients (one per language).
 * Provides a singleton instance for managing LSP connections across the app.
 */
import { setGlobalLspDiagnostics } from "@/src/store/workstation/codeEditor/diagnostics";

import { LspClient, type LspClientOptions } from "./LspClient";
import { lspDiagnosticToAppDiagnostic } from "./types";

// Dynamic import helper for Tauri
async function tauriInvoke<T>(
  cmd: string,
  args: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Info returned by lsp_check_installed for a single language */
interface LanguageServerInfo {
  language: string;
  displayName: string;
  command: string;
  installHint: string;
  installed: boolean;
}

class LspClientManager {
  private clients = new Map<string, LspClient>();
  private rootPath: string = "";
  /**
   * Cached install hints per language (populated lazily). The hint is
   * stored as `undefined` when the underlying binary is already
   * installed, so the Problems panel / install prompt stop nagging
   * users to `npm install` something they already have. The cache
   * still contains an entry for installed languages so subsequent
   * `getInstallHint` calls short-circuit.
   */
  private installHints = new Map<string, string | undefined>();

  setRootPath(path: string) {
    this.rootPath = path;
  }

  /**
   * Get base language key for client lookup.
   * Variants share a single server process (e.g. scss→css, jsonc→json).
   * Must match the keys accepted by `get_server_command()` in Rust.
   */
  private getBaseLanguage(language: string): string {
    if (language.startsWith("typescript")) return "typescript";
    if (language.startsWith("javascript")) return "javascript";

    // CSS variants all use vscode-css-language-server
    if (language === "scss" || language === "sass" || language === "less")
      return "css";

    // JSON variants use vscode-json-language-server
    if (language === "jsonc") return "json";

    // Markdown variants use marksman
    if (language === "mdx") return "markdown";

    // Clojure variants use clojure-lsp
    if (language === "clojurescript") return "clojure";

    return language;
  }

  /**
   * Fetch the install hint for a language from the Rust backend, but
   * ONLY when the corresponding binary is not already installed on
   * `PATH`. When the binary is present, `undefined` is returned so the
   * caller (linter extension → Problems panel / install prompt) does
   * not nag the user to `npm install` something they already have —
   * the LSP failure is then almost certainly a runtime issue (e.g.
   * cooldown, init timeout) rather than a missing binary.
   *
   * Caches results to avoid repeated Tauri calls.
   */
  async getInstallHint(language: string): Promise<string | undefined> {
    const baseLanguage = this.getBaseLanguage(language);
    if (this.installHints.has(baseLanguage)) {
      return this.installHints.get(baseLanguage);
    }

    try {
      const servers = await tauriInvoke<LanguageServerInfo[]>(
        "lsp_check_installed",
        {}
      );
      for (const server of servers) {
        this.installHints.set(
          server.language,
          server.installed ? undefined : server.installHint
        );
      }
      return this.installHints.get(baseLanguage);
    } catch (_error) {
      return undefined;
    }
  }

  /**
   * Drop the cached install-hint result for a language so the next
   * `getInstallHint` call re-queries the backend. Used after an
   * install/uninstall completes so the cached `installed` bit doesn't
   * go stale.
   */
  invalidateInstallHint(language: string): void {
    this.installHints.delete(this.getBaseLanguage(language));
  }

  async getOrCreateClient(
    language: string,
    options?: Partial<LspClientOptions>
  ): Promise<LspClient> {
    // Use base language for client lookup (typescript for both ts and tsx)
    const baseLanguage = this.getBaseLanguage(language);

    if (!this.clients.has(baseLanguage)) {
      const client = new LspClient({
        language: baseLanguage,
        rootPath: this.rootPath,
        ...options,
      });

      // Fallback: when diagnostics arrive for a file with no active
      // editor tab, push them to the global Jotai atom so the Problems
      // panel keeps showing last-known diagnostics (VS Code behaviour).
      client.setFallbackDiagnosticHandler((uri, rawDiagnostics) => {
        const filePath = uri.replace(/^file:\/\//, "");
        const appDiags = rawDiagnostics.map((lspDiag) =>
          lspDiagnosticToAppDiagnostic(lspDiag, filePath)
        );
        setGlobalLspDiagnostics(filePath, appDiags);
      });

      await client.initialize();
      this.clients.set(baseLanguage, client);
    }

    return this.clients.get(baseLanguage)!;
  }

  async shutdown(): Promise<void> {
    for (const [_language, client] of this.clients) {
      await client.shutdown();
    }
    this.clients.clear();
  }
}

export const lspClientManager = new LspClientManager();
