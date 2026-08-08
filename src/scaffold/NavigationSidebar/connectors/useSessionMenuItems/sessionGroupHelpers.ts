import { RUST_AGENT_TYPE } from "@src/api/tauri/agent/types";
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
  if (groupKey === RUST_AGENT_TYPE.OS) return "os_agent";
  return "standalone_agent";
}
