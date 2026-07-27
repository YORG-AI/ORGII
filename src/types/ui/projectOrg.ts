/** Project-organization surfaces shared by chat and workstation navigation. */
export const PROJECT_ORG_SURFACE_VIEW = {
  PROJECTS: "projects",
  WORK_ITEMS: "work-items",
  SETTINGS: "settings",
} as const;

export type ProjectOrgSurfaceView =
  (typeof PROJECT_ORG_SURFACE_VIEW)[keyof typeof PROJECT_ORG_SURFACE_VIEW];
