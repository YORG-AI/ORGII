/**
 * Open an Agent / Team configuration tab in the WorkStation Code Editor
 * surface.
 *
 * Mirrors `openFileInWorkStation` but produces an `agent-config` tab
 * driven by the {@link AgentConfigTabData} payload. The tab id is keyed
 * by `<variant>:<entityId>` (see `agentConfigTabFactory`), so re-opening
 * the same agent / team focuses the existing tab instead of duplicating.
 *
 * Called from the Agent Teams page table rows (Agents / Teams / CLIs tabs)
 * and from the row "View" buttons.
 */
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  createAgentConfigTab,
  openTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import type { AgentConfigTabData } from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

export function openAgentConfigInWorkStation(data: AgentConfigTabData): void {
  if (!data.entityId || data.entityId.trim().length === 0) return;

  const store = getInstrumentedStore();
  store.set(stationModeAtom, "my-station");
  if (store.get(chatPanelMaximizedAtom)) {
    store.set(chatPanelMaximizedAtom, false);
  }

  const tab = createAgentConfigTab(data);
  store.set(workstationLayoutAtom, (prev) => ({
    ...prev,
    mainPane: openTab(prev?.mainPane ?? { tabs: [], activeTabId: null }, tab),
  }));
}
