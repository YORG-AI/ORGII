/**
 * SpotlightShell Component
 *
 * The ONE and ONLY visual chrome for the spotlight family. Owns:
 *  - Simple panel chrome
 *  - Portal + backdrop + viewport-centered positioning
 *  - Keyboard-hint footer below the panel
 *  - Focus refocus on background click
 *
 * Palettes are pure content: they render their search bar / list / slots
 * inside this shell via children, and may inject a right-side footer action
 * pill via ShellFooterAction.
 *
 * All palettes share the same width and portal behavior — no per-palette
 * styling. Callers cannot override these; variation lives only in palette
 * content.
 */
import React, { useCallback, useMemo, useRef } from "react";

import { SpotlightFooter, type SpotlightFooterActiveChip } from "../components";
import { SPOTLIGHT_CONFIG } from "../constants";
import { SpotlightShellChrome } from "./SpotlightShellChrome";
import {
  type FooterActionSlots,
  SpotlightFooterActionContext,
} from "./footerActionContext";

// ============ TYPES ============

interface SpotlightShellProps {
  isOpen: boolean;
  onClose: () => void;
  /** Whether to render into a body portal (vs inline in parent tree). */
  asPortal?: boolean;
  /** Whether clicking the panel stops click propagation (for modal-inside-modal). */
  stopPropagation?: boolean;
  /** Palette-declared footer state. */
  hasActiveAction?: boolean;
  /**
   * Chip shown in the footer when {@link hasActiveAction} is true. Defaults
   * to the historical "Backspace + Back" drill-in chip; two-column palettes
   * pass `"switchColumn"`, and pinned-section palettes pass `"switchSection"`.
   */
  activeActionChip?: SpotlightFooterActiveChip;
  /** Hide the keyboard-hints footer entirely (used by pure-input palettes). */
  hideFooter?: boolean;
  children: React.ReactNode;
}

// ============ COMPONENT ============

export const SpotlightShell: React.FC<SpotlightShellProps> = ({
  isOpen,
  onClose,
  asPortal = true,
  stopPropagation = false,
  hasActiveAction = false,
  activeActionChip,
  hideFooter = false,
  children,
}) => {
  // Tiny external stores so palette-level ShellFooterAction components can
  // subscribe to their host element without ref-in-render or effect dances.
  // One host per placement: a sibling pill, and a slot inside the
  // keyboard-hint pill itself.
  const pillHostRef = useRef<HTMLDivElement | null>(null);
  const pillListenersRef = useRef<Set<() => void>>(new Set());
  const inlineHostRef = useRef<HTMLDivElement | null>(null);
  const inlineListenersRef = useRef<Set<() => void>>(new Set());

  const setPillHostEl = useCallback((el: HTMLDivElement | null) => {
    if (pillHostRef.current === el) return;
    pillHostRef.current = el;
    pillListenersRef.current.forEach((cb) => cb());
  }, []);

  const setInlineHostEl = useCallback((el: HTMLDivElement | null) => {
    if (inlineHostRef.current === el) return;
    inlineHostRef.current = el;
    inlineListenersRef.current.forEach((cb) => cb());
  }, []);

  const slots = useMemo<FooterActionSlots>(
    () => ({
      pill: {
        subscribe: (cb) => {
          pillListenersRef.current.add(cb);
          return () => {
            pillListenersRef.current.delete(cb);
          };
        },
        getSnapshot: () => pillHostRef.current,
      },
      inline: {
        subscribe: (cb) => {
          inlineListenersRef.current.add(cb);
          return () => {
            inlineListenersRef.current.delete(cb);
          };
        },
        getSnapshot: () => inlineHostRef.current,
      },
    }),
    []
  );

  const footer = hideFooter ? null : (
    <div className="flex w-full flex-col items-center gap-2">
      <div className="flex items-center justify-center gap-3">
        <SpotlightFooter
          hasActiveAction={hasActiveAction}
          activeActionChip={activeActionChip}
          // `empty:hidden` keeps the hint row's gap from opening up when no
          // palette contributes an inline control.
          trailingSlot={
            <div
              ref={setInlineHostEl}
              className="flex items-center empty:hidden"
            />
          }
        />
        <div ref={setPillHostEl} className="flex items-center" />
      </div>
    </div>
  );

  return (
    <SpotlightFooterActionContext.Provider value={slots}>
      <SpotlightShellChrome
        isOpen={isOpen}
        onClose={onClose}
        asPortal={asPortal}
        stopPropagation={stopPropagation}
        width={SPOTLIGHT_CONFIG.width}
        footer={footer}
      >
        {children}
      </SpotlightShellChrome>
    </SpotlightFooterActionContext.Provider>
  );
};

export default SpotlightShell;
