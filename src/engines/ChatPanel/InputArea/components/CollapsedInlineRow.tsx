/**
 * CollapsedInlineRow
 *
 * Horizontal row of pill-shaped buttons — one per active ComposerStack section
 * (queue, processes, file changes). Always visible when any section has data.
 * Clicking a pill expands that section's card above.
 *
 * Also renders contextual action pills immediately after the section pills.
 *
 * Each pill shows icon + numeric count only. gap-1 between pills.
 */
import { Plus } from "lucide-react";
import React, { memo, useState } from "react";

import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";

import type { ScrollNavState } from "../../ChatHistory";

export interface InlineSection {
  key: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  onExpand: () => void;
  /** When set, renders this text instead of the numeric count. */
  label?: string;
  /** "primary" renders in primary-6 — used for question/permission/modeswitch pills */
  variant?: "default" | "primary";
  /** When true, only the icon is shown (no count or label). */
  iconOnly?: boolean;
  /** Optional custom content rendered after the leading icon. */
  content?: React.ReactNode;
  /**
   * When set, clicking the pill opens this dropdown menu (anchored to the
   * pill) instead of invoking `onExpand`. The host injects an `onClose`
   * prop into the element so menu items can dismiss the dropdown.
   */
  droplist?: React.ReactNode;
  /** Stable selector for rendered UI E2E coverage. */
  testId?: string;
}

export interface CollapsedInlineRowProps {
  sections: InlineSection[];
  scrollNav?: ScrollNavState | null;
}

function renderSectionContent(section: InlineSection) {
  if (section.iconOnly) return null;
  if (section.content) return section.content;
  return section.label ?? section.count;
}

function getButtonClassName(section: InlineSection) {
  const activeClassName = section.active ? "!bg-fill-1 !text-primary-6" : "";
  const primaryClassName =
    section.variant === "primary" ? "!border-primary-5 !text-primary-6" : "";
  return `${activeClassName} ${primaryClassName}`.trim();
}

const CollapsedInlineRow: React.FC<CollapsedInlineRowProps> = memo(
  ({ sections, scrollNav }) => {
    const showFollowAgent = scrollNav?.showFollowAgent ?? false;
    const showAddToConversation = scrollNav?.showAddToConversation ?? false;
    const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);

    if (sections.length === 0 && !showFollowAgent && !showAddToConversation)
      return null;

    return (
      <div className="flex items-center gap-1 px-0.5">
        {sections.map((section) => {
          const button = (
            <Button
              key={section.key}
              variant="secondary"
              appearance="outline"
              size="small"
              shape="round"
              icon={section.icon}
              iconOnly={section.iconOnly}
              onClick={section.onExpand}
              data-testid={section.testId}
              className={getButtonClassName(section)}
            >
              {renderSectionContent(section)}
            </Button>
          );

          if (!section.droplist) return button;

          const isOpen = openMenuKey === section.key;
          const droplist = React.isValidElement(section.droplist)
            ? React.cloneElement(
                section.droplist as React.ReactElement<{
                  onClose?: () => void;
                }>,
                { onClose: () => setOpenMenuKey(null) }
              )
            : section.droplist;

          return (
            <Dropdown
              key={section.key}
              trigger="click"
              position="top"
              avoidViewportOverflow
              getPopupContainer={() => document.body}
              droplist={droplist}
              popupVisible={isOpen}
              onVisibleChange={(visible) =>
                setOpenMenuKey(visible ? section.key : null)
              }
            >
              {button}
            </Dropdown>
          );
        })}

        {showFollowAgent && (
          <Tooltip
            content={
              <KeyboardShortcutTooltipContent
                label={scrollNav!.followAgentTooltipLabel}
                shortcut={scrollNav!.followAgentShortcut || undefined}
              />
            }
            position="top"
            mouseEnterDelay={250}
            framedPanel
          >
            <span className="inline-flex">
              <Button
                variant="secondary"
                appearance="outline"
                size="small"
                shape="round"
                onClick={scrollNav!.onFollowAgent}
                aria-label={scrollNav!.followAgentTooltipLabel}
              >
                {scrollNav!.followAgentLabel}
              </Button>
            </span>
          </Tooltip>
        )}

        {showAddToConversation && (
          <Tooltip
            content={
              <KeyboardShortcutTooltipContent
                label={scrollNav!.addToConversationTooltipLabel}
              />
            }
            position="top"
            mouseEnterDelay={250}
            framedPanel
          >
            <span className="inline-flex">
              <Button
                variant="primary"
                appearance="outline"
                size="small"
                shape="round"
                icon={<Plus size={13} strokeWidth={2} />}
                onClick={scrollNav!.onAddToConversation}
                aria-label={scrollNav!.addToConversationTooltipLabel}
                data-testid="browser-add-to-conversation-pill"
                className="max-w-[190px]"
              >
                {scrollNav!.addToConversationLabel}
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
    );
  }
);

CollapsedInlineRow.displayName = "CollapsedInlineRow";

export default CollapsedInlineRow;
