/**
 * AppBootstrap
 *
 * Top-level shell component mounted immediately after AppProviders.
 * Owns all app-wide hook calls that must run once per window lifetime:
 * - Settings sync
 * - Shell appearance (scale, font, fullscreen, animations)
 * - Deferred initialization gate (SessionCore, tool registry, cache preload)
 * - First-paint splash removal
 * - Global flow tracker for agent context
 */
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, Suspense, lazy, useEffect } from "react";
import { RouterProvider } from "react-router-dom";

import { DeferredGitStatusProvider } from "@src/contexts/git";
import { useDiagnosticsBootstrap } from "@src/diagnostics";
import { useGlobalFlowTracker } from "@src/hooks/flowAwareness";
import { useModelAliasRegistry } from "@src/hooks/models";
import {
  useCrossWindowSettingsSync,
  useDevModeGuard,
  useEditorAppearanceStyles,
  usePointerCursorPreference,
  useSleepInhibitor,
} from "@src/hooks/settings";
import { useAppSkin } from "@src/hooks/theme/useAppSkin";
import { router } from "@src/router";
import QuitConfirmationModal from "@src/scaffold/ModalSystem/variants/Quit";
import { useAgentLiveStatusSync } from "@src/store/session/agentLiveStatusAtom";
import { hydrateCreatorDefaultModelAtom } from "@src/store/session/creatorDefaultModelAtom";
import { useDataSourceAutoScan } from "@src/store/session/useDataSourceAutoScan";
import { useSettingsSync } from "@src/store/settings";
import { settingsLoadedAtom } from "@src/store/settings/settingsAtom";

import { AppDeferredServices } from "./AppDeferredServices";
import { AppGlobalRecovery } from "./AppGlobalRecovery";
import ErrorBoundary from "./components/ErrorBoundary";
import GlobalShortcuts from "./components/GlobalShortcuts";
import { RepoLoader } from "./services/RepoLoader";
import { useAppDeferredInitialization } from "./useAppDeferredInitialization";
import { useAppShellEffects } from "./useAppShellEffects";
import { useFirstPaintSignal } from "./useFirstPaintSignal";
import { usePostPaintGitProbe } from "./usePostPaintGitProbe";

// The E2E bridge (`window.__e2e`) is dev-only and loads as its own chunk: its
// helpers pull ~40 modules (session sync adapters, cloud client, agent-org
// store) that must not sit in the boot graph. In production the ternary folds
// to `null`, so the `import()` and its chunk are eliminated with it. E2E specs
// already poll for `window.__e2e` in `waitForApp` before invoking helpers.
const E2EBootstrap =
  process.env.NODE_ENV !== "production"
    ? lazy(() =>
        import("./E2EBootstrap").then((module) => ({
          default: module.E2EBootstrap,
        }))
      )
    : null;

export const AppBootstrap: FC = () => {
  const deferredComponentsReady = useAppDeferredInitialization();
  const hydrateLastModel = useSetAtom(hydrateCreatorDefaultModelAtom);
  const settingsLoaded = useAtomValue(settingsLoadedAtom);

  useSettingsSync();

  // Run after settings are loaded from disk so the atom read inside
  // hydrateCreatorDefaultModelAtom hits the in-memory cache instead of
  // issuing a second redundant settings.read() IPC call.
  useEffect(() => {
    if (!settingsLoaded) return;
    hydrateLastModel();
  }, [settingsLoaded, hydrateLastModel]);
  useCrossWindowSettingsSync();
  useEditorAppearanceStyles();
  useAppSkin();
  usePointerCursorPreference();
  useDevModeGuard();
  useSleepInhibitor();
  useAppShellEffects();
  useFirstPaintSignal();
  usePostPaintGitProbe();
  useGlobalFlowTracker(); // Track user activities for agent context
  useModelAliasRegistry();
  useDiagnosticsBootstrap();
  useDataSourceAutoScan(); // Keep external-history sources fresh on their cadence
  useAgentLiveStatusSync(); // Hook-driven live agent status → sidebar dots

  return (
    <DeferredGitStatusProvider>
      <GlobalShortcuts />
      <AppGlobalRecovery />
      {E2EBootstrap && (
        <Suspense fallback={null}>
          <E2EBootstrap />
        </Suspense>
      )}
      <ErrorBoundary>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
        <RepoLoader />
        <QuitConfirmationModal />
        <AppDeferredServices ready={deferredComponentsReady} />
      </ErrorBoundary>
    </DeferredGitStatusProvider>
  );
};
