import React, {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import FileTreePreview from "./index";
import type { FileTreePreviewProps } from "./types";

const PREVIEW_SHOW_DELAY = 300;
const PREVIEW_HIDE_DELAY = 150;
const PREVIEW_GAP = 8;

type PreviewPlacement = "top" | "right" | "bottom";

interface FileTreeHoverPreviewProps {
  path: string;
  itemType?: FileTreePreviewProps["itemType"];
  repoPath?: string;
  children: ReactNode;
  className?: string;
  display?: CSSProperties["display"];
  as?: "div" | "span";
  placement?: PreviewPlacement;
  showDelayMs?: number;
}

const FileTreeHoverPreview: React.FC<FileTreeHoverPreviewProps> = ({
  path,
  itemType = "file",
  repoPath,
  children,
  className = "",
  display = "inline-flex",
  as = "span",
  placement = "top",
  showDelayMs = PREVIEW_SHOW_DELAY,
}) => {
  const anchorRef = useRef<HTMLElement | null>(null);
  const setAnchorRef = useCallback((node: HTMLElement | null) => {
    anchorRef.current = node;
  }, []);
  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewPosition, setPreviewPosition] = useState({ left: 0, top: 0 });

  const clearShowTimeout = useCallback(() => {
    if (!showTimeoutRef.current) return;
    clearTimeout(showTimeoutRef.current);
    showTimeoutRef.current = null;
  }, []);

  const clearHideTimeout = useCallback(() => {
    if (!hideTimeoutRef.current) return;
    clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = null;
  }, []);

  const updatePreviewPosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPreviewPosition(
      placement === "right"
        ? { left: rect.right + PREVIEW_GAP, top: rect.top }
        : placement === "bottom"
          ? { left: rect.left, top: rect.bottom + PREVIEW_GAP }
          : { left: rect.left, top: rect.top - 6 }
    );
  }, [placement]);

  const handleMouseEnter = useCallback(() => {
    if (!path) return;
    clearHideTimeout();
    clearShowTimeout();
    showTimeoutRef.current = setTimeout(() => {
      updatePreviewPosition();
      setShowPreview(true);
    }, showDelayMs);
  }, [
    clearHideTimeout,
    clearShowTimeout,
    path,
    showDelayMs,
    updatePreviewPosition,
  ]);

  const handleMouseLeave = useCallback(() => {
    clearShowTimeout();
    hideTimeoutRef.current = setTimeout(() => {
      setShowPreview(false);
    }, PREVIEW_HIDE_DELAY);
  }, [clearShowTimeout]);

  const handlePreviewMouseEnter = useCallback(() => {
    clearHideTimeout();
  }, [clearHideTimeout]);

  const handlePreviewMouseLeave = useCallback(() => {
    hideTimeoutRef.current = setTimeout(() => {
      setShowPreview(false);
    }, PREVIEW_HIDE_DELAY);
  }, []);

  useEffect(() => {
    return () => {
      clearShowTimeout();
      clearHideTimeout();
    };
  }, [clearHideTimeout, clearShowTimeout]);

  const anchorProps = {
    className: `min-w-0 items-center ${className}`.trim(),
    style: { display },
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
  };

  return (
    <>
      {as === "span" ? (
        <span ref={setAnchorRef} {...anchorProps}>
          {children}
        </span>
      ) : (
        <div ref={setAnchorRef} {...anchorProps}>
          {children}
        </div>
      )}
      {showPreview &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: previewPosition.left,
              top: previewPosition.top,
              transform: placement === "top" ? "translateY(-100%)" : undefined,
              zIndex: 9999,
            }}
            onMouseEnter={handlePreviewMouseEnter}
            onMouseLeave={handlePreviewMouseLeave}
          >
            <FileTreePreview
              path={path}
              itemType={itemType}
              repoPath={repoPath}
            />
          </div>,
          document.body
        )}
    </>
  );
};

FileTreeHoverPreview.displayName = "FileTreeHoverPreview";

export default FileTreeHoverPreview;
