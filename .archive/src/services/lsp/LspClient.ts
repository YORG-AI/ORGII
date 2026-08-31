/**
 * LSP Client
 *
 * Main LSP client wrapper that communicates with Rust backend via Tauri commands.
 * Handles document synchronization and LSP protocol communication.
 *
 * Diagnostics arrive via the code editor WebSocket (type: "lsp:diagnostics"),
 * NOT via Tauri events. The backend broadcasts diagnostics to all connected
 * WebSocket clients.
 */
import {
  type CodeEditorWebSocketMessage,
  getCodeEditorWebSocket,
} from "@src/api/realtime/codeEditorWebSocket";
import { createLogger } from "@src/hooks/logger";

import type { LspDiagnostic } from "./types";

const log = createLogger("LSP");

// Dynamic import helpers for Tauri
async function tauriInvoke<T>(
  cmd: string,
  args: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface LspClientOptions {
  language: string;
  rootPath: string;
}

type DiagnosticListener = (diagnostics: LspDiagnostic[]) => void;

/**
 * Fallback handler called when diagnostics arrive for a URI that has no
 * active per-file listener (e.g. the editor tab was closed).  This
 * allows a global store to keep diagnostics up-to-date for closed files.
 */
export type FallbackDiagnosticHandler = (
  uri: string,
  diagnostics: LspDiagnostic[]
) => void;

export class LspClient {
  private language: string;
  private rootPath: string;
  private documentVersion = 0;
  private openDocuments = new Set<string>();
  private diagnosticListeners = new Map<string, DiagnosticListener>();
  private unsubscribeWs?: () => void;
  private fallbackHandler?: FallbackDiagnosticHandler;

  constructor(options: LspClientOptions) {
    this.language = options.language;
    this.rootPath = options.rootPath;
  }

  /**
   * Set a fallback handler for diagnostics that arrive when no per-file
   * listener is registered (e.g. tab closed).
   */
  setFallbackDiagnosticHandler(handler: FallbackDiagnosticHandler): void {
    this.fallbackHandler = handler;
  }

  async initialize(): Promise<void> {
    try {
      await tauriInvoke("lsp_start_server", {
        language: this.language,
        rootPath: this.rootPath,
      });

      // Listen for diagnostics via WebSocket (the backend broadcasts
      // textDocument/publishDiagnostics through ws, not Tauri events)
      this.subscribeToWsDiagnostics();
    } catch (error) {
      log.error(`[LSP] Failed to start ${this.language} server:`, error);
      throw error;
    }
  }

  /**
   * Subscribe to WebSocket diagnostics.  If the WS client isn't
   * available yet (race during startup), retry a few times with
   * increasing delay so we don't silently drop diagnostics.
   */
  private subscribeToWsDiagnostics(attempt = 0): void {
    if (this.unsubscribeWs) return; // already subscribed

    const wsClient = getCodeEditorWebSocket();
    if (wsClient) {
      this.unsubscribeWs = wsClient.on<CodeEditorWebSocketMessage>(
        "lsp:diagnostics",
        (msg) => {
          this.handleWsDiagnostics(msg);
        }
      );
      return;
    }

    // WebSocket not ready yet — retry up to 5 times (0.5s, 1s, 2s, 4s, 8s)
    const MAX_WS_RETRIES = 5;
    if (attempt < MAX_WS_RETRIES) {
      const delay = 500 * Math.pow(2, attempt);
      setTimeout(() => this.subscribeToWsDiagnostics(attempt + 1), delay);
    } else {
      log.warn(
        `[LSP] WebSocket not available after ${MAX_WS_RETRIES} retries for ${this.language} — diagnostics will not work`
      );
    }
  }

  /**
   * Handle diagnostics from the WebSocket.
   * Message shape from backend:
   * {
   *   type: "lsp:diagnostics",
   *   language: "typescript",
   *   data: { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } },
   *   timestamp: ...
   * }
   */
  private handleWsDiagnostics(msg: CodeEditorWebSocketMessage): void {
    const data = msg.data as
      | {
          params?: {
            uri?: string;
            diagnostics?: LspDiagnostic[];
          };
        }
      | undefined;

    if (!data?.params?.uri || !data?.params?.diagnostics) {
      return;
    }

    const { uri, diagnostics } = data.params;

    // Route to the per-file listener if one is active (editor tab open),
    // otherwise fall back to the global handler so the Problems panel
    // keeps showing diagnostics for closed files.
    const listener = this.diagnosticListeners.get(uri);
    if (listener) {
      listener(diagnostics);
    } else if (this.fallbackHandler) {
      this.fallbackHandler(uri, diagnostics);
    }
  }

  /**
   * Register a diagnostic listener for a specific URI
   */
  registerDiagnosticListener(uri: string, listener: DiagnosticListener): void {
    this.diagnosticListeners.set(uri, listener);
  }

  /**
   * Unregister a diagnostic listener for a specific URI
   */
  unregisterDiagnosticListener(uri: string): void {
    this.diagnosticListeners.delete(uri);
  }

  async didOpen(uri: string, text: string): Promise<void> {
    if (this.openDocuments.has(uri)) {
      return;
    }

    try {
      const languageId = this.getLanguageIdFromUri(uri);

      await tauriInvoke("lsp_did_open", {
        language: languageId,
        uri,
        version: this.documentVersion++,
        text,
      });

      this.openDocuments.add(uri);
    } catch (error) {
      log.error(`[LSP] didOpen failed for ${this.language}:`, error);
      throw error;
    }
  }

  /**
   * Get the correct language ID from URI based on file extension
   */
  private getLanguageIdFromUri(uri: string): string {
    const ext = uri.split(".").pop()?.toLowerCase();

    // Map extensions to language IDs
    const languageIdMap: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
    };

    return languageIdMap[ext || ""] || this.language;
  }

  async didChange(uri: string, text: string): Promise<void> {
    if (!this.openDocuments.has(uri)) {
      // Document not open yet, open it first
      await this.didOpen(uri, text);
      return;
    }

    try {
      await tauriInvoke("lsp_did_change", {
        language: this.language,
        uri,
        version: this.documentVersion++,
        text,
      });
    } catch (_error) {
      // Silently ignore — will retry on next content change
    }
  }

  async didClose(uri: string): Promise<void> {
    if (!this.openDocuments.has(uri)) {
      return;
    }

    try {
      await tauriInvoke("lsp_did_close", {
        language: this.language,
        uri,
      });
      this.openDocuments.delete(uri);
    } catch (_error) {
      // Silently ignore
    }
  }

  async shutdown(): Promise<void> {
    try {
      // Unsubscribe from WebSocket diagnostics
      if (this.unsubscribeWs) {
        this.unsubscribeWs();
        this.unsubscribeWs = undefined;
      }

      await tauriInvoke("lsp_shutdown", {});
      this.openDocuments.clear();
    } catch (_error) {
      // Silently ignore
    }
  }
}
