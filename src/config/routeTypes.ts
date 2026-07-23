/** Context available when resolving dynamic route labels. */
export interface RouteLabelContext {
  repoId?: string;
  repoName?: string;
  workItemId?: string;
  workItemName?: string;
  [key: string]: string | undefined;
}

/** Display metadata for an application route. */
export interface RouteInfo {
  path: string;
  label: string | ((context: RouteLabelContext) => string);
  description?: string;
  icon?: string;
}
