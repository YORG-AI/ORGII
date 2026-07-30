import React from "react";

import type { JourneyScope } from "@src/api/tauri/journeyGraph";
import { JourneyContainer } from "@src/modules/ProjectManager/JourneyGraph";

export interface ProjectJourneyPageProps { projectId?: string; projectSlug?: string; projectName?: string; forceDemo?: boolean; }

/** Read-only project wrapper over the shared Journey graph container. */
const ProjectJourneyPage: React.FC<ProjectJourneyPageProps> = ({ projectId, projectSlug, projectName }) => {
  const identity = projectId ?? projectSlug;
  if (!identity) return <div className="p-3 text-xs text-warning-6" role="alert">Journey unavailable: Project identity is required; refusing to guess a Journey graph.</div>;
  return <JourneyContainer scope={`project/${identity}` as JourneyScope} title={`Project Journey${projectName ? ` · ${projectName}` : ""}`} />;
};
export default ProjectJourneyPage;
