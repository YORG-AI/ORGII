/**
 * i18n label strings for `WorkstationSidebarConnector` (`index.tsx`). Pure
 * string lookups — no hooks, no state — split out purely to shrink the
 * connector's body.
 */
import type { TFunction } from "i18next";

import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";

type TCommon = (key: string, defaultValue?: string) => string;

interface BuildWorkstationSidebarLabelsParams {
  t: TFunction;
  tProjects: TFunction;
  tSessions: TFunction;
  tCommon: TCommon;
}

export function buildWorkstationSidebarLabels({
  t,
  tProjects,
  tSessions,
  tCommon,
}: BuildWorkstationSidebarLabelsParams) {
  const untitledSession = t("sidebar.defaults.untitledSession");
  const newSessionLabel = t("labels.newSession");
  const pinFolderLabel = tCommon("sessions:chat.pinSession", "Pin");
  const unpinFolderLabel = tCommon("sessions:chat.unpinSession", "Unpin");
  const createProjectLabel = tProjects("projects.createProject");
  const createWorkItemLabel = tProjects("workItems.createWorkItem");
  const workItemsLabel = t("labels.workItems");
  const runtimeLabel = tSessions("chat.startPage.tabs.runtime");
  const teamInboxLabel = t("labels.inbox");
  const importGithubIssuesLabel = tProjects("githubIssuesImport.menuLabel");
  const addOrgLabel = t("collaboration.addOrg");
  const manageOrgLabel = t("collaboration.manageOrg");
  const moreActionsLabel = tCommon("common:actions.more", "More actions");
  const pinWorkspaceLabel = tCommon(
    "sessions:chat.pinWorkspaceGroup",
    "Pin workspace"
  );
  const unpinWorkspaceLabel = tCommon(
    "sessions:chat.unpinWorkspaceGroup",
    "Unpin workspace"
  );
  const hideWorkspaceLabel = tCommon(
    "sessions:chat.hideWorkspaceGroup",
    "Hide workspace"
  );
  const unhideWorkspaceLabel = tCommon(
    "sessions:chat.unhideWorkspaceGroup",
    "Unhide workspace"
  );
  const revealWorkspaceLabel = tCommon(getFileManagerRevealLabelKey());
  const workspaceUnavailableTitle = tSessions("chat.workspaceUnavailableTitle");
  const workspaceUnavailableMessage = tSessions(
    "chat.workspaceUnavailableMessage"
  );
  return {
    untitledSession,
    newSessionLabel,
    pinFolderLabel,
    unpinFolderLabel,
    createProjectLabel,
    createWorkItemLabel,
    workItemsLabel,
    runtimeLabel,
    teamInboxLabel,
    importGithubIssuesLabel,
    addOrgLabel,
    manageOrgLabel,
    moreActionsLabel,
    pinWorkspaceLabel,
    unpinWorkspaceLabel,
    hideWorkspaceLabel,
    unhideWorkspaceLabel,
    revealWorkspaceLabel,
    workspaceUnavailableTitle,
    workspaceUnavailableMessage,
  };
}
