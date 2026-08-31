/**
 * SpotlightShellChrome
 *
 * Low-level chrome for SpotlightShell: simple panel + optional portal +
 * backdrop + content-area-centered positioning + footer slot beneath the
 * panel. Horizontal centering excludes the docked layout sidebar and the
 * focused-chat workstation trail, so the spotlight sits over the visible
 * content rather than the full viewport.
 *
 * This is a direct merge of the previous SelectorContainer + SpotlightPortal
 * layer. Only consumed by SpotlightShell; palettes never see this component.
 */
import { useAtomValue } from "jotai";
import React, { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";

import { getSidebarId } from "@src/config/sidebarRegistry";
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";
import {
  sidebarCollapsedAtom,
  sidebarWidthAtom,
} from "@src/store/ui/sidebarAtom";
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
  const location = useLocation();
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);

  // Routes without a docked layout sidebar (and collapsed sidebars) reserve
  // no horizontal space, so they contribute no centering inset.
  const sidebarInset =
    getSidebarId(location.pathname) !== null && !sidebarCollapsed
      ? sidebarWidth
      : 0;

  // The focused-chat workstation trail (live rail or launchpad placeholder)
  // reserves width at the right edge of the content area. Its visibility
  // mixes chat-focus state, tab type, a container query, and rail-local
  // collapse state that no atom exposes, so the rendered track is measured
  // instead of mirrored. Measured once per open — the backdrop prevents the
  // trail from changing while the spotlight is up.
  const trailInset = useMemo(() => {
    if (!isOpen || !asPortal) return 0;
    const track = document.querySelector<HTMLElement>(
      "[data-workstation-trail-track]"
    );
    return track ? track.getBoundingClientRect().width : 0;
  }, [isOpen, asPortal]);

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
          left: `calc(50% + ${(sidebarInset - trailInset) / 2}px)`,
          transform:
            spotlightPlacement === "center"
              ? "translate(-50%, -50%)"
              : "translateX(-50%)",
          zIndex: SPOTLIGHT_CONFIG.containerZIndex,
          width: `min(${width}px, calc(100vw - ${sidebarInset + trailInset}px - 160px))`,
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
