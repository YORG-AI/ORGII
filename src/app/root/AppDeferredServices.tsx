/**
 * AppDeferredServices
 *
 * Headless service components that are intentionally delayed until after the
 * first meaningful paint (gated by the `ready` prop from useAppDeferredInitialization).
 *
 * Split into wrapper components so each hook has an isolated React subtree and
 * an independent render cycle — avoids a single fat component with N hooks.
 *
 * Mounted only when ready:
 * - GlobalDragDrop            — cross-window file drag handling
 * - DeferredWindowFocusTracking
 * - DeferredGitAutoFetch      — background git remote polling
 * - DeferredProcessReconciliation — reseed shell/PTY state from Rust
 * - AutoIndexingProvider      — repo indexing scheduler
 * - AppUpdater                — Tauri auto-update poller
 * - APICallPanelProvider      — DevTools API call inspector
 * - SecretCaptureModal        — out-of-band secret capture overlay
 */
import React, { useEffect } from "react";

import GlobalDragDrop from "@src/components/GlobalDragDrop";
import { AutoIndexingProvider } from "@src/components/System";
import { hydrateFromPersistence } from "@src/components/TerminalInteractive/bufferCache";
import { useGitAutoFetch } from "@src/hooks/git";
import { createLogger } from "@src/hooks/logger";
import {
  useUserPresenceSync,
  useUserProfileSync,
  useWindowFocusTracking,
} from "@src/hooks/platform";
import { useProcessReconciliation } from "@src/hooks/terminal";
import { APICallPanelProvider } from "@src/modules/shared/DevTools/APICallPanel";
import { AppUpdater } from "@src/scaffold/AppUpdater";
import SecretCaptureModal from "@src/scaffold/SecretCaptureModal";
import {
  flushPendingWrites,
  loadPersistedBuffers,
  startAutoSave,
  stopAutoSave,
} from "@src/services/terminal";

const log = createLogger("TerminalPersistence");

const DeferredWindowFocusTracking: React.FC = () => {
  useWindowFocusTracking();
  return null;
};

const DeferredUserPresenceSync: React.FC = () => {
  useUserPresenceSync();
  return null;
};

const DeferredUserProfileSync: React.FC = () => {
  useUserProfileSync();
  return null;
};

const DeferredGitAutoFetch: React.FC = () => {
  useGitAutoFetch();
  return null;
};

const DeferredProcessReconciliation: React.FC = () => {
  useProcessReconciliation();
  return null;
};

const DeferredTerminalPersistence: React.FC = () => {
  useEffect(() => {
    // Hydrate the in-memory buffer cache from disk on startup so terminals
    // can restore their scrollback across app restarts.
    loadPersistedBuffers()
      .then((buffers) => hydrateFromPersistence(buffers))
      .catch((error) => {
        log.warn("[TerminalPersistence] Failed to load buffers:", error);
      });

    startAutoSave();

    const handleBeforeUnload = () => {
      void flushPendingWrites();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      stopAutoSave();
    };
  }, []);

  return null;
};

export const AppDeferredServices: React.FC<{ ready: boolean }> = ({
  ready,
}) => {
  if (!ready) return null;

  return (
    <>
      <GlobalDragDrop />
      <DeferredWindowFocusTracking />
      <DeferredUserPresenceSync />
      <DeferredUserProfileSync />
      <DeferredGitAutoFetch />
      <DeferredProcessReconciliation />
      <DeferredTerminalPersistence />
      <AutoIndexingProvider />
      <AppUpdater />
      <APICallPanelProvider />
      <SecretCaptureModal />
    </>
  );
};
