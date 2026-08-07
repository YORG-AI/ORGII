/**
 * useUrlPreviewEvents Hook
 *
 * Listens for Tauri events to open URL preview tabs in the editor.
 * Used by agent tools to trigger URL preview in the editor area.
 *
 * Event: "open-url-preview"
 * Payload: { url: string, title?: string }
 */
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import { EditorTabService } from "@src/services/workStation/EditorTabService";
import { createUrlPreviewTab } from "@src/store/workstation/tabs/factories";
import { isTauriDesktop } from "@src/util/platform/tauri";

const log = createLogger("useUrlPreviewEvents");

interface UrlPreviewPayload {
  url: string;
  title?: string;
}

/**
 * Hook to listen for URL preview events from the backend
 * Opens a URL preview tab when triggered by agent tools
 */
export function useUrlPreviewEvents(): void {
  const isTauri = isTauriDesktop();

  // Ref to keep the tab service accessible
  const serviceRef = useRef(EditorTabService);

  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    listen<UrlPreviewPayload>("open-url-preview", (event) => {
      if (cancelled) return;

      const { url, title } = event.payload;
      if (!url) {
        log.warn("[useUrlPreviewEvents] Received event with empty URL");
        return;
      }

      // Create and open the URL preview tab
      const tab = createUrlPreviewTab(url, title);
      serviceRef.current.openTab(tab);

      // URL preview tab opened successfully
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenFn = unlisten;
      }
    });

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, [isTauri]);
}
