/**
 * SkillBlock — compact header card for rust-native `skill` tool events.
 *
 * Rendered when the agent invokes the first-class `skill` tool to load a
 * SKILL.md body. Shows the skill name as a subtitle so the user can see at
 * a glance which skill was loaded without exposing the entire SKILL.md in
 * the chat stream (which is large and model-internal).
 *
 * Routed via FallbackAdapter's isSkillTool() branch. Not a full ChatBlock
 * variant — no Rust-side change needed.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { TOOL_NAMES } from "@src/api/tauri/agent/toolNames";
import { getEventIcon } from "@src/config/toolIcons";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

interface SkillBlockProps {
  /** Skill name from `args.skill`. */
  skillName?: string;
  isLoading?: boolean;
  isFailed?: boolean;
  eventId?: string;
  toolUsage?: ToolUsageMetadata;
}

const SKILL_ICON = getEventIcon(TOOL_NAMES.SKILL);

const SkillBlock: React.FC<SkillBlockProps> = React.memo(
  ({ skillName, isLoading = false, isFailed = false, eventId, toolUsage }) => {
    const { t } = useTranslation("sessions");
    const {
      isHeaderHovered,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
    } = useBlockHeader({ eventId });

    const title = isLoading
      ? t("tools.readFileSkillRunning")
      : isFailed
        ? t("tools.readFileSkillFailed")
        : t("tools.readFileSkillDone");

    return (
      <div
        className={`${getEventBlockContainerClasses(false)} animate-fade-in`}
        data-tool-call-event-id={eventId}
        data-tool-call-name={TOOL_NAMES.SKILL}
      >
        <EventBlockHeader
          isCollapsed
          withHover={false}
          onClick={handleLocate}
          onNavigate={handleLocate}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
          className={eventId ? "cursor-pointer" : undefined}
          rightContent={
            toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
          }
        >
          <EventBlockHeaderIcon
            icon={SKILL_ICON}
            isCollapsed
            isHeaderHovered={isHeaderHovered}
            hasContent={false}
            revealChevronOnIconHoverOnly={Boolean(eventId)}
            isLoading={isLoading}
            isFailed={isFailed}
          />
          <EventBlockHeaderTitle isLoading={isLoading}>
            {title}
          </EventBlockHeaderTitle>
          {skillName && (
            <EventBlockHeaderSubtitle isLoading={isLoading}>
              {skillName}
            </EventBlockHeaderSubtitle>
          )}
        </EventBlockHeader>
      </div>
    );
  }
);

SkillBlock.displayName = "SkillBlock";

export default SkillBlock;
