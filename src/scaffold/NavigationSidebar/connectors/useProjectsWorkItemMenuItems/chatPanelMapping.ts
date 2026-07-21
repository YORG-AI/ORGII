import { enrichedWorkItemToUI, projectDataToUI } from "@src/api/http/project";
import type {
  ChatPanelSelectedProject,
  ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";

import type { SidebarProject, SidebarWorkItem } from "./types";

export function toChatPanelProject(
  project: SidebarProject
): ChatPanelSelectedProject {
  return {
    project: projectDataToUI(project.projectData, {
      labelMap: project.labelMap,
      memberMap: project.memberMap,
    }),
    projectSlug: project.projectData.slug,
    projectSyncAdapterId: project.projectSyncAdapterId,
    orgId: project.orgId,
    orgName: project.orgName,
  };
}

export function toChatPanelWorkItem(
  workItem: SidebarWorkItem
): ChatPanelSelectedWorkItem {
  return {
    workItem: enrichedWorkItemToUI(workItem),
    projectId: workItem.projectId,
    projectName: workItem.projectName,
    projectSlug: workItem.projectSlug,
    shortId: workItem.shortId,
    orgId: workItem.orgId,
    orgName: workItem.orgName,
  };
}
