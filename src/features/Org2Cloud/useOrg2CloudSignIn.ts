/** Shared system-browser entry point for every ORG2 Cloud sign-in surface. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback } from "react";

import { createLogger } from "@src/hooks/logger";

import { buildOrg2CloudLoginUrl } from "./config";

const log = createLogger("Org2CloudSignIn");

export type OpenExternalUrl = (url: string) => Promise<void>;

/** Exported with an injectable opener so the complete URL contract is tested. */
export async function openOrg2CloudSignIn(
  openExternalUrl: OpenExternalUrl = openUrl
): Promise<void> {
  await openExternalUrl(buildOrg2CloudLoginUrl());
}

/**
 * Stable click handler used by Settings, Add ORG, invite, and share flows.
 * The callback URL is resolved at click time so runtime instance and custom
 * endpoint switches cannot leave a stale login link behind.
 */
export function useOrg2CloudSignIn(): () => void {
  return useCallback(() => {
    void openOrg2CloudSignIn().catch((error: unknown) => {
      log.error("failed to open ORG2 Cloud login in system browser", error);
    });
  }, []);
}
