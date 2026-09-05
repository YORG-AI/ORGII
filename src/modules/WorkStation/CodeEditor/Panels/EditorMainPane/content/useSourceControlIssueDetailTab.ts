import { useCallback } from "react";

import { useTabViewState } from "@src/hooks/tabHost/useTabViewState";
import type { ThreadDetailTab } from "@src/modules/shared/components/ThreadDetailTabs";

interface IssueDetailTabSelection {
  issueUrl: string;
  activeTab: ThreadDetailTab;
}

/**
 * Sub-tab (Conversation / Linked …) of an issue shown inside the Source
 * Control tab. Kept in the owning tab's view state so it survives the pane
 * being unmounted on a tab switch, and scoped to the issue URL so selecting
 * a different issue starts back on Conversation, as the panel's own local
 * state did.
 */
export function useSourceControlIssueDetailTab(
  viewStateKey: string | undefined,
  issueUrl: string | undefined
): [ThreadDetailTab, (next: ThreadDetailTab) => void] {
  const [selection, setSelection] =
    useTabViewState<IssueDetailTabSelection | null>(
      viewStateKey ?? "",
      "issueDetailTab",
      null
    );
  const activeTab: ThreadDetailTab =
    selection && issueUrl && selection.issueUrl === issueUrl
      ? selection.activeTab
      : "conversation";
  const setActiveTab = useCallback(
    (next: ThreadDetailTab) => {
      if (!issueUrl) return;
      setSelection({ issueUrl, activeTab: next });
    },
    [issueUrl, setSelection]
  );
  return [activeTab, setActiveTab];
}
