/**
 * AppShellGate - local-first application entry gate.
 *
 * Product identity is optional for the desktop shell. This gate owns only
 * settings hydration and the first-use setup transition; hosted/cloud
 * features request their own identity when the user invokes them.
 */
import { useAtomValue } from "jotai";
import React from "react";
import { Navigate, useLocation } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  rawSettingsAtom,
  settingAtom,
  settingsLoadedAtom,
} from "@src/store/settings/settingsAtom";

import { buildSetupEntryPath, shouldAutoOpenSetup } from "../entryFlow";

function isPublicEntryPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === ROUTES.auth.login.path ||
    pathname === ROUTES.app.market.callback.path
  );
}

interface AppShellGateProps {
  children: React.ReactNode;
}

export const AppShellGate: React.FC<AppShellGateProps> = ({ children }) => {
  const location = useLocation();
  const settingsLoaded = useAtomValue(settingsLoadedAtom);
  const rawSettings = useAtomValue(rawSettingsAtom);
  const setupOutcome = useAtomValue(
    settingAtom("general.setupWalkthroughOutcome")
  );

  // Root, sign-in, and callback routes own their own transitions. In
  // particular, an OAuth callback must never wait for settings hydration.
  if (isPublicEntryPath(location.pathname)) {
    return <>{children}</>;
  }

  if (!settingsLoaded) {
    return <Placeholder variant="loading" />;
  }

  if (
    location.pathname !== ROUTES.auth.setup.path &&
    shouldAutoOpenSetup({
      settingsLoaded,
      rawSettings,
      outcome: setupOutcome,
    })
  ) {
    return <Navigate to={buildSetupEntryPath(location)} replace />;
  }

  return <>{children}</>;
};
