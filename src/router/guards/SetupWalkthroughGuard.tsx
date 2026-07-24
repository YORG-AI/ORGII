import { useAtomValue } from "jotai";
import React from "react";
import { Navigate, useLocation } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import {
  settingsAtom,
  settingsLoadedAtom,
} from "@src/store/settings/settingsAtom";

import { resolveSetupWalkthroughNavigation } from "./setupWalkthroughNavigation";

interface SetupWalkthroughGuardProps {
  children: React.ReactNode;
}

/**
 * Authoritative first-use routing gate. Authentication runs outside this guard;
 * this layer only decides whether persisted onboarding is still open.
 */
export const SetupWalkthroughGuard: React.FC<SetupWalkthroughGuardProps> = ({
  children,
}) => {
  const location = useLocation();
  const settingsLoaded = useAtomValue(settingsLoadedAtom);
  const outcome = useAtomValue(settingsAtom)["general.setupWalkthroughOutcome"];
  const navigation = resolveSetupWalkthroughNavigation({
    loaded: settingsLoaded,
    outcome,
    pathname: location.pathname,
  });

  if (navigation === "wait") return null;
  if (navigation === "redirect-to-setup") {
    return <Navigate to={ROUTES.auth.setup.path} replace />;
  }
  if (navigation === "redirect-to-workstation") {
    return <Navigate to={ROUTES.workStation.base.path} replace />;
  }
  return <>{children}</>;
};
