import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { MobileRemoteRoot } from "@src/modules/MobileRemote/MobileRemoteRoot";
import {
  mobileI18n,
  mobileI18nReady,
} from "@src/modules/MobileRemote/mobileI18n";
import { createTauriMobileRemotePlatform } from "@src/modules/MobileRemote/platform/tauri";

import "./index.scss";
import "./modules/MobileRemote/mobileViewport.scss";

function showStartupError(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;

  const panel = document.createElement("main");
  panel.setAttribute("role", "alert");
  panel.style.cssText =
    "min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--color-bg-2,#f4f4f4);color:var(--color-text-1,#202124);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

  const message = document.createElement("p");
  message.textContent =
    error instanceof Error
      ? `ORG2 Remote could not start: ${error.message}`
      : "ORG2 Remote could not start";
  panel.appendChild(message);
  root.replaceChildren(panel);
}

async function mountMobileRemote(): Promise<void> {
  const [platform] = await Promise.all([
    createTauriMobileRemotePlatform(),
    mobileI18nReady,
  ]);

  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root");

  if (process.env.NODE_ENV === "development") {
    const { MobileRemoteDevelopmentRoot, resolveDevelopmentPairingUserId } =
      await import("./modules/MobileRemote/dev/MobileRemoteDevelopmentRoot");
    const pairingUserId = await resolveDevelopmentPairingUserId(platform);
    createRoot(root).render(
      <I18nextProvider i18n={mobileI18n}>
        <MobileRemoteDevelopmentRoot
          platform={platform}
          pairingUserId={pairingUserId}
        />
      </I18nextProvider>
    );
    return;
  }

  createRoot(root).render(
    <I18nextProvider i18n={mobileI18n}>
      <MobileRemoteRoot platform={platform} />
    </I18nextProvider>
  );
}

void mountMobileRemote().catch(showStartupError);
