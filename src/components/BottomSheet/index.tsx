/**
 * BottomSheet — mobile-first overlay panel anchored to the viewport bottom.
 *
 * Use for permission, question, and plan flows on narrow viewports and the
 * Mobile Remote PWA. Desktop chat continues to use composer-stack cards.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Cancel01Icon, HugeiconsIcon } from "@src/icons";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";

import "./index.scss";

export interface BottomSheetProps {
  open: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  /** When false, scrim tap and Escape do not close the sheet. */
  dismissible?: boolean;
  /** Optional stable id for aria-labelledby wiring. */
  titleId?: string;
  /** Accessible label used by the scrim and optional close button. */
  closeLabel?: string;
  /** Shows a visible close affordance in the sheet header. */
  showCloseButton?: boolean;
  className?: string;
  bodyClassName?: string;
  zIndex?: number;
}

const BottomSheet: React.FC<BottomSheetProps> = ({
  open,
  onClose,
  title,
  footer,
  children,
  dismissible = true,
  titleId: titleIdProp,
  closeLabel = "Close",
  showCloseButton = false,
  className = "",
  bodyClassName = "",
  zIndex = 9999,
}) => {
  const generatedTitleId = useId();
  const titleId = titleIdProp ?? generatedTitleId;
  const panelRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(open);
  if (open && !visible) setVisible(true);
  const closing = visible && !open;

  useOverlayLayer(open || closing);

  useEffect(() => {
    if (open || !visible) return;
    const timer = window.setTimeout(() => {
      setVisible(false);
      previousActiveElement.current?.focus?.();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, visible]);

  useEffect(() => {
    if (!open) return;
    previousActiveElement.current = document.activeElement as HTMLElement;
  }, [open]);

  useEffect(() => {
    if (!open || !dismissible) return;
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
      }
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, dismissible, onClose]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const handleScrimClick = useCallback(() => {
    if (dismissible) onClose?.();
  }, [dismissible, onClose]);

  if (!visible) return null;

  return createPortal(
    <div
      className={[
        "orgii-bottom-sheet-wrapper",
        closing && "orgii-bottom-sheet-wrapper--closing",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ zIndex }}
      role="presentation"
    >
      <button
        type="button"
        className="orgii-bottom-sheet-scrim"
        aria-label={closeLabel}
        tabIndex={-1}
        onClick={handleScrimClick}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`orgii-bottom-sheet-panel ${className}`.trim()}
      >
        <div className="orgii-bottom-sheet-handle" aria-hidden="true" />
        {title ? (
          <div className="orgii-bottom-sheet-header">
            <div id={titleId} className="orgii-bottom-sheet-title">
              {title}
            </div>
            {showCloseButton && dismissible ? (
              <button
                type="button"
                className="orgii-bottom-sheet-close"
                aria-label={closeLabel}
                onClick={onClose}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={18} />
              </button>
            ) : null}
          </div>
        ) : null}
        {children ? (
          <div className={`orgii-bottom-sheet-body ${bodyClassName}`.trim()}>
            {children}
          </div>
        ) : null}
        {footer ? (
          <div className="orgii-bottom-sheet-footer">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body
  );
};

BottomSheet.displayName = "BottomSheet";

export default BottomSheet;
