/**
 * WorkStationStartPage
 *
 * Launchpad shown when the WorkStation tab pool holds only the launcher tab
 * (on app start, and whenever the user closes the last real tab). Lets the
 * user pick what to open — sharing its action list with the unified `+` menu
 * (TabBarPlusMenu) via `useWorkStationLaunchActions` so the two always match.
 *
 * Rendered as a compact quick-action list: label + keyboard hint, no icon.
 */
import { type LucideIcon } from "lucide-react";
import React, { memo, useMemo } from "react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { useActiveRepoRef } from "@src/hooks/git/useActiveRepoRef";
import { useWorkingTreeDiffTotals } from "@src/hooks/git/useWorkingTreeDiffTotals";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/modules/WorkStation/shared/tokens";

import {
  LAUNCHPAD_ACTION_IDS,
  useWorkStationLaunchActions,
} from "../useWorkStationLaunchActions";

interface StartActionRowProps {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  /** Working-tree diff totals shown as a trailing badge (Review row only). */
  additions?: number;
  deletions?: number;
  onClick: () => void;
}

const StartActionRow = memo<StartActionRowProps>(
  ({ icon: Icon, label, shortcut, additions, deletions, onClick }) => {
    const showDiff =
      additions !== undefined &&
      deletions !== undefined &&
      (additions > 0 || deletions > 0);
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${SURFACE_TOKENS.hover} active:bg-fill-3`}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-3" />
          <span className="truncate text-[14px] font-medium text-text-2">
            {label}
          </span>
        </span>
        {showDiff || shortcut ? (
          <span className="flex shrink-0 items-center gap-2">
            {showDiff ? (
              <DiffStatsBadge
                additions={additions}
                deletions={deletions}
                variant="plain"
                size="sm"
                reserveValueWidth={false}
                className="shrink-0"
              />
            ) : null}
            {shortcut ? (
              <KeyboardShortcut
                shortcut={shortcut}
                variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
              />
            ) : null}
          </span>
        ) : null}
      </button>
    );
  }
);
StartActionRow.displayName = "StartActionRow";

export const WorkStationStartPage: React.FC = memo(() => {
  const actions = useWorkStationLaunchActions();
  const { repoId, repoPath } = useActiveRepoRef();
  const { additions, deletions } = useWorkingTreeDiffTotals(repoId, repoPath);

  const visibleActions = useMemo(
    () => actions.filter((action) => LAUNCHPAD_ACTION_IDS.includes(action.id)),
    [actions]
  );

  return (
    <div
      className={`flex h-full w-full items-center justify-center overflow-auto p-8 ${EDITOR_TAB_CANVAS_BG_CLASS}`}
    >
      <div className="w-full max-w-[420px]">
        <div className="flex flex-col gap-0.5">
          {visibleActions.map((action) => (
            <StartActionRow
              key={action.id}
              icon={action.icon}
              label={action.label}
              shortcut={action.shortcut}
              additions={action.id === "sourceControl" ? additions : undefined}
              deletions={action.id === "sourceControl" ? deletions : undefined}
              onClick={action.onClick}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

WorkStationStartPage.displayName = "WorkStationStartPage";

export default WorkStationStartPage;
