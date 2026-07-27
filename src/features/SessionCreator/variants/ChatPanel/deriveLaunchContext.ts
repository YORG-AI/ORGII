import type { SessionLaunchWorkItemContext } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { buildCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  DEFAULT_SESSION_ORG_ID,
  DEFAULT_SESSION_ORG_NAME,
} from "@src/store/session";
import type {
  ChatPanelSelectedProject,
  ChatPanelSelectedProjectOrg,
  ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";

export interface ChatPanelLaunchContextInput {
  activeCloudOrg: { orgId: string; name: string } | null;
  selectedProjectOrgContext: ChatPanelSelectedProjectOrg | null;
  selectedProjectContext: ChatPanelSelectedProject | null;
  selectedWorkItemContext: ChatPanelSelectedWorkItem | null;
}

export function deriveChatPanelLaunchContext({
  activeCloudOrg,
  selectedProjectOrgContext,
  selectedProjectContext,
  selectedWorkItemContext,
}: ChatPanelLaunchContextInput): SessionLaunchWorkItemContext {
  if (selectedWorkItemContext) {
    return {
      orgId: selectedWorkItemContext.orgId ?? DEFAULT_SESSION_ORG_ID,
      orgName: selectedWorkItemContext.orgName ?? DEFAULT_SESSION_ORG_NAME,
      projectId: selectedWorkItemContext.projectId,
      projectName: selectedWorkItemContext.projectName,
      projectSlug: selectedWorkItemContext.projectSlug,
      workItemId: selectedWorkItemContext.shortId,
      agentRole: "custom",
    };
  }

  if (selectedProjectContext) {
    return {
      orgId: selectedProjectContext.orgId,
      orgName: selectedProjectContext.orgName,
      projectId: selectedProjectContext.project.id,
      projectName: selectedProjectContext.project.name,
      projectSlug: selectedProjectContext.projectSlug,
    };
  }

  if (selectedProjectOrgContext) {
    return {
      orgId: selectedProjectOrgContext.orgId,
      orgName: selectedProjectOrgContext.orgName,
    };
  }

  if (activeCloudOrg) {
    return {
      orgId: buildCloudOrgSelectorValue(activeCloudOrg.orgId),
      orgName: activeCloudOrg.name,
    };
  }

  return {
    orgId: DEFAULT_SESSION_ORG_ID,
    orgName: DEFAULT_SESSION_ORG_NAME,
  };
}
