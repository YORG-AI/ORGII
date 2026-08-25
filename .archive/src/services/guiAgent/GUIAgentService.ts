/**
 * GUI Agent Service
 *
 * Singleton service that manages GUI Agent output logging.
 * Can be called from middleware (outside React) and integrates
 * with the Output panel through a connected hook.
 *
 * Usage:
 *   // In middleware:
 *   GUIAgentService.logAction("test.run", { testId: "123" }, "user");
 *
 *   // In React (connects the output channel):
 *   GUIAgentService.connect(outputState);
 */
import type { ActionResult } from "@src/ActionSystem/schema/defineZodAction";
import type { UseOutputChannelsReturn } from "@src/types/workstation/output";

// ============================================
// ANSI Color Codes
// ============================================

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

// ============================================
// Types
// ============================================

type LogLevel = "info" | "success" | "warning" | "error";
type Source = "user" | "ai" | "system";

interface LogEntry {
  type: "action" | "result" | "error" | "message";
  timestamp: number;
  actionType?: string;
  payload?: Record<string, unknown>;
  source?: Source;
  result?: ActionResult;
  durationMs?: number;
  error?: unknown;
  message?: string;
  level?: LogLevel;
}

// ============================================
// Service
// ============================================

class GUIAgentServiceClass {
  private outputState: UseOutputChannelsReturn | null = null;
  private channelId: string | null = null;
  private enabled = true;
  private pendingLogs: LogEntry[] = [];

  /**
   * Connect the service to the output panel state.
   * Call this from a React component/hook.
   */
  connect(outputState: UseOutputChannelsReturn): void {
    this.outputState = outputState;

    // Create or find the GUI Agent channel
    const channel = outputState.channels.find((ch) => ch.type === "gui-agent");
    if (!channel) {
      this.channelId = outputState.createChannel("GUI Agent", "gui-agent");
    } else {
      this.channelId = channel.id;
    }

    // Flush any pending logs
    this.flushPendingLogs();
  }

  /**
   * Disconnect from output state (call on unmount)
   */
  disconnect(): void {
    this.outputState = null;
    this.channelId = null;
  }

  /**
   * Enable or disable logging
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Get the channel ID
   */
  getChannelId(): string | null {
    return this.channelId;
  }

  /**
   * Log an action dispatch
   */
  logAction(
    actionType: string,
    payload: Record<string, unknown>,
    source: Source
  ): void {
    if (!this.enabled) return;

    const entry: LogEntry = {
      type: "action",
      timestamp: Date.now(),
      actionType,
      payload,
      source,
    };

    if (this.outputState && this.channelId) {
      this.writeActionLog(entry);
    } else {
      this.pendingLogs.push(entry);
    }
  }

  /**
   * Log an action result
   */
  logResult(
    actionType: string,
    result: ActionResult,
    durationMs: number
  ): void {
    if (!this.enabled) return;

    const entry: LogEntry = {
      type: "result",
      timestamp: Date.now(),
      actionType,
      result,
      durationMs,
    };

    if (this.outputState && this.channelId) {
      this.writeResultLog(entry);
    } else {
      this.pendingLogs.push(entry);
    }
  }

  /**
   * Log an error
   */
  logError(actionType: string, error: unknown): void {
    if (!this.enabled) return;

    const entry: LogEntry = {
      type: "error",
      timestamp: Date.now(),
      actionType,
      error,
    };

    if (this.outputState && this.channelId) {
      this.writeErrorLog(entry);
    } else {
      this.pendingLogs.push(entry);
    }
  }

  /**
   * Log a general message
   */
  log(message: string, level: LogLevel = "info"): void {
    if (!this.enabled) return;

    const entry: LogEntry = {
      type: "message",
      timestamp: Date.now(),
      message,
      level,
    };

    if (this.outputState && this.channelId) {
      this.writeMessageLog(entry);
    } else {
      this.pendingLogs.push(entry);
    }
  }

  /**
   * Clear the channel
   */
  clear(): void {
    if (this.outputState && this.channelId) {
      this.outputState.clearChannel(this.channelId);
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const ts = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
    return `${ANSI.dim}${ANSI.italic}${ts}${ANSI.reset}`;
  }

  private formatSource(source: Source): string {
    switch (source) {
      case "ai":
        return `${ANSI.magenta}[AI]${ANSI.reset}`;
      case "user":
        return `${ANSI.blue}[USER]${ANSI.reset}`;
      case "system":
        return `${ANSI.gray}[SYS]${ANSI.reset}`;
    }
  }

  private writeActionLog(entry: LogEntry): void {
    if (!this.outputState || !this.channelId) return;

    const timestamp = this.formatTimestamp(entry.timestamp);
    const sourceBadge = this.formatSource(entry.source!);

    // Format payload (compact JSON)
    const payloadStr =
      entry.payload && Object.keys(entry.payload).length > 0
        ? ` ${ANSI.gray}${JSON.stringify(entry.payload)}${ANSI.reset}`
        : "";

    const message = `${timestamp} ${sourceBadge} ${ANSI.cyan}${entry.actionType}${ANSI.reset}${payloadStr}\n`;
    this.outputState.appendToChannel(this.channelId, message);
  }

  private writeResultLog(entry: LogEntry): void {
    if (!this.outputState || !this.channelId) return;

    const timestamp = this.formatTimestamp(entry.timestamp);
    const result = entry.result!;
    const icon = result.success ? "✓" : "✗";
    const color = result.success ? ANSI.green : ANSI.red;
    const duration = `${ANSI.gray}[${entry.durationMs?.toFixed(0)}ms]${ANSI.reset}`;

    let message = `${timestamp}   ${color}${icon}${ANSI.reset} ${entry.actionType} ${duration}`;

    if (result.message) {
      message += ` ${ANSI.dim}${result.message}${ANSI.reset}`;
    }

    this.outputState.appendToChannel(this.channelId, message + "\n");
  }

  private writeErrorLog(entry: LogEntry): void {
    if (!this.outputState || !this.channelId) return;

    const timestamp = this.formatTimestamp(entry.timestamp);
    const errorMsg =
      entry.error instanceof Error ? entry.error.message : String(entry.error);

    const message = `${timestamp}   ${ANSI.red}✗ ${entry.actionType} failed: ${errorMsg}${ANSI.reset}\n`;
    this.outputState.appendToChannel(this.channelId, message);
  }

  private writeMessageLog(entry: LogEntry): void {
    if (!this.outputState || !this.channelId) return;

    const timestamp = this.formatTimestamp(entry.timestamp);

    let color: string;
    let prefix: string;
    switch (entry.level) {
      case "success":
        color = ANSI.green;
        prefix = "✓";
        break;
      case "warning":
        color = ANSI.yellow;
        prefix = "⚠";
        break;
      case "error":
        color = ANSI.red;
        prefix = "✗";
        break;
      default:
        color = ANSI.cyan;
        prefix = "ℹ";
    }

    const message = `${timestamp} ${color}${prefix}${ANSI.reset} ${entry.message}\n`;
    this.outputState.appendToChannel(this.channelId, message);
  }

  private flushPendingLogs(): void {
    if (!this.outputState || !this.channelId) return;

    for (const entry of this.pendingLogs) {
      switch (entry.type) {
        case "action":
          this.writeActionLog(entry);
          break;
        case "result":
          this.writeResultLog(entry);
          break;
        case "error":
          this.writeErrorLog(entry);
          break;
        case "message":
          this.writeMessageLog(entry);
          break;
      }
    }

    this.pendingLogs = [];
  }
}

// Export singleton instance
export const GUIAgentService = new GUIAgentServiceClass();
