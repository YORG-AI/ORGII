import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

import { WorkstationTrailIconButton } from "../blocks/WorkstationTrailSurface";

export const WORKSTATION_TRAIL_ACTION_REVEAL_CLASS =
  "pointer-events-none opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/workstation-trail:pointer-events-auto group-hover/workstation-trail:opacity-100";

export function WorkstationGroupToggle({
  collapseLabel,
  collapsed,
  expandLabel,
  groupKey,
  onToggle,
}: {
  collapseLabel: string;
  collapsed: boolean;
  expandLabel: string;
  groupKey: string;
  onToggle: () => void;
}) {
  return (
    <WorkstationTrailIconButton
      className={WORKSTATION_TRAIL_ACTION_REVEAL_CLASS}
      data-workstation-group-toggle={groupKey}
      onClick={onToggle}
      aria-label={collapsed ? expandLabel : collapseLabel}
      aria-expanded={!collapsed}
    >
      <HugeiconsIcon
        icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
        data-icon={collapsed ? "chevron-right" : "chevron-down"}
        size={14}
        strokeWidth={1.75}
      />
    </WorkstationTrailIconButton>
  );
}
