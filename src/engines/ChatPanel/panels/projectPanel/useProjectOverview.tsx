import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";

import { projectApi } from "@src/api/http/project";
import { Placeholder } from "@src/components/Placeholder";
import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import { createLogger } from "@src/hooks/logger";
import { ProjectContentEditor } from "@src/modules/ProjectManager/shared";
import type { ChatPanelSelectedProject } from "@src/store/ui/chatPanelAtom";

const logger = createLogger("ProjectPanelView");

function getProjectOverviewDescription(
  project: ChatPanelSelectedProject["project"]
) {
  const description = project.description?.trim() ?? "";
  return description === project.name.trim() ? "" : description;
}

/** Owns the overview draft and saves for the whole pane, even before its first visit. */
export function useProjectOverview(
  selectedProject: ChatPanelSelectedProject,
  t: TFunction<["projects", "common"]>
) {
  const projectSlug =
    selectedProject.projectSlug || selectedProject.project.slug;
  const repoPath = selectedProject.project.linkedRepos?.[0]?.path ?? null;
  const sidebarProjectDescription = getProjectOverviewDescription(
    selectedProject.project
  );
  const [projectDescription, setProjectDescription] = useState(
    sidebarProjectDescription
  );
  const [projectBodyLoading, setProjectBodyLoading] = useState(false);
  const [projectBodyError, setProjectBodyError] = useState<string | null>(null);
  const lastSavedDescriptionRef = useRef(sidebarProjectDescription);
  useEffect(() => {
    let cancelled = false;

    if (!projectSlug) {
      setProjectDescription(sidebarProjectDescription);
      lastSavedDescriptionRef.current = sidebarProjectDescription;
      return;
    }

    setProjectBodyLoading(true);
    setProjectBodyError(null);
    void (async () => {
      try {
        const currentProject = await projectApi.readProject(projectSlug);
        if (cancelled) return;
        const nextDescription = currentProject.description.trim();
        setProjectDescription(nextDescription);
        lastSavedDescriptionRef.current = nextDescription;
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load project body";
        setProjectBodyError(message);
      } finally {
        if (!cancelled) {
          setProjectBodyLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectSlug, selectedProject.project.id, sidebarProjectDescription]);

  useEffect(() => {
    if (
      !projectSlug ||
      lastSavedDescriptionRef.current === projectDescription
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const currentProject = await projectApi.readProject(projectSlug);
          await projectApi.writeProject(
            projectSlug,
            {
              ...currentProject.meta,
              updated_at: new Date().toISOString(),
            },
            projectDescription
          );
          lastSavedDescriptionRef.current = projectDescription;
        } catch (error) {
          logger.error("Failed to save project overview description:", error);
        }
      })();
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [projectDescription, projectSlug]);

  const handleDescriptionChange = useCallback((markdown: string) => {
    setProjectDescription(markdown);
  }, []);

  const overviewContent = projectBodyLoading ? (
    <div className="p-2">
      <ChatLoadingBlock />
    </div>
  ) : projectBodyError ? (
    <Placeholder variant="error" title={projectBodyError} fillParentHeight />
  ) : (
    <section data-testid="chat-panel-project-overview-section">
      <ProjectContentEditor
        key={projectSlug}
        title={selectedProject.project.name}
        onTitleChange={() => undefined}
        initialDescription={projectDescription}
        onDescriptionChange={handleDescriptionChange}
        titleVisible={false}
        separatorVisible={false}
        descriptionPlaceholder={t("workItems.overview.descriptionPlaceholder")}
        editable
        descriptionClassName="no-bottom-border"
        repoPath={repoPath}
        className="w-full"
      />
    </section>
  );

  return overviewContent;
}
