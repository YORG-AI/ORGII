/** Shared system-browser entry point for every ORG2 Cloud sign-in surface. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback } from "react";

import { createLogger } from "@src/hooks/logger";

import { buildOrg2CloudLoginUrl } from "./config";
import {
  beginOrg2CloudAuthLoopback,
  cancelPendingOrg2CloudAuthLoopback,
} from "./org2CloudAuthLoopback";

const log = createLogger("Org2CloudSignIn");

export interface Org2CloudSignInDependencies {
  beginAuthLoopback?: () => Promise<string>;
  cancelAuthLoopback?: () => Promise<void>;
  openExternalUrl?: (url: string) => Promise<void>;
}

/**
 * Start the app-owned loopback receiver before opening the browser login.
 * This works from a bare dev executable as well as an installed app and keeps
 * every UI entry point on the same callback path.
 */
export async function openOrg2CloudSignIn(
  dependencies: Org2CloudSignInDependencies = {}
): Promise<void> {
  const beginAuthLoopback =
    dependencies.beginAuthLoopback ?? beginOrg2CloudAuthLoopback;
  const cancelAuthLoopback =
    dependencies.cancelAuthLoopback ?? cancelPendingOrg2CloudAuthLoopback;
  const openExternalUrl = dependencies.openExternalUrl ?? openUrl;

  try {
    const callbackUrl = await beginAuthLoopback();
    await openExternalUrl(buildOrg2CloudLoginUrl(callbackUrl));
  } catch (error) {
    await cancelAuthLoopback();
    throw error;
  }
}

/** Stable click handler shared by Settings, Add ORG, invite, and share flows. */
export function useOrg2CloudSignIn(): () => void {
  return useCallback(() => {
    void openOrg2CloudSignIn().catch((error: unknown) => {
      log.error("failed to open ORG2 Cloud login in system browser", error);
    });
  }, []);
}
