/**
 * WorkstationSections — renders the rail's section list in both the wide
 * (trail) and compact (dropdown menu) presentations.
 */
import { Folder, FolderKanban, GitBranch, GitFork } from "lucide-react";

import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";

import { WorkspaceContextRow } from "./WorkspaceContextRow";
import { WorkstationItemRow } from "./WorkstationItemRow";
import type { WorkstationSectionsProps } from "./types";

export function WorkstationSections({
  compact = false,
  onRequestClose,
  sections,
}: WorkstationSectionsProps) {
  return (
    <div
      className={compact ? "space-y-2" : WORKSTATION_TRAIL_CONTENT.sectionList}
      role={compact ? "menu" : undefined}
    >
      {sections.map((section) => (
        <section
          key={section.key}
          className={
            compact ? "space-y-0.5" : WORKSTATION_TRAIL_CONTENT.section
          }
        >
          {section.label && (
            <div className={WORKSTATION_TRAIL_CONTENT.sectionLabel}>
              {section.label}
            </div>
          )}
          {section.environment &&
            (section.environment.repoName ||
              section.environment.branchName ||
              section.environment.worktreeBranchName ||
              section.environment.workItem) && (
              <>
                {section.environment.repoName && (
                  <WorkspaceContextRow
                    compact={compact}
                    icon={Folder}
                    label={section.environment.repoName}
                  />
                )}
                {section.environment.branchName && (
                  <WorkspaceContextRow
                    compact={compact}
                    icon={GitBranch}
                    label={section.environment.branchName}
                  />
                )}
                {section.environment.worktreeBranchName && (
                  <WorkspaceContextRow
                    compact={compact}
                    icon={GitFork}
                    label={section.environment.worktreeBranchName}
                    title={section.environment.worktreePath}
                  />
                )}
                {section.environment.workItem && (
                  <WorkspaceContextRow
                    compact={compact}
                    icon={FolderKanban}
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
          {section.items.map((item) => (
            <WorkstationItemRow
              key={item.key}
              compact={compact}
              item={item}
              onRequestClose={onRequestClose}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
