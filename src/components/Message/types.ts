/**
 * Shared types for the `Message` toast system.
 */
import type { ReactNode, Ref } from "react";

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
  /** Optional primary action shown in the toast. */
  action?: {
    label: string;
    onClick: () => void;
    closeOnClick?: boolean;
  };
}

export interface MessageItemProps extends MessageConfig {
  id: string;
  onRemove: (id: string) => void;
  ref?: Ref<HTMLDivElement>;
}

export const DEFAULT_DURATION = 1000;
