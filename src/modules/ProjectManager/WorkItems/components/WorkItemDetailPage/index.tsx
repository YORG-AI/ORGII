import React from "react";

import { ProjectScopedWorkItemDetailPage } from "./ProjectScopedWorkItemDetailPage";
import { StandaloneWorkItemDetailPage } from "./StandaloneWorkItemDetailPage";
import type { WorkItemDetailPageProps } from "./types";

const WorkItemDetailPage: React.FC<WorkItemDetailPageProps> = (props) => {
  return props.projectSlug ? (
    <ProjectScopedWorkItemDetailPage {...props} />
  ) : (
    <StandaloneWorkItemDetailPage {...props} />
  );
};

export default WorkItemDetailPage;
