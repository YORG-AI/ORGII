import { hasNonEmptyTerminalBuffer } from "@src/components/TerminalInteractive/bufferCache";
import type { CustomMentionOption } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import type { MenuItemId } from "@src/scaffold/ContextMenu/config";
import type { WorkStationTab } from "@src/store/workstation/tabs";
import { getCompactPathLabel } from "@src/util/file/pathUtils";
import { formatRepoPathForDisplay } from "@src/util/file/repoPathDisplay";

const getStringData = (
  tab: WorkStationTab,
  key: string
): string | undefined => {
  const value = tab.data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

const isCustomMentionOption = (
  option: CustomMentionOption | null
): option is CustomMentionOption => option !== null;

export const getOpenedTabMentionOption = (
  tab: WorkStationTab
): CustomMentionOption | null => {
  const baseOption = (
    selectType: MenuItemId,
    selectValue: string,
    description: string,
    selectDisplayName: string = tab.title
  ): CustomMentionOption => ({
    id: `workstation-tab:${tab.id}`,
    label: tab.title,
    description,
    groupLabel: "Open tabs",
    selectType,
    selectValue,
    selectDisplayName,
  });

  if (tab.type === "file" || tab.type === "git-diff") {
    const filePath = getStringData(tab, "filePath");
    if (!filePath) return null;
    const displayPath = formatRepoPathForDisplay({
      path: filePath,
      repoPath: getStringData(tab, "repoPath"),
    }).displayPath;
    return baseOption(
      "files",
      filePath,
      displayPath || filePath,
      getCompactPathLabel(displayPath || filePath)
    );
  }

  if (tab.type === "directory") {
    const directoryPath = getStringData(tab, "directoryPath");
    if (!directoryPath) return null;
    return baseOption("folder", directoryPath, directoryPath);
  }

  if (tab.type === "terminal") {
    const sessionId = getStringData(tab, "sessionId");
    if (!sessionId || !hasNonEmptyTerminalBuffer(sessionId)) return null;
    return baseOption("terminal", sessionId, "Terminal");
  }

  if (tab.type === "browser-session") {
    const sessionId = getStringData(tab, "sessionId");
    if (!sessionId) return null;
    return baseOption(
      "browser",
      sessionId,
      getStringData(tab, "url") ?? "Browser"
    );
  }

  if (tab.type === "chat-session") {
    const sessionId = getStringData(tab, "sessionId");
    if (!sessionId) return null;
    return baseOption("session", sessionId, "Session");
  }

  if (tab.type === "project-workitems") {
    const projectSlug = getStringData(tab, "projectSlug");
    if (!projectSlug) return null;
    return baseOption("project", projectSlug, "Work items");
  }

  if (tab.type === "workItem-detail") {
    const workItemId = getStringData(tab, "workItemId");
    if (!workItemId) return null;
    return baseOption(
      "workitem",
      workItemId,
      getStringData(tab, "projectName") ?? "Work item",
      getStringData(tab, "workItemName") ?? tab.title
    );
  }

  return null;
};

function getMentionOptionTargetKey(option: CustomMentionOption): string {
  return `${option.selectType}:${option.selectValue}`;
}

export const getOpenedTabMentionOptions = (
  workstationTabs: ReadonlyArray<WorkStationTab>
): CustomMentionOption[] => {
  const options: CustomMentionOption[] = [];
  const seenTargets = new Set<string>();

  for (const tab of workstationTabs) {
    const option = getOpenedTabMentionOption(tab);
    if (!isCustomMentionOption(option)) continue;

    const targetKey = getMentionOptionTargetKey(option);
    if (seenTargets.has(targetKey)) continue;

    seenTargets.add(targetKey);
    options.push(option);
  }

  return options;
};
