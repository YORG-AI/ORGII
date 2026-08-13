/**
 * Tab-bar trailing controls
 *
 * Per-app toggle buttons rendered in the trailing slot of the WorkStation tab
 * bar. Each control reads its `*Collapsed` atom directly so the visibility
 * flip happens in the same commit as the underlying toggle, avoiding a
 * one-frame flash. The click handler still flows through
 * `activeStatusBarCallbacksAtom` because AppShell registers handlers per
 * active app (Code Editor → bottom panel, Browser → DevTools).
 */
import { useAtomValue } from "jotai";
import { PanelBottom, PencilRuler } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import {
  workStationDevToolsCollapsedAtom,
  workStationEditorSecondaryCollapsedAtom,
} from "@src/store/ui/workStationAtom";
import { activeStatusBarCallbacksAtom } from "@src/store/ui/workStationLayout/statusBarAtoms";

import { TabBarTrailingIconButton } from "./TabBar/components/TabBarTrailingIconButton";
import { HEADER_ICON_SIZE } from "./tokens";

export const TabBarBottomPanelToggle: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const callbacks = useAtomValue(activeStatusBarCallbacksAtom);
  const bottomPanelCollapsed = useAtomValue(
    workStationEditorSecondaryCollapsedAtom
  );
  const hidden = !callbacks.onToggleBottomPanel || !bottomPanelCollapsed;
  if (hidden) return null;

  return (
    <TabBarTrailingIconButton
      title={t("titleBar.showBottomPanel")}
      onClick={() => callbacks.onToggleBottomPanel?.()}
    >
      <PanelBottom size={HEADER_ICON_SIZE.md} strokeWidth={1.75} />
    </TabBarTrailingIconButton>
  );
});

TabBarBottomPanelToggle.displayName = "TabBarBottomPanelToggle";

export const TabBarDevToolsToggle: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const callbacks = useAtomValue(activeStatusBarCallbacksAtom);
  const devToolsCollapsed = useAtomValue(workStationDevToolsCollapsedAtom);
  const hidden = !callbacks.onToggleDevTools || !devToolsCollapsed;
  if (hidden) return null;

  return (
    <TabBarTrailingIconButton
      title={t("titleBar.showDevTools")}
      shortcutId="browser_devtools"
      onClick={() => callbacks.onToggleDevTools?.()}
    >
      <PencilRuler size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
    </TabBarTrailingIconButton>
  );
});

TabBarDevToolsToggle.displayName = "TabBarDevToolsToggle";
