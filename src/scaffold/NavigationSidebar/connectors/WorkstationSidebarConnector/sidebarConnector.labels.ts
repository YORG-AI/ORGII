/**
 * i18n label strings for `WorkstationSidebarConnector` (`index.tsx`). Pure
 * string lookups — no hooks, no state — split out purely to shrink the
 * connector's body.
 */
import type { TFunction } from "i18next";

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
  const importGithubIssuesLabel = tProjects("githubIssuesImport.menuLabel");
  const addOrgLabel = t("collaboration.addOrg");
  const manageOrgLabel = t("collaboration.manageOrg");
  const searchPlaceholder = tCommon("common.searchPlaceholder", "Search...");
  const noSearchResultsTitle = t("sidebar.empty.noSearchResults");

  return {
    untitledSession,
    newSessionLabel,
    pinFolderLabel,
    unpinFolderLabel,
    createProjectLabel,
    createWorkItemLabel,
    workItemsLabel,
    runtimeLabel,
    importGithubIssuesLabel,
    addOrgLabel,
    manageOrgLabel,
    searchPlaceholder,
    noSearchResultsTitle,
  };
}
