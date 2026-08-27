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
import { type FC, useEffect } from "react";
import { RouterProvider } from "react-router-dom";

import {
  DeferredGitStatusProvider,
  MultiRepoGitStatusProvider,
} from "@src/contexts/git";
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
import { router } from "@src/router";
import GlobalPreferencesPanel from "@src/scaffold/GlobalPreferencesPanel";
import QuitConfirmationModal from "@src/scaffold/ModalSystem/variants/Quit";
import { useAgentLiveStatusSync } from "@src/store/session/agentLiveStatusAtom";
import { hydrateCreatorDefaultModelAtom } from "@src/store/session/creatorDefaultModelAtom";
import { useDataSourceAutoScan } from "@src/store/session/useDataSourceAutoScan";
import { useSettingsSync } from "@src/store/settings";
import { settingsLoadedAtom } from "@src/store/settings/settingsAtom";

import { AppDeferredServices } from "./AppDeferredServices";
import { AppGlobalRecovery } from "./AppGlobalRecovery";
import { E2EBootstrap } from "./E2EBootstrap";
import ErrorBoundary from "./components/ErrorBoundary";
import GlobalShortcuts from "./components/GlobalShortcuts";
import { RepoLoader } from "./services/RepoLoader";
import { useAppDeferredInitialization } from "./useAppDeferredInitialization";
import { useAppShellEffects } from "./useAppShellEffects";
import { useFirstPaintSignal } from "./useFirstPaintSignal";
import { usePostPaintGitProbe } from "./usePostPaintGitProbe";

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
      <MultiRepoGitStatusProvider>
        <GlobalShortcuts />
        <AppGlobalRecovery />
        {process.env.NODE_ENV !== "production" && <E2EBootstrap />}
        <ErrorBoundary>
          <RouterProvider
            router={router}
            future={{ v7_startTransition: true }}
          />
          <RepoLoader />
          <GlobalPreferencesPanel />
          <QuitConfirmationModal />
          <AppDeferredServices ready={deferredComponentsReady} />
        </ErrorBoundary>
      </MultiRepoGitStatusProvider>
    </DeferredGitStatusProvider>
  );
};
