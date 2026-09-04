import {
  MOBILE_AUTH_CALLBACK_PATH,
  beginMobileOAuthAttempt,
  captureOpaquePairingIntent,
  clearMobileAuthIntents,
  consumeMobileOAuthAttempt,
  consumeOpaquePairingIntent,
  isMobileAuthCallback,
} from "../../auth/mobileAuthIntent";
import {
  clearMobileAuthSession,
  readMobileAuthSession,
  writeMobileAuthSession,
} from "../../auth/mobileAuthStorage";
import {
  listScopedMobilePairedDesktops,
  loadScopedMobileConnectionConfig,
  saveScopedMobileConnectionConfig,
  selectScopedMobilePairedDesktop,
} from "../../connection/mobileConnectionStorage";
import { resolveMobileDeviceLabel } from "../../connection/resolveMobileDeviceLabel";
import type { MobileRemotePlatform } from "../types";
import { createBrowserMobileAuthClient } from "./browserMobileAuthClient";

const MOBILE_AUTH_ROOT_PATH = "/orgii/mobile";

export function createBrowserMobileRemotePlatform(): MobileRemotePlatform {
  const runtime: MobileRemotePlatform["runtime"] = {
    now: () => Date.now(),
    random: () => Math.random(),
    randomUUID: () => crypto.randomUUID(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
    isHidden: () => document.hidden,
    subscribeVisibility(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    portalContainer: () => document.body,
  };

  return {
    kind: "browser",
    clientInfo: {
      name: "orgii-mobile-pwa",
      version: "0.1.0",
      defaultDeviceLabel: resolveMobileDeviceLabel(),
    },
    runtime,
    auth: {
      createClient: () =>
        createBrowserMobileAuthClient({
          oauthStorage: sessionStorage,
          fetcher: window.fetch.bind(window),
        }),
      captureInitialPairingIntent: () =>
        captureOpaquePairingIntent(
          window.location,
          window.history,
          sessionStorage,
          runtime.now()
        ),
      isCallback: () => isMobileAuthCallback(window.location),
      currentUrl: () => window.location.href,
      callbackUrl: () =>
        new URL(MOBILE_AUTH_CALLBACK_PATH, window.location.origin).toString(),
      scrubCallback: () =>
        window.history.replaceState(
          window.history.state,
          "",
          MOBILE_AUTH_ROOT_PATH
        ),
      navigate: (url) => window.location.assign(url),
      async beginOAuthAttempt(attemptId) {
        beginMobileOAuthAttempt(attemptId, sessionStorage, runtime.now());
      },
      async consumeOAuthAttempt() {
        return consumeMobileOAuthAttempt(sessionStorage, runtime.now());
      },
      async consumePairingIntent() {
        return consumeOpaquePairingIntent(sessionStorage, runtime.now());
      },
      async clearIntents() {
        clearMobileAuthIntents(sessionStorage);
      },
      async readSession() {
        return readMobileAuthSession(localStorage);
      },
      async writeSession(session) {
        writeMobileAuthSession(session, localStorage);
      },
      async clearSession() {
        clearMobileAuthSession(localStorage);
      },
      subscribeIntent() {
        // Browser redirects remount the page; warm native deep links use the
        // Tauri implementation of this port.
        return () => undefined;
      },
    },
    connection: {
      createSocket: (url) => new WebSocket(url),
      async load(userId) {
        return loadScopedMobileConnectionConfig(userId, localStorage);
      },
      async listPairedDesktops(userId) {
        return listScopedMobilePairedDesktops(userId, localStorage);
      },
      async selectPairedDesktop(userId, desktopId) {
        return selectScopedMobilePairedDesktop(userId, desktopId, localStorage);
      },
      async save(userId, config) {
        saveScopedMobileConnectionConfig(
          userId,
          config,
          localStorage,
          runtime.now()
        );
      },
    },
  };
}

let browserPlatform: MobileRemotePlatform | null = null;

export function getBrowserMobileRemotePlatform(): MobileRemotePlatform {
  browserPlatform ??= createBrowserMobileRemotePlatform();
  return browserPlatform;
}
