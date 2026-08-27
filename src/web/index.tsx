import { createRoot } from "react-dom/client";

import { AppProviders } from "@src/app/root/AppProviders";
import ErrorBoundary from "@src/app/root/components/ErrorBoundary";
import { i18nReady } from "@src/i18n";
import "@src/index.scss";
import { initTheme } from "@src/util/core/init/themeInit";

import { WebApp } from "./WebApp";

async function mountWebApp(): Promise<void> {
  // The tool registry is NOT initialized here: its only consumers are the
  // transcript's chat-item pipeline, so it loads with the session page's
  // lazy chunk instead of gating first paint of /login and the roster.
  await Promise.all([i18nReady, initTheme()]);
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("ORG2 Web root element is missing");
  createRoot(rootElement).render(
    <AppProviders>
      <ErrorBoundary>
        <WebApp />
      </ErrorBoundary>
    </AppProviders>
  );
}

void mountWebApp();
