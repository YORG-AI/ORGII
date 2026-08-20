import { createRoot } from "react-dom/client";

import { AppProviders } from "@src/app/root/AppProviders";
import ErrorBoundary from "@src/components/ErrorBoundary";
import { initToolRegistry } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { i18nReady } from "@src/i18n";
import "@src/index.scss";
import { initTheme } from "@src/util/core/init/themeInit";

import { WebApp } from "./WebApp";

async function mountWebApp(): Promise<void> {
  await Promise.all([i18nReady, initTheme(), initToolRegistry()]);
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
