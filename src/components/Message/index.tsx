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
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
} from "lucide-react";
import type { FC, ReactNode, Ref } from "react";
import { useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";

// ============================================
// Types
// ============================================

export type MessageType = "success" | "error" | "warning" | "info";

export interface MessageConfig {
  content: ReactNode;
  type?: MessageType;
  duration?: number;
  closable?: boolean;
  onClose?: () => void;
  icon?: ReactNode;
  className?: string;
  id?: string;
  /** Keep this message from being evicted by the three-message soft limit. */
  persistent?: boolean;
  /** Optional title for the message */
  title?: string;
  /** Optional download action shown in the toast */
  download?: {
    fileName: string;
    content: string | Blob;
    mimeType?: string;
    label?: string;
  };
  /** Optional cancel action shown in the toast */
  cancel?: {
    label?: string;
    onClick?: () => void;
    closeOnClick?: boolean;
  };
}

interface MessageItemProps extends MessageConfig {
  id: string;
  onRemove: (id: string) => void;
  ref?: Ref<HTMLDivElement>;
}

// ============================================
// Config
// ============================================

const ICONS: Record<MessageType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const TYPE_STYLES: Record<MessageType, { border: string; icon: string }> = {
  success: {
    border: "border-success-6/30",
    icon: "bg-success-6/15 text-success-6",
  },
  error: {
    border: "border-danger-6/30",
    icon: "bg-danger-6/15 text-danger-6",
  },
  warning: {
    border: "border-warning-6/30",
    icon: "bg-warning-6/15 text-warning-6",
  },
  info: {
    border: "border-primary-6/30",
    icon: "bg-primary-6/15 text-primary-6",
  },
};

const DEFAULT_DURATION = 1000;

// ============================================
// Message Item Component
// ============================================

const MessageItem = ({
  id,
  content,
  title,
  type = "info",
  duration = DEFAULT_DURATION,
  closable = true,
  onClose,
  onRemove,
  icon,
  className = "",
  download,
  cancel,
  ref,
}: MessageItemProps) => {
  const { t } = useTranslation();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClose = useCallback(() => {
    onRemove(id);
    onClose?.();
  }, [id, onRemove, onClose]);

  // Auto dismiss timer
  useEffect(() => {
    if (duration <= 0) return;

    timerRef.current = setTimeout(() => {
      handleClose();
    }, duration);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [duration, handleClose]);

  const IconComponent = ICONS[type];
  const typeStyle = TYPE_STYLES[type];
  const iconNode = icon || <IconComponent size={18} />;
  const hasDescription = Boolean(title || download || cancel);
  const handleDownload = useCallback(() => {
    const blob =
      download?.content instanceof Blob
        ? download.content
        : new Blob([download?.content ?? ""], {
            type: download?.mimeType ?? "text/plain;charset=utf-8",
          });

    const objectUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement("a");
    downloadLink.href = objectUrl;
    downloadLink.download = download?.fileName ?? "message.txt";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(objectUrl);
  }, [download]);
  const handleCancelAction = useCallback(() => {
    cancel?.onClick?.();
    if (cancel?.closeOnClick !== false) {
      handleClose();
    }
  }, [cancel, handleClose]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={{
        opacity: 1,
        y: 0,
      }}
      exit={{
        opacity: 0,
      }}
      transition={{
        duration: 0.2,
        ease: "easeOut",
      }}
      className={`pointer-events-auto relative flex w-full cursor-default gap-3 overflow-hidden rounded-xl border bg-bg-2 p-[14px_16px] shadow-[0_2px_4px_rgba(0,0,0,0.04),0_12px_24px_rgba(0,0,0,0.08)] transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-px hover:shadow-[0_4px_8px_rgba(0,0,0,0.06),0_16px_32px_rgba(0,0,0,0.12)] max-[480px]:gap-2.5 max-[480px]:rounded-[10px] max-[480px]:p-[12px_14px] ${hasDescription ? "items-start" : "items-center"} ${typeStyle.border} ${className}`}
    >
      {/* Icon */}
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg max-[480px]:h-6 max-[480px]:w-6 max-[480px]:rounded-md ${typeStyle.icon}`}
      >
        {iconNode}
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && (
          <div className="text-[13px] font-semibold leading-[1.4] tracking-[-0.01em] text-text-1 max-[480px]:text-xs">
            {title}
          </div>
        )}
        <div
          className={`break-words text-[13px] leading-[1.5] max-[480px]:text-xs ${
            title ? "font-[450] text-text-2" : "font-medium text-text-1"
          }`}
        >
          {content}
        </div>
        {(download || cancel) && (
          <div className="mt-2 flex justify-end gap-3">
            {cancel && (
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0 text-xs font-medium leading-[1.2] text-primary-6 hover:text-primary-5 hover:underline"
                onClick={handleCancelAction}
              >
                {cancel.label ?? t("actions.cancel")}
              </button>
            )}
            {download && (
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0 text-xs font-medium leading-[1.2] text-primary-6 hover:text-primary-5 hover:underline"
                onClick={handleDownload}
              >
                {download.label ?? t("actions.download")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Close button */}
      {closable && (
        <button
          className="my-[-2px] ml-1 mr-[-4px] flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 text-text-3 opacity-60 transition-all duration-150 ease-out hover:bg-white/10 hover:text-text-1 hover:opacity-100 active:scale-95"
          onClick={handleClose}
          aria-label={t("actions.close")}
        >
          <X size={14} />
        </button>
      )}
    </motion.div>
  );
};

MessageItem.displayName = "MessageItem";

// ============================================
// Message Container Component
// ============================================

interface MessageContainerProps {
  messages: Map<string, MessageConfig>;
  onRemove: (id: string) => void;
}

const MessageContainer: FC<MessageContainerProps> = ({
  messages,
  onRemove,
}) => {
  const messageArray = Array.from(messages.entries());

  return (
    <div className="flex w-auto max-w-[380px] flex-col-reverse items-end gap-2 max-[480px]:max-w-full">
      <AnimatePresence>
        {messageArray.map(([id, config]) => (
          <MessageItem key={id} id={id} {...config} onRemove={onRemove} />
        ))}
      </AnimatePresence>
    </div>
  );
};

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
      <MessageContainer
        messages={new Map(this.messages)}
        onRemove={(id) => {
          this.messages.delete(id);
          this.render();
        }}
      />
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
