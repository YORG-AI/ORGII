/**
 * Message Notification Component
 *
 * A minimalist, elegant notification system.
 *
 * Features:
 * - Clean animations with Framer Motion
 * - Auto-dismiss after 1 seconds (default)
 * - Deduplication to prevent spam
 * - Solid background styling
 * - Lucide icons
 *
 * @example
 * ```tsx
 * import { Message } from "@src/components/Message";
 *
 * Message.success("Operation successful!");
 * Message.error("Something went wrong");
 * Message.warning("Please be careful");
 * Message.info({ content: "Info message", closable: true });
 * ```
 */
import type { ReactNode } from "react";
import { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

import {
  DEFAULT_DURATION,
  type MessageConfig,
  type MessageType,
} from "./types";

export type { MessageConfig, MessageType } from "./types";

// The toast renderer (framer-motion + icons) is loaded on the first toast so
// the ~170 KB animation stack stays out of the startup graph. Auto-dismiss
// timers start on item mount, so deferring the first paint by one chunk load
// does not shorten a toast's visible lifetime.
const LazyMessageContainer = lazy(() => import("./MessageContainer"));

// ============================================
// Message Manager (Singleton)
// ============================================

class MessageManager {
  private container: HTMLDivElement | null = null;
  private root: ReturnType<typeof createRoot> | null = null;
  private messages: Map<string, MessageConfig> = new Map();
  private idCounter = 0;
  private recentHashes: Set<string> = new Set();

  private ensureContainer() {
    if (!this.container) {
      this.container = document.createElement("div");
      this.container.className =
        "pointer-events-none fixed right-4 bottom-4 left-auto z-[10000] flex flex-col items-end max-[480px]:right-2 max-[480px]:bottom-2 max-[480px]:left-2";
      this.container.setAttribute("data-message-root", "true");
      document.body.appendChild(this.container);
      this.root = createRoot(this.container);
    }
  }

  private generateId(): string {
    return `msg-${Date.now()}-${this.idCounter++}`;
  }

  /**
   * Generate a hash for deduplication based on type + content + title
   */
  private generateHash(config: MessageConfig): string {
    const contentStr =
      typeof config.content === "string"
        ? config.content
        : JSON.stringify(config.content);
    return `${config.type || "info"}:${config.title || ""}:${contentStr}`;
  }

  private render() {
    if (!this.root) return;

    this.root.render(
      <Suspense fallback={null}>
        <LazyMessageContainer
          messages={new Map(this.messages)}
          onRemove={(id) => {
            this.messages.delete(id);
            this.render();
          }}
        />
      </Suspense>
    );
  }

  private add(config: MessageConfig): string {
    this.ensureContainer();

    const id = config.id || this.generateId();

    // Fixed IDs are update slots: callers use them to replace live progress
    // and must also be able to reopen the same content immediately after a
    // manual close. Only generated one-shot messages participate in dedupe.
    if (!config.id) {
      const hash = this.generateHash(config);
      if (this.recentHashes.has(hash)) {
        return ""; // Skip duplicate
      }

      this.recentHashes.add(hash);
      setTimeout(
        () => {
          this.recentHashes.delete(hash);
        },
        (config.duration || DEFAULT_DURATION) + 500
      );
    }

    // Limit one-shot messages to a soft maximum of three. Replacing an
    // existing slot does not evict anything, and persistent progress notices
    // are never chosen as eviction candidates.
    if (!this.messages.has(id) && this.messages.size >= 3) {
      const firstDismissible = Array.from(this.messages.entries()).find(
        ([, message]) => !message.persistent
      );
      if (firstDismissible) this.messages.delete(firstDismissible[0]);
    }

    this.messages.set(id, config);
    this.render();

    return id;
  }

  private createMethod(type: MessageType) {
    return (
      content: ReactNode | MessageConfig,
      durationOrConfig?: number | Partial<MessageConfig>
    ): string => {
      let config: MessageConfig;

      if (
        typeof content === "object" &&
        content !== null &&
        "content" in content
      ) {
        config = { ...content, type };
      } else if (typeof durationOrConfig === "object") {
        config = { content, type, ...durationOrConfig };
      } else {
        config = { content, type, duration: durationOrConfig };
      }

      return this.add(config);
    };
  }

  public success = this.createMethod("success");
  public error = this.createMethod("error");
  public warning = this.createMethod("warning");
  public info = this.createMethod("info");

  public remove(id: string): void {
    this.messages.delete(id);
    this.render();
  }

  public clear(): void {
    this.messages.clear();
    this.render();
  }

  public destroy(): void {
    this.clear();
    if (this.container && this.container.parentNode) {
      this.root?.unmount();
      this.container.parentNode.removeChild(this.container);
      this.container = null;
      this.root = null;
    }
  }
}

// ============================================
// Singleton Export
// ============================================

const Message = new MessageManager();

export default Message;
export { Message };
