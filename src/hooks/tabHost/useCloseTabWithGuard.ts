/**
 * Universal close handler for any WorkStation tab. Prompts to discard when
 * the tab is dirty (`hasUnsavedChanges`), then dispatches `closeTabAtom`.
 *
 * Side effects beyond the prompt (browser session teardown, project draft
 * cleanup, etc.) are handled declaratively by each host via reconciliation
 * effects that watch the tab list. There is no override registry — every
 * caller (TabBar, keyboard shortcut, action system) goes through this hook.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  type TabCloseRequest,
  closeTabAtom,
  tabRegistryAtom,
} from "@src/store/workstation/tabRegistry";

export function useCloseTabWithGuard(): (
  request: TabCloseRequest
) => Promise<void> {
  const { t } = useTranslation();
  const closeTab = useSetAtom(closeTabAtom);
  const entries = useAtomValue(tabRegistryAtom);

  return useCallback(
    async (request: TabCloseRequest) => {
      const entry = entries.find((item) => item.tab.id === request.tabId);

      if (entry?.tab.hasUnsavedChanges) {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const confirmed = await ask(
          `"${entry.tab.title}" has unsaved changes. Discard them and close?`,
          {
            title: t("workstation.unsavedChangesTitle"),
            kind: "warning",
            okLabel: t("actions.discard"),
            cancelLabel: t("actions.cancel"),
          }
        );
        if (!confirmed) return;
      }

      closeTab(request);
    },
    [entries, closeTab, t]
  );
}
