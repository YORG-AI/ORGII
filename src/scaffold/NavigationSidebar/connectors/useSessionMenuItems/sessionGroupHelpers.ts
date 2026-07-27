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
  switch (groupKey) {
    case "sde":
      return "rust_agent:sde";
    case "os":
      return "rust_agent:os";
    case "wingman":
      return "rust_agent:wingman";
    case "custom":
      return "rust_agent:custom";
  }
}
