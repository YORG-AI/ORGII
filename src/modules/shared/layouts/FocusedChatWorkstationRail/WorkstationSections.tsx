/**
 * WorkstationSections — renders the rail's section list in both the wide
 * (trail) and compact (dropdown menu) presentations.
 */
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  FolderClosedIcon,
  FolderKanbanIcon,
  GitForkIcon,
  HugeiconsIcon,
  WorkflowCircle05Icon,
} from "@src/icons";

import { EnvironmentKindRow } from "./EnvironmentKindRow";
import { OwnerIdentityRow } from "./OwnerIdentityRow";
import { WorkspaceContextRow } from "./WorkspaceContextRow";
import { WorkstationItemRow } from "./WorkstationItemRow";
import type { WorkstationSectionsProps } from "./types";

export function WorkstationSections({
  collapseGroupLabel,
  collapsedGroupKeys,
  compact = false,
  expandGroupLabel,
  onRequestClose,
  onToggleGroup,
  sections,
}: WorkstationSectionsProps) {
  return (
    <div
      className={compact ? "space-y-2" : WORKSTATION_TRAIL_CONTENT.sectionList}
      role={compact ? "menu" : undefined}
    >
      {sections.map((section) => {
        // Every section folds behind its heading, in both presentations.
        const groupCollapsed = collapsedGroupKeys?.has(section.key) === true;

        // In the wide rail, the panel header is also the heading for the first
        // (local-environment) group. Do not leave an empty spacer for its
        // unlabelled section when that group is collapsed.
        if (groupCollapsed && !section.label) return null;

        return (
          <section
            key={section.key}
            className={
              compact ? "space-y-0.5" : WORKSTATION_TRAIL_CONTENT.section
            }
          >
            {section.label &&
              (collapseGroupLabel && expandGroupLabel && onToggleGroup ? (
                // The whole heading row is the fold toggle, with an
                // always-visible chevron right after the label — matching the
                // panel header's own title toggle.
                <button
                  type="button"
                  className="group/section-toggle flex h-6 w-full items-center"
                  data-workstation-group-toggle={section.key}
                  aria-expanded={!groupCollapsed}
                  aria-label={
                    groupCollapsed ? expandGroupLabel : collapseGroupLabel
                  }
                  onClick={() => onToggleGroup(section.key)}
                >
                  <div
                    className={`${WORKSTATION_TRAIL_CONTENT.sectionLabelInline} transition-colors group-hover/section-toggle:text-text-2`}
                  >
                    {section.label}
                  </div>
                  <HugeiconsIcon
                    icon={groupCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                    data-icon={
                      groupCollapsed ? "chevron-right" : "chevron-down"
                    }
                    aria-hidden
                    className="shrink-0 text-text-3 transition-colors group-hover/section-toggle:text-text-2"
                    size={14}
                    strokeWidth={1.75}
                  />
                </button>
              ) : (
                <div className="flex h-6 items-center">
                  <div className={WORKSTATION_TRAIL_CONTENT.sectionLabelInline}>
                    {section.label}
                  </div>
                </div>
              ))}
            {!groupCollapsed &&
              section.environment &&
              (section.environment.repoName ||
                section.environment.branchName ||
                section.environment.worktreeBranchName ||
                section.environment.workItem ||
                section.environment.owner ||
                section.environment.agentHarness) && (
                <>
                  {section.environment.owner && (
                    <OwnerIdentityRow
                      compact={compact}
                      owner={section.environment.owner}
                    />
                  )}
                  {section.environment.environmentKind && (
                    <EnvironmentKindRow
                      compact={compact}
                      kind={section.environment.environmentKind}
                    />
                  )}
                  {section.environment.agentHarness && (
                    <WorkspaceContextRow
                      compact={compact}
                      icon={section.environment.agentHarness.icon}
                      label={section.environment.agentHarness.label}
                      testId="session-environment-agent-harness"
                    />
                  )}
                  {section.environment.repoName && (
                    <WorkspaceContextRow
                      compact={compact}
                      icon={FolderClosedIcon}
                      label={section.environment.repoName}
                    />
                  )}
                  {section.environment.branchName && (
                    <WorkspaceContextRow
                      compact={compact}
                      icon={WorkflowCircle05Icon}
                      label={section.environment.branchName}
                      active={section.environment.branchAction?.active}
                      chevron={Boolean(section.environment.branchAction)}
                      onClick={section.environment.branchAction?.onClick}
                      onRequestClose={onRequestClose}
                      title={section.environment.branchAction?.label}
                      ariaLabel={section.environment.branchAction?.label}
                    />
                  )}
                  {section.environment.worktreeBranchName && (
                    <WorkspaceContextRow
                      compact={compact}
                      icon={GitForkIcon}
                      label={section.environment.worktreeBranchName}
                      title={section.environment.worktreePath}
                    />
                  )}
                  {section.environment.workItem && (
                    <WorkspaceContextRow
                      compact={compact}
                      icon={FolderKanbanIcon}
                      label={`${section.environment.workItem.label}${
                        section.environment.workItem.statusLabel
                          ? ` · ${section.environment.workItem.statusLabel}`
                          : ""
                      }`}
                      onClick={section.environment.workItem.onClick}
                      onRequestClose={onRequestClose}
                      testId="session-active-work-item-pill"
                    />
                  )}
                </>
              )}
            {!groupCollapsed &&
              section.items.map((item) => (
                <WorkstationItemRow
                  key={item.key}
                  compact={compact}
                  item={item}
                  onRequestClose={onRequestClose}
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}
