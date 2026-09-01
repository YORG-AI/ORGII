/**
 * Toast renderer for `Message` — split out of `index.tsx` so framer-motion
 * (and its icons) load lazily on the first toast instead of sitting in
 * the startup graph of every module that imports the `Message` API.
 */
import { AnimatePresence, motion } from "framer-motion";
import type { FC } from "react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import {
  Alert01Icon,
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  HugeiconsIcon,
  InformationCircleIcon,
} from "@src/icons";

import {
  DEFAULT_DURATION,
  type MessageConfig,
  type MessageItemProps,
  type MessageType,
} from "./types";

// ============================================
// Config
// ============================================

const ICONS: Record<MessageType, typeof CheckmarkCircle01Icon> = {
  success: CheckmarkCircle01Icon,
  error: AlertCircleIcon,
  warning: Alert01Icon,
  info: InformationCircleIcon,
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
  action,
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
  const iconNode = icon || <AnyIcon icon={IconComponent} size={18} />;
  const hasDescription = Boolean(title || download || cancel || action);
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
  const handlePrimaryAction = useCallback(() => {
    action?.onClick();
    if (action?.closeOnClick !== false) {
      handleClose();
    }
  }, [action, handleClose]);

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
          <div className="text-[13px] leading-[1.4] font-semibold tracking-[-0.01em] text-text-1 max-[480px]:text-xs">
            {title}
          </div>
        )}
        <div
          className={`text-[13px] leading-normal wrap-break-word max-[480px]:text-xs ${
            title ? "font-[450] text-text-2" : "font-medium text-text-1"
          }`}
        >
          {content}
        </div>
        {(download || cancel || action) && (
          <div className="mt-2 flex justify-end gap-3">
            {cancel && (
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0 text-xs leading-[1.2] font-medium text-primary-6 hover:text-primary-5 hover:underline"
                onClick={handleCancelAction}
              >
                {cancel.label ?? t("actions.cancel")}
              </button>
            )}
            {download && (
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0 text-xs leading-[1.2] font-medium text-primary-6 hover:text-primary-5 hover:underline"
                onClick={handleDownload}
              >
                {download.label ?? t("actions.download")}
              </button>
            )}
            {action && (
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0 text-xs leading-[1.2] font-semibold text-primary-6 hover:text-primary-5 hover:underline"
                onClick={handlePrimaryAction}
              >
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Close button */}
      {closable && (
        <button
          className="my-[-2px] mr-[-4px] ml-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 text-text-3 opacity-60 transition-all duration-150 ease-out hover:bg-white/10 hover:text-text-1 hover:opacity-100 active:scale-95"
          onClick={handleClose}
          aria-label={t("actions.close")}
        >
          <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
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

export default MessageContainer;
