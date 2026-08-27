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
 * - AppUpdater                — Tauri auto-update poller
 * - APICallPanelProvider      — DevTools API call inspector
 * - SecretCaptureModal        — out-of-band secret capture overlay
 */
import React from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("TerminalPersistence");

const GlobalDragDrop = React.lazy(
  () =>
    import(
      /* webpackChunkName: "deferred-services" */ "./services/GlobalDragDrop"
    )
);

const AppUpdater = React.lazy(() =>
  import(
    /* webpackChunkName: "deferred-services" */ "@src/scaffold/AppUpdater"
  ).then((module) => ({ default: module.AppUpdater }))
);

const APICallPanelProvider = React.lazy(() =>
  import(
    /* webpackChunkName: "deferred-services" */ "@src/modules/shared/DevTools/APICallPanel"
  ).then((module) => ({ default: module.APICallPanelProvider }))
);

const SecretCaptureModal = React.lazy(
  () =>
    import(
      /* webpackChunkName: "deferred-services" */ "@src/scaffold/SecretCaptureModal"
    )
);

const DeferredWindowFocusTracking = React.lazy(() =>
  import(
    /* webpackChunkName: "deferred-services" */ "@src/hooks/platform/useWindowFocusTracking"
  ).then((module) => ({
    default: function DeferredWindowFocusTracking() {
      module.useWindowFocusTracking();
      return null;
    },
  }))
);

const DeferredUserPresenceSync = React.lazy(() =>
  import(
    /* webpackChunkName: "deferred-services" */ "@src/hooks/platform/useUserPresenceSync"
  ).then((module) => ({
    default: function DeferredUserPresenceSync() {
      module.useUserPresenceSync();
      return null;
    },
  }))
);

const DeferredUserProfileSync = React.lazy(() =>
  import(
    /* webpackChunkName: "deferred-services" */ "@src/hooks/platform/useUserProfileSync"
  ).then((module) => ({
    default: function DeferredUserProfileSync() {
      module.useUserProfileSync();
      return null;
    },
  }))
);

const DeferredGitAutoFetch = React.lazy(() =>
  import(
    /* webpackChunkName: "deferred-services" */ "@src/hooks/git/useGitAutoFetch"
  ).then((module) => ({
    default: function DeferredGitAutoFetch() {
      module.useGitAutoFetch();
      return null;
    },
  }))
);

const DeferredProcessReconciliation = React.lazy(() =>
  import(
    /* webpackChunkName: "deferred-services" */ "@src/hooks/terminal/useProcessReconciliation"
  ).then((module) => ({
    default: function DeferredProcessReconciliation() {
      module.useProcessReconciliation();
      return null;
    },
  }))
);

const DeferredTerminalPersistence = React.lazy(() =>
  Promise.all([
    import(
      /* webpackChunkName: "deferred-services" */ "@src/engines/TerminalCore/components/TerminalInteractive/bufferCache"
    ),
    import(
      /* webpackChunkName: "deferred-services" */ "@src/services/terminal/bufferPersistence"
    ),
  ]).then(([bufferCache, terminalPersistence]) => ({
    default: function DeferredTerminalPersistence() {
      React.useEffect(() => {
        // Hydrate the in-memory buffer cache from disk on startup so
        // terminals can restore their scrollback across app restarts.
        terminalPersistence
          .loadPersistedBuffers()
          .then((buffers) => bufferCache.hydrateFromPersistence(buffers))
          .catch((error) => {
            log.warn("[TerminalPersistence] Failed to load buffers:", error);
          });

        const handleBeforeUnload = () => {
          void terminalPersistence.flushPendingWrites();
        };
        const handleVisibilityChange = () => {
          if (document.visibilityState === "hidden") {
            void terminalPersistence.flushPendingWrites();
          }
        };
        window.addEventListener("beforeunload", handleBeforeUnload);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
          window.removeEventListener("beforeunload", handleBeforeUnload);
          document.removeEventListener(
            "visibilitychange",
            handleVisibilityChange
          );
          void terminalPersistence.flushPendingWrites();
        };
      }, []);

      return null;
    },
  }))
);

const DeferredServiceBoundary: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <React.Suspense fallback={null}>{children}</React.Suspense>;

export const AppDeferredServices: React.FC<{ ready: boolean }> = ({
  ready,
}) => {
  if (!ready) return null;

  return (
    <>
      <DeferredServiceBoundary>
        <GlobalDragDrop />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <DeferredWindowFocusTracking />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <DeferredUserPresenceSync />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <DeferredUserProfileSync />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <DeferredGitAutoFetch />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <DeferredProcessReconciliation />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <DeferredTerminalPersistence />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <AppUpdater />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <APICallPanelProvider />
      </DeferredServiceBoundary>
      <DeferredServiceBoundary>
        <SecretCaptureModal />
      </DeferredServiceBoundary>
    </>
  );
};
