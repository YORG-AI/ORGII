/**
 * Root redirect for the local-first desktop shell.
 *
 * Authentication is deliberately absent from this decision. A signed-out
 * user can enter Workstation and signs in only when using a hosted/cloud
 * feature.
 */
import { useAtomValue } from "jotai";
import React from "react";
import { Navigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  rawSettingsAtom,
  settingAtom,
  settingsLoadedAtom,
} from "@src/store/settings/settingsAtom";

import { shouldAutoOpenSetup } from "../entryFlow";

export const AppEntryRedirect: React.FC = () => {
  const settingsLoaded = useAtomValue(settingsLoadedAtom);
  const rawSettings = useAtomValue(rawSettingsAtom);
  const setupOutcome = useAtomValue(
    settingAtom("general.setupWalkthroughOutcome")
  );

  if (!settingsLoaded) {
    return <Placeholder variant="loading" />;
  }

  if (
    shouldAutoOpenSetup({
      settingsLoaded,
      rawSettings,
      outcome: setupOutcome,
    })
  ) {
    return <Navigate to={ROUTES.auth.setup.path} replace />;
  }

  return <Navigate to={ROUTES.workStation.base.path} replace />;
};
