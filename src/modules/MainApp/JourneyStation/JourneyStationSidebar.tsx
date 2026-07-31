/**
 * Journey Station sidebar
 *
 * Lists the two Journey scopes — Projects and Sessions — at the same nav
 * depth Ops Control gives its sidebar. Rows only select a scope; the main
 * surface renders the canonical `journey_graph_query` result for it.
 * No lineage is inferred here: projects come from the project API and
 * sessions from the session store, both already canonical sources.
 */
import { useAtom, useAtomValue } from "jotai";
import { Box, GitBranch, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type ProjectLike,
  loadProjectTreeBundle,
} from "@src/modules/ProjectManager/ProjectJourney";
import { sessionsAtom } from "@src/store/session";
import { workstationActiveSessionIdAtom } from "@src/store/session";
import {
  type JourneyStationSelection,
  journeyStationSelectionAtom,
} from "@src/store/ui/journeyStationAtom";
import { getSessionListDisplayName } from "@src/util/session/sessionSidebarRow";

const SESSION_LIST_LIMIT = 30;

interface JourneyRowProps {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
  testId?: string;
}

const JourneyRow: React.FC<JourneyRowProps> = ({
  icon,
  label,
  selected,
  onClick,
  testId,
}) => (
  <button
    type="button"
    data-testid={testId}
    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
      selected
        ? "bg-fill-3 text-text-1"
        : "text-text-2 hover:bg-fill-2 hover:text-text-1"
    }`}
    onClick={onClick}
  >
    <span className="shrink-0">{icon}</span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
  </button>
);

const JourneyStationSidebar: React.FC = () => {
  const { t } = useTranslation(["navigation", "common"]);
  const [selection, setSelection] = useAtom(journeyStationSelectionAtom);
  const sessions = useAtomValue(sessionsAtom);
  const activeSessionId = useAtomValue(workstationActiveSessionIdAtom);

  const [projects, setProjects] = useState<ProjectLike[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);

  const reloadProjects = useCallback(async () => {
    setLoadingProjects(true);
    setProjectsError(null);
    try {
      const bundle = await loadProjectTreeBundle();
      setProjects(bundle.projects);
      if (bundle.error) setProjectsError(bundle.error);
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void reloadProjects();
  }, [reloadProjects]);

  const recentSessions = useMemo(() => {
    return sessions
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.updated_at || a.created_at || 0).getTime();
        const tb = new Date(b.updated_at || b.created_at || 0).getTime();
        return tb - ta;
      })
      .slice(0, SESSION_LIST_LIMIT);
  }, [sessions]);

  const select = useCallback(
    (next: JourneyStationSelection) => {
      setSelection(next);
    },
    [setSelection]
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-2"
      data-testid="journey-station-sidebar"
    >
      <section aria-label={t("navigation:routes.projects")}>
        <div className="mb-1 flex items-center justify-between px-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-3">
            {t("navigation:routes.projects")}
          </h3>
          <button
            type="button"
            aria-label={t("common:actions.reload")}
            className="rounded p-0.5 text-text-3 hover:bg-fill-2 hover:text-text-1"
            onClick={() => void reloadProjects()}
          >
            <RefreshCw size={12} />
          </button>
        </div>
        {loadingProjects && (
          <div className="px-2 text-[11px] text-text-4">
            {t("common:status.loading")}
          </div>
        )}
        {projectsError && (
          <div className="px-2 text-[11px] text-warning-6" role="alert">
            {projectsError}
          </div>
        )}
        {!loadingProjects && projects.length === 0 && !projectsError && (
          <div className="px-2 text-[11px] text-text-4">
            {t("navigation:journeyStation.noProjects", {
              defaultValue: "No projects yet",
            })}
          </div>
        )}
        {projects.map((project) => {
          const identity = project.id || project.slug || "";
          return (
            <JourneyRow
              key={identity}
              icon={<Box size={13} className="text-primary-6" />}
              label={project.name}
              selected={
                selection?.kind === "project" && selection.id === identity
              }
              onClick={() =>
                select({ kind: "project", id: identity, name: project.name })
              }
              testId="journey-station-project-row"
            />
          );
        })}
      </section>

      <section aria-label={t("navigation:routes.sessions")}>
        <h3 className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-text-3">
          {t("navigation:routes.sessions")}
        </h3>
        {recentSessions.length === 0 && (
          <div className="px-2 text-[11px] text-text-4">
            {t("navigation:journeyStation.noSessions", {
              defaultValue: "No sessions yet",
            })}
          </div>
        )}
        {recentSessions.map((session) => {
          const label = getSessionListDisplayName(
            session,
            t("navigation:routes.session")
          );
          const isActive = session.session_id === activeSessionId;
          return (
            <JourneyRow
              key={session.session_id}
              icon={
                <GitBranch
                  size={13}
                  className={isActive ? "text-success-6" : "text-text-3"}
                />
              }
              label={isActive ? `${label} ·` : label}
              selected={
                selection?.kind === "session" &&
                selection.id === session.session_id
              }
              onClick={() =>
                select({
                  kind: "session",
                  id: session.session_id,
                  name: label,
                })
              }
              testId="journey-station-session-row"
            />
          );
        })}
      </section>
    </div>
  );
};

export default JourneyStationSidebar;
