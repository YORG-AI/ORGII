/** Shared system-browser entry point for every ORG2 Cloud sign-in surface. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef } from "react";

import { identityClient } from "@src/features/Identity/identityClient";
import { isIdentityOAuthEnabled } from "@src/features/Identity/identityConfig";
import { replaceIdentitySnapshot } from "@src/features/Identity/identitySnapshotAtom";
import type { BeginIdentitySignInOutcome } from "@src/features/Identity/identityTypes";
import {
  type SignInIntent,
  bindBrokerSignInIntent,
  bindLegacySignInIntent,
  clearSignInIntent,
  stageSignInIntent,
} from "@src/features/Identity/signInIntent";
import { createLogger } from "@src/hooks/logger";

import { buildOrg2CloudLoginUrl, getCloudEndpoint } from "./config";
import {
  beginOrg2CloudAuthLoopback,
  cancelPendingOrg2CloudAuthLoopback,
} from "./org2CloudAuthLoopback";

const log = createLogger("Org2CloudSignIn");

export interface Org2CloudSignInDependencies {
  useBrokerOAuth?: boolean;
  beginBrokerSignIn?: () => Promise<BeginIdentitySignInOutcome | void>;
  beginAuthLoopback?: () => Promise<string>;
  cancelAuthLoopback?: () => Promise<void>;
  openExternalUrl?: (url: string) => Promise<void>;
  signInIntent?: SignInIntent;
}

async function beginBrokerOrg2CloudSignIn(): Promise<BeginIdentitySignInOutcome> {
  const endpoint = getCloudEndpoint();
  const outcome = await identityClient.beginOrg2CloudSignIn({
    webOrigin: endpoint.webOrigin,
    supabaseUrl: endpoint.supabaseUrl,
    publicClientKey: endpoint.anonKey,
  });
  replaceIdentitySnapshot(outcome.snapshot);
  return outcome;
}

/** Start Broker OAuth, or the explicit old-client compatibility path. */
export async function openOrg2CloudSignIn(
  dependencies: Org2CloudSignInDependencies = {}
): Promise<void> {
  const ticket = stageSignInIntent(
    dependencies.signInIntent ?? { kind: "open_cloud_settings" }
  );
  if (dependencies.useBrokerOAuth ?? isIdentityOAuthEnabled) {
    const beginBrokerSignIn =
      dependencies.beginBrokerSignIn ?? beginBrokerOrg2CloudSignIn;
    try {
      const outcome = await beginBrokerSignIn();
      const flow = outcome?.snapshot.flows.find(
        (candidate) => candidate.flowId === outcome.flowId
      );
      if (!outcome || !flow) {
        clearSignInIntent(ticket);
        return;
      }
      bindBrokerSignInIntent(ticket, outcome.flowId, flow.generation);
    } catch (error) {
      clearSignInIntent(ticket);
      throw error;
    }
    return;
  }

  const beginAuthLoopback =
    dependencies.beginAuthLoopback ?? beginOrg2CloudAuthLoopback;
  const cancelAuthLoopback =
    dependencies.cancelAuthLoopback ?? cancelPendingOrg2CloudAuthLoopback;
  const openExternalUrl = dependencies.openExternalUrl ?? openUrl;

  try {
    const callbackUrl = await beginAuthLoopback();
    bindLegacySignInIntent(ticket);
    await openExternalUrl(buildOrg2CloudLoginUrl(callbackUrl));
  } catch (error) {
    clearSignInIntent(ticket);
    await cancelAuthLoopback();
    throw error;
  }
}

/** Stable click handler shared by Settings, Add ORG, invite, and share flows. */
export function useOrg2CloudSignIn(
  intent: SignInIntent = { kind: "open_cloud_settings" }
): () => Promise<boolean> {
  const intentRef = useRef(intent);
  useEffect(() => {
    intentRef.current = intent;
  }, [intent]);
  return useCallback(async () => {
    try {
      await openOrg2CloudSignIn({ signInIntent: intentRef.current });
      return true;
    } catch (error: unknown) {
      log.error("failed to open ORG2 Cloud login in system browser", error);
      return false;
    }
  }, []);
}
