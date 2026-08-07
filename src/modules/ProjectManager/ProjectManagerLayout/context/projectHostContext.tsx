/**
 * Project host context — Phase 2.1 of the WorkStation unified-tab migration.
 *
 * Publishes the Project host's action surface ABOVE the tab dispatcher so that
 * `UnifiedTabContent` renderers for project tab types can consume it directly,
 * instead of receiving it as props threaded through
 * `ProjectManagerContentRouter`. This is the "host context hoist" the staged
 * renderers (`TabContent/renderers/project*.tsx`) wait on before they can drop
 * their `HostCoupledPlaceholder` stubs.
 *
 * The value is exactly the prop bundle the content router receives today, minus
 * `tabs`/`activeTab` (a renderer only handles its own tab, passed via
 * `UnifiedTabContentProps`), plus `repoName`. Sourcing it from
 * `ProjectManagerContentRouterProps` keeps the two in lockstep by construction.
 *
 * See docs/workstation-unification/phase-2-host-hoist-plan.md (Phase 2.1).
 */
import { type ReactNode, createContext, useContext } from "react";

import type { ProjectManagerContentRouterProps } from "../types";

export type ProjectHostContextValue = Omit<
  ProjectManagerContentRouterProps,
  "tabs" | "activeTab"
> & {
  /** Repository name for display (sidebar/detail surfaces). */
  repoName: string;
};

const ProjectHostContext = createContext<ProjectHostContextValue | null>(null);

export function ProjectHostProvider({
  value,
  children,
}: {
  value: ProjectHostContextValue;
  children: ReactNode;
}) {
  return (
    <ProjectHostContext.Provider value={value}>
      {children}
    </ProjectHostContext.Provider>
  );
}

/**
 * Read the Project host context. Throws if used outside a `ProjectHostProvider`
 * — this guards against mounting a project renderer through the unified
 * dispatcher before the host context has been hoisted above it (which would
 * otherwise silently render a degraded surface).
 */
export function useProjectHostContext(): ProjectHostContextValue {
  const ctx = useContext(ProjectHostContext);
  if (ctx === null) {
    throw new Error(
      "useProjectHostContext must be used within a ProjectHostProvider"
    );
  }
  return ctx;
}
