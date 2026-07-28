import {
  getImportedHistorySourceByListCategory,
  isImportedHistoryListCategory,
} from "@src/api/tauri/externalHistory";
import type { SessionGroupKey } from "@src/config/sessionAgentGroups";
import type { SessionListCategory } from "@src/store/session";

export function groupKeyToWireCategory(
  groupKey: SessionGroupKey
): SessionListCategory {
  if (isImportedHistoryListCategory(groupKey)) {
    return (
      getImportedHistorySourceByListCategory(groupKey)?.listCategory ?? groupKey
    );
  }
  if (groupKey === "cli") return "cli_agent";
  if (groupKey === "human") return "human_session";
  return "rust_agent";
}
