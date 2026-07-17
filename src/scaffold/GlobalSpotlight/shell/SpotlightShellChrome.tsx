/**
 * SpotlightShellChrome
 *
 * Low-level chrome for SpotlightShell: simple panel + optional portal +
 * backdrop + viewport-centered positioning + footer slot beneath the panel.
 *
 * This is a direct merge of the previous SelectorContainer + SpotlightPortal
 * layer. Only consumed by SpotlightShell; palettes never see this component.
 */
import { useAtomValue } from "jotai";
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";
import { spotlightPlacementAtom } from "@src/store/ui/uiAtom";

import { SPOTLIGHT_CONFIG } from "../constants";
import { SPOTLIGHT_STYLES } from "../styles";

// ============ TYPES ============

export interface SpotlightShellChromeProps {
  isOpen: boolean;
  onClose: () => void;
  asPortal: boolean;
  stopPropagation: boolean;
  width: number;
  footer: React.ReactNode;
  children: React.ReactNode;
}

// ============ COMPONENT ============

export const SpotlightShellChrome: React.FC<SpotlightShellChromeProps> = ({
  isOpen,
  onClose,
  asPortal,
  stopPropagation,
  width,
  footer,
  children,
}) => {
  const inputHostRef = useRef<HTMLDivElement | null>(null);
  const spotlightPlacement = useAtomValue(spotlightPlacementAtom);

  useOverlayLayer(isOpen && asPortal);

  // Bubble-phase escape handler (portal mode only — non-portal callers
  // expect the parent's focus trap to own escape).
  useEffect(() => {
    if (!isOpen || !asPortal) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, asPortal, onClose]);

  if (!isOpen) return null;

  const refocusInput = () => {
    // Try to refocus the first input inside the panel (palettes own their
    // own inputRef; the shell can't hold a typed ref to it).
    setTimeout(() => {
      const input =
        inputHostRef.current?.querySelector<HTMLInputElement>("input");
      input?.focus();
    }, 0);
  };

  const handlePanelClick = (event: React.MouseEvent) => {
    if (stopPropagation) event.stopPropagation();
    // Only refocus the default search input when clicking a non-interactive
    // dead zone. If the click landed on (or inside) a focusable element —
    // input, textarea, contenteditable, button, select, or a custom
    // interactive component — let the browser's native focus stand so that
    // embedded editors (e.g. the session creator composer) remain editable.
    const target = event.target as HTMLElement;
    const interactive = target.closest(
      "input, textarea, [contenteditable], button, select, a, [tabindex]"
    );
    if (!interactive) {
      refocusInput();
    }
  };

  const panel = (
    <div ref={inputHostRef}>
      <div
        className="overflow-hidden rounded-2xl border border-border-2 bg-bg-2 shadow-xl"
        style={{
          width: "100%",
          maxWidth: `${width}px`,
        }}
        onClick={handlePanelClick}
      >
        {children}
      </div>
    </div>
  );

  const shell =
    footer != null ? (
      <div className="flex w-full flex-col gap-2">
        {panel}
        <div className="flex w-full justify-center" onClick={refocusInput}>
          {footer}
        </div>
      </div>
    ) : (
      panel
    );

  if (!asPortal) {
    return (
      <>
        <style nonce={CODEMIRROR_STYLE_NONCE}>{SPOTLIGHT_STYLES}</style>
        {shell}
      </>
    );
  }

  return createPortal(
    <>
      <style nonce={CODEMIRROR_STYLE_NONCE}>{SPOTLIGHT_STYLES}</style>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: SPOTLIGHT_CONFIG.backdropZIndex,
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <div
        data-spotlight-container
        style={{
          position: "fixed",
          top:
            spotlightPlacement === "center"
              ? "50%"
              : SPOTLIGHT_CONFIG.topOffset,
          left: "50%",
          transform:
            spotlightPlacement === "center"
              ? "translate(-50%, -50%)"
              : "translateX(-50%)",
          zIndex: SPOTLIGHT_CONFIG.containerZIndex,
          width: `min(${width}px, calc(100vw - 160px))`,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {shell}
      </div>
    </>,
    document.body
  );
};

export default SpotlightShellChrome;
