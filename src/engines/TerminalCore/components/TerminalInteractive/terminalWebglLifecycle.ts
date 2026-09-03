/**
 * WebGL renderer lifecycle for one terminal pane.
 *
 * Three problems this owns, all of which used to strand a pane on the DOM
 * renderer for the rest of its life:
 *
 * - **Hidden panes held their context.** Terminal tabs are hidden with
 *   `display: none`, not unmounted, so every session ever opened kept a
 *   context. Chromium's per-process budget is small, so past the cap every new
 *   terminal silently rendered through the DOM.
 * - **A lost budget race was permanent.** `acquireWebglSlot` was attempted once
 *   at mount; a pane that lost never retried, even after the other panes closed.
 * - **Context loss was terminal.** The addon was disposed and never re-attached.
 *
 * Suspension is delayed rather than immediate: re-creating a context costs
 * single-digit milliseconds on macOS but far more through ANGLE on Windows, so
 * flipping between two tabs must not pay for it on every switch.
 */
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";

import { createLogger } from "@src/hooks/logger";

import { shouldLoadTerminalWebgl } from "./terminalRendererPolicy";
import {
  acquireWebglSlot,
  onWebglSlotReleased,
  releaseWebglSlot,
} from "./webglContextManager";

const log = createLogger("Terminal");

/**
 * How long a pane stays hidden before it gives its context back. Long enough
 * that alt-tabbing between two terminals never re-creates a context, short
 * enough that a workspace left on one tab frees the rest.
 */
const WEBGL_SUSPEND_DELAY_MS = 10_000;

export interface TerminalWebglController {
  /**
   * Attach the renderer now, or start waiting for a context slot. Called once
   * the terminal is in the DOM and sized.
   */
  attach: () => void;
  /** Track pane visibility; drives attach on reveal and delayed detach on hide. */
  setForeground: (foreground: boolean) => void;
  /** Detach, cancel pending work, and hand back the context slot. */
  dispose: () => void;
}

export function createTerminalWebglController(
  terminal: Terminal,
  webglAddonRef: MutableRefObject<WebglAddon | null>
): TerminalWebglController {
  let disposed = false;
  let foreground = true;
  let holdsSlot = false;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeFromSlots: (() => void) | null = null;
  /**
   * Set when the GPU dropped our context. Cleared on the next reveal rather
   * than retried immediately: context loss usually means the driver is busy
   * resetting, and a retry loop against that just churns.
   */
  let disabledAfterContextLoss = false;

  const cancelSuspendTimer = (): void => {
    if (suspendTimer === null) return;
    clearTimeout(suspendTimer);
    suspendTimer = null;
  };

  const stopWaitingForSlot = (): void => {
    unsubscribeFromSlots?.();
    unsubscribeFromSlots = null;
  };

  const detach = (): void => {
    const addon = webglAddonRef.current;
    webglAddonRef.current = null;
    if (addon) {
      try {
        addon.dispose();
      } catch (error) {
        // A disposed terminal takes its renderer down with it; the slot
        // accounting below still has to run.
        log.warn("[Terminal] WebGL addon disposal failed:", error);
      }
    }
    if (holdsSlot) {
      holdsSlot = false;
      releaseWebglSlot();
    }
  };

  const attach = (): void => {
    if (disposed || !foreground || disabledAfterContextLoss) return;
    if (webglAddonRef.current) return;
    if (!shouldLoadTerminalWebgl()) return;
    // A terminal detached from the DOM has no drawing surface to bind.
    if (!terminal.element) return;

    if (!acquireWebglSlot()) {
      if (!unsubscribeFromSlots) {
        log.info("[Terminal] WebGL context budget full, waiting for a slot");
        unsubscribeFromSlots = onWebglSlotReleased(attach);
      }
      return;
    }
    stopWaitingForSlot();
    holdsSlot = true;

    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      const addon = webglAddon;
      addon.onContextLoss(() => {
        log.warn("[Terminal] WebGL context lost, falling back to DOM renderer");
        disabledAfterContextLoss = true;
        detach();
      });
      terminal.loadAddon(addon);
      webglAddonRef.current = addon;
    } catch (error) {
      log.warn(
        "[Terminal] WebGL addon failed to load, using DOM renderer:",
        error
      );
      // If `loadAddon`/`activate` threw after the GL context was created, the
      // addon still owns that context (10-30 MB GPU); dispose it before
      // handing the budget slot back so the live-context count stays honest.
      try {
        webglAddon?.dispose();
      } catch {
        // Best effort — the addon may not have activated at all.
      }
      webglAddonRef.current = null;
      holdsSlot = false;
      releaseWebglSlot();
    }
  };

  return {
    attach,

    setForeground(next: boolean): void {
      if (disposed || foreground === next) return;
      foreground = next;

      if (next) {
        cancelSuspendTimer();
        // A reveal is the natural moment to retry: the GPU has had time to
        // recover, and the user is looking at this pane again.
        disabledAfterContextLoss = false;
        attach();
        return;
      }

      stopWaitingForSlot();
      cancelSuspendTimer();
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        if (disposed || foreground) return;
        detach();
      }, WEBGL_SUSPEND_DELAY_MS);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelSuspendTimer();
      stopWaitingForSlot();
      detach();
    },
  };
}
