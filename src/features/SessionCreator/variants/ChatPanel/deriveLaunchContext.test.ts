import type {
  ChatPanelSelectedProject,
  ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";
import type { Project } from "@src/types/core/project";
import type { WorkItem } from "@src/types/core/workItem";

import { deriveChatPanelLaunchContext } from "./deriveLaunchContext";

describe("deriveChatPanelLaunchContext", () => {
  it("defaults launches to the personal org when no org, project, or work item is selected", () => {
    expect(
      deriveChatPanelLaunchContext({
        activeCloudOrg: null,
        selectedProjectContext: null,
        selectedProjectOrgContext: null,
        selectedWorkItemContext: null,
      })
    ).toEqual({
      orgId: "personal-org",
      orgName: "Personal Org",
    });
  });

  it("uses the selected project's owning org and project metadata", () => {
    const selectedProject: ChatPanelSelectedProject = {
      orgId: "org-platform",
      orgName: "Platform",
      projectSlug: "runtime",
      project: {
        id: "project-runtime",
        name: "Runtime",
      } as unknown as Project,
    };

    expect(
      deriveChatPanelLaunchContext({
        activeCloudOrg: null,
        selectedProjectContext: selectedProject,
        selectedProjectOrgContext: null,
        selectedWorkItemContext: null,
      })
    ).toEqual({
      orgId: "org-platform",
      orgName: "Platform",
      projectId: "project-runtime",
      projectName: "Runtime",
      projectSlug: "runtime",
    });
  });

  it("uses the selected work item's org, project, and short ID", () => {
    const selectedWorkItem: ChatPanelSelectedWorkItem = {
      orgId: "org-platform",
      orgName: "Platform",
      projectId: "project-runtime",
      projectName: "Runtime",
      projectSlug: "runtime",
      shortId: "RUN-12",
      workItem: {
        id: "work-item-12",
        title: "Add org sessions",
      } as unknown as WorkItem,
    };

    expect(
      deriveChatPanelLaunchContext({
        activeCloudOrg: null,
        selectedProjectContext: null,
        selectedProjectOrgContext: null,
        selectedWorkItemContext: selectedWorkItem,
      })
    ).toEqual({
      orgId: "org-platform",
      orgName: "Platform",
      projectId: "project-runtime",
      projectName: "Runtime",
      projectSlug: "runtime",
      workItemId: "RUN-12",
      agentRole: "custom",
    });
  });

  it("uses the active cloud workspace for an otherwise unscoped launch", () => {
    expect(
      deriveChatPanelLaunchContext({
        activeCloudOrg: { orgId: "cloud-org-1", name: "Cloud Team" },
        selectedProjectContext: null,
        selectedProjectOrgContext: null,
        selectedWorkItemContext: null,
      })
    ).toEqual({
      orgId: "cloud:cloud-org-1",
      orgName: "Cloud Team",
    });
  });

  it("keeps an explicit project context ahead of the sidebar cloud workspace", () => {
    const selectedProject: ChatPanelSelectedProject = {
      orgId: "org-platform",
      orgName: "Platform",
      projectSlug: "runtime",
      project: {
        id: "project-runtime",
        name: "Runtime",
      } as unknown as Project,
    };

    expect(
      deriveChatPanelLaunchContext({
        activeCloudOrg: { orgId: "cloud-org-1", name: "Cloud Team" },
        selectedProjectContext: selectedProject,
        selectedProjectOrgContext: null,
        selectedWorkItemContext: null,
      })
    ).toMatchObject({
      orgId: "org-platform",
      projectId: "project-runtime",
    });
  });
});
