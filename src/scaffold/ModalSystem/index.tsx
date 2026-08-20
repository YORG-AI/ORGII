/**
 * Custom Modal Component - No Arco Dependencies
 *
 * A fully custom modal implementation with solid backgrounds.
 *
 * Features:
 * - Solid background with clean design
 * - Portal rendering for proper z-index management
 * - Click outside to close
 * - ESC key to close
 * - Focus trap for accessibility
 * - Smooth animations
 * - Keyboard navigation support
 * - Support for okButtonProps and cancelButtonProps for button styling
 */
import { X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import Button from "@src/components/Button";
// Deep imports on purpose: the `layouts/blocks` barrel re-exports
// SessionTable → SettingsTable → @tanstack/react-table, and Modal sits in the
// startup graph (QuitConfirmationModal is mounted at boot).
import PanelFooter from "@src/modules/shared/layouts/blocks/PanelFooter";
import PanelHeader, {
  PANEL_HEADER_TOKENS,
} from "@src/modules/shared/layouts/blocks/PanelHeader";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";

import "./index.scss";

/**
 * z-index for popup panels (Select dropdowns etc.) that must stack above a
 * Modal's default overlay (9999). One canonical value — per-dialog copies of
 * this constant kept drifting into magic numbers.
 */
export const MODAL_SELECT_Z_INDEX = 10_000;

export interface ModalProps {
  /** Controls modal visibility */
  visible: boolean;
  /** Callback when modal is closed */
  onClose?: () => void;

  onCancel?: () => void;

  onOk?: () => void | Promise<void>;
  /** Modal title */
  title?: React.ReactNode;
  /** Modal content */
  children?: React.ReactNode;
  /** Footer content (buttons, etc) */
  footer?: React.ReactNode;
  /** Show the default footer top border. */
  footerTopBorder?: boolean;

  okText?: string;

  cancelText?: string;
  /** Secondary action button size in default footer */
  secondaryButtonSize?: "small" | "default";
  /** Primary action button size in default footer */
  primaryButtonSize?: "small" | "default";

  okButtonProps?: {
    status?: "danger" | "warning" | "success" | "default";
    loading?: boolean;
    disabled?: boolean;
  };

  cancelButtonProps?: {
    disabled?: boolean;
  };
  /** Custom close icon */
  closeIcon?: React.ReactNode;
  /** Additional className for the modal container */
  className?: string;
  /** Additional className for the modal body */
  bodyClassName?: string;
  /** Show close button in header */
  closable?: boolean;
  /** Allow clicking outside modal to close */
  maskClosable?: boolean;
  /** Allow ESC key to close modal */
  escToExit?: boolean;
  /** Border radius in pixels - defaults to 16 for modern look */
  radius?: number;
  /** Modal width */
  width?: number | string;
  /** Modal size preset */
  size?: "small" | "medium" | "large" | "fullscreen";
  /** z-index for the modal (default: 9999 to ensure it's above all content) */
  zIndex?: number;
  /** Height of the draggable top app chrome area within the modal overlay. */
  topDragZoneHeight?: number;
  /** Style object for the modal */
  style?: React.CSSProperties;
}

const Modal: React.FC<ModalProps> = ({
  visible,
  onClose,
  onCancel,
  onOk,
  title,
  children,
  footer,
  footerTopBorder = true,
  okText = "OK",
  cancelText = "Cancel",
  secondaryButtonSize = "small",
  primaryButtonSize = "small",
  okButtonProps,
  cancelButtonProps,
  closeIcon,
  className = "",
  bodyClassName = "p-3",
  closable = true,
  maskClosable = true,
  escToExit = true,
  radius = 16,
  width,
  size,
  zIndex = 9999,
  topDragZoneHeight = 0,
  style,
}) => {
  const handleClose = onClose || onCancel;
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const [okLoading, setOkLoading] = useState(false);

  useOverlayLayer(visible);

  // Store the previously focused element
  useEffect(() => {
    if (visible) {
      previousActiveElement.current = document.activeElement as HTMLElement;
    }
  }, [visible]);

  // Handle ESC key press
  useEffect(() => {
    if (!visible || !escToExit) return;

    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose?.();
      }
    };

    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [visible, escToExit, handleClose]);

  // Handle click outside modal
  const handleMaskClick = useCallback(
    (e: React.MouseEvent) => {
      if (maskClosable && e.target === e.currentTarget) {
        handleClose?.();
      }
    },
    [maskClosable, handleClose]
  );

  // Handle OK button click
  const handleOk = useCallback(async () => {
    if (!onOk) return;

    if (okButtonProps?.loading !== undefined) {
      // If okButtonProps.loading is controlled externally, just call onOk
      await onOk();
    } else {
      // Otherwise, manage loading state internally
      setOkLoading(true);
      try {
        await onOk();
      } finally {
        setOkLoading(false);
      }
    }
  }, [onOk, okButtonProps?.loading]);

  // Render default footer if onOk is provided but no custom footer
  const renderFooter = () => {
    if (footer !== undefined) {
      return footer || null;
    }

    if (onOk) {
      const isLoading = okButtonProps?.loading ?? okLoading;
      const isDisabled = okButtonProps?.disabled;
      const primaryVariant =
        okButtonProps?.status === "danger" ? "danger" : "primary";

      return (
        <PanelFooter
          secondaryButtonSize={secondaryButtonSize}
          primaryButtonSize={primaryButtonSize}
          noBorder={!footerTopBorder}
          secondaryActions={
            cancelText
              ? [
                  {
                    label: cancelText,
                    onClick: () => {
                      handleClose?.();
                    },
                    variant: "secondary",
                    disabled: cancelButtonProps?.disabled,
                  },
                ]
              : undefined
          }
          primaryAction={{
            label: okText,
            onClick: () => {
              void handleOk();
            },
            disabled: isDisabled || isLoading,
            loading: isLoading,
            variant: primaryVariant,
          }}
        />
      );
    }

    return null;
  };

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (visible) {
      const scrollbarWidth =
        window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = "hidden";
      document.body.style.paddingRight = `${scrollbarWidth}px`;

      return () => {
        document.body.style.overflow = "";
        document.body.style.paddingRight = "";

        // Restore focus to previously focused element
        if (previousActiveElement.current) {
          previousActiveElement.current.focus();
        }
      };
    }
  }, [visible]);

  // Focus trap - keep focus within modal
  useEffect(() => {
    if (!visible || !modalRef.current) return;

    const modal = modalRef.current;
    const focusableElements = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const primaryElement = modal.querySelector(
      "[data-modal-primary-action]"
    ) as HTMLElement | null;
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[
      focusableElements.length - 1
    ] as HTMLElement;
    const initialFocusElement = primaryElement ?? firstElement;

    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      if (event.shiftKey) {
        if (document.activeElement === firstElement) {
          event.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          event.preventDefault();
          firstElement?.focus();
        }
      }
    };

    modal.addEventListener("keydown", handleTab as EventListener);

    // Auto-focus the primary action when provided, otherwise the first focusable element.
    setTimeout(() => {
      initialFocusElement?.focus();
    }, 100);

    return () => {
      modal.removeEventListener("keydown", handleTab as EventListener);
    };
  }, [visible]);

  if (!visible) return null;

  const sizeClass = size ? `modal-${size}` : "";
  const mergedStyle = { ...style, ...(width ? { width } : {}) };

  const modalContent = (
    <div
      className="liquid-modal-wrapper"
      style={{ zIndex }}
      onClick={handleMaskClick}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
    >
      {/* Backdrop/Mask */}
      <div className="liquid-modal-mask" />

      {topDragZoneHeight > 0 && (
        <div
          data-tauri-drag-region
          className="liquid-modal-drag-zone"
          style={{ height: topDragZoneHeight }}
          aria-hidden
        />
      )}

      {/* Modal Container */}
      <div className="liquid-modal-container">
        <div
          ref={modalRef}
          className={`liquid-modal-content ${sizeClass} ${className}`}
          style={{ ...mergedStyle, borderRadius: radius }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          {title && (
            <PanelHeader
              title={typeof title === "string" ? title : undefined}
              actions={
                closable ? (
                  <Button
                    {...PANEL_HEADER_TOKENS.actionButton}
                    icon={
                      closeIcon || (
                        <X
                          size={PANEL_HEADER_TOKENS.buttonIconSize}
                          strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                        />
                      )
                    }
                    onClick={handleClose}
                    title="Close"
                    htmlType="button"
                  />
                ) : undefined
              }
            >
              {typeof title === "string" ? undefined : title}
            </PanelHeader>
          )}

          {/* Body */}
          <div className={`liquid-modal-body ${bodyClassName}`}>{children}</div>

          {/* Footer */}
          {renderFooter()}
        </div>
      </div>
    </div>
  );

  // Render modal in a portal to body
  return createPortal(modalContent, document.body);
};

export default Modal;
