import React from "react";

import { Placeholder } from "@src/components/Placeholder";

import { useProjectOrgCatalogData } from "../hooks/useProjectOrgCatalogData";
import { ProjectOrgSettingsPane } from "./ProjectOrgSettingsPane";

interface ProjectOrgSettingsTabContentProps {
  orgId: string;
  initialSection?: string;
}

export const ProjectOrgSettingsTabContent: React.FC<
  ProjectOrgSettingsTabContentProps
> = ({ orgId }) => {
  const catalog = useProjectOrgCatalogData(orgId);

  if (catalog.loading) {
    return <Placeholder variant="loading" fillParentHeight />;
  }

  if (catalog.loadError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-danger-6/30 bg-danger-2/20 px-4 py-3 text-sm text-danger-6">
          {catalog.loadError}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 scrollbar-hide">
      <ProjectOrgSettingsPane
        org={catalog.org}
        projectCount={catalog.projects.length}
        labels={catalog.labels}
        folderPath={catalog.folderPath}
        onFolderPathChange={catalog.setFolderPath}
        onConfigureGitFolder={catalog.handleConfigureGitFolder}
        onSyncGitFolder={catalog.handleSyncGitFolder}
        onUpdateLabels={catalog.handleUpdateLabels}
        onDeleteOrg={catalog.handleDeleteOrg}
      />
    </div>
  );
};

export default ProjectOrgSettingsTabContent;
