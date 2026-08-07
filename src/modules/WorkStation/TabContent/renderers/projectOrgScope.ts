/**
 * Shared org-scope derivation for the `project-dashboard` and
 * `project-work-items` tab renderers.
 *
 * Both renderers translate a tab's `orgScope` into the same
 * `allowExternalSources` / scoped-org-id pair before handing it to their
 * underlying page — mirroring `ProjectManagerContentRouter`. Extracted here so
 * the two wrappers stay thin and the derivation lives in one place.
 */
import { getTabDataString } from "@src/modules/ProjectManager/ProjectManagerLayout/components/projectManagerRouterUtils";
import { STORY_ORG_SCOPE } from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs";

export interface ProjectOrgScopeProps {
  /** Whether sources outside the scoped org may be surfaced. */
  allowExternalSources: boolean;
  /** Org id to scope the view to, or `undefined` when showing all orgs. */
  scopedOrgId: string | undefined;
}

/**
 * Derives the shared org-scope props from a tab's data. Behaviour is identical
 * to the inline derivation the dashboard / work-items renderers previously
 * duplicated.
 */
export function getProjectOrgScopeProps(
  tab: WorkStationTab
): ProjectOrgScopeProps {
  const orgScope =
    (tab.data.orgScope as string | undefined) ?? STORY_ORG_SCOPE.ALL;
  return {
    allowExternalSources: orgScope === STORY_ORG_SCOPE.ALL,
    scopedOrgId:
      orgScope !== STORY_ORG_SCOPE.ALL
        ? getTabDataString(tab, "orgId")
        : undefined,
  };
}
