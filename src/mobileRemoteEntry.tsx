import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { MobileRemoteRoot } from "@src/modules/MobileRemote/MobileRemoteRoot";
import {
  mobileI18n,
  mobileI18nReady,
} from "@src/modules/MobileRemote/mobileI18n";
import { getBrowserMobileRemotePlatform } from "@src/modules/MobileRemote/platform/browser";

import "./index.scss";
import "./modules/MobileRemote/mobileViewport.scss";

// Pairing payloads contain credentials. Capture them opaquely and scrub the
// address bar synchronously, before i18n or any other async startup work.
const platform = getBrowserMobileRemotePlatform();
platform.auth.captureInitialPairingIntent();

function showStartupError(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;

  const panel = document.createElement("main");
  panel.setAttribute("role", "alert");
  panel.style.cssText =
    "min-height:100dvh;display:grid;place-items:center;padding:24px;background:#f4f4f4;color:#202124;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

  const message = document.createElement("p");
  message.textContent =
    error instanceof Error
      ? `ORG2 Mobile Remote could not start: ${error.message}`
      : "ORG2 Mobile Remote could not start";
  panel.appendChild(message);
  root.replaceChildren(panel);
}

async function mountMobileRemote(): Promise<void> {
  await mobileI18nReady;

  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Missing application root");
  }

  createRoot(root).render(
    <I18nextProvider i18n={mobileI18n}>
      <MobileRemoteRoot platform={platform} />
    </I18nextProvider>
  );
}

void mountMobileRemote().catch(showStartupError);
