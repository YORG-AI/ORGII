/**
 * ReadFileBlock — header-only chat rendering for `read_file` events.
 *
 * The file contents are available in the simulator; the chat timeline only
 * shows the read action and target file name. Failed reads keep the same
 * compact row shape as attempted edits instead of rendering a separate red
 * error row.
 */
import React, { useMemo } from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { getToolIcon } from "@src/config/toolIcons";
import { extractFileData } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import {
  statusToLifecycle,
  useToolLabelText,
} from "@src/engines/SessionCore/rendering/registry";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { Briefcase01Icon, HugeiconsIcon } from "@src/icons";
import { getFileName } from "@src/util/file/pathUtils";
import { extractSkillNameFromPath } from "@src/util/skills/skillPath";

import EventFileHoverPreview from "../EventFileHoverPreview";
import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  EVENT_LOADING_SHIMMER_TEXT_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

type ReadFileBlockProps = UniversalEventProps & {
  title?: string;
};

export const ReadFileBlock: React.FC<ReadFileBlockProps> = (props) => {
  const { eventId, status } = props;

  const { filePath, fileName, lineCount, startLine } = useMemo(
    () => extractFileData(props),
    [props]
  );

  const lineRange =
    startLine !== undefined && lineCount !== undefined
      ? `${startLine}-${startLine + lineCount - 1}`
      : undefined;
  const baseName = fileName || getFileName(filePath) || "file";
  const skillName = useMemo(
    () => extractSkillNameFromPath(filePath),
    [filePath]
  );
  const isSkill = Boolean(skillName);
  const displayName = skillName || baseName;
  const iconName = baseName;
  const isLoading =
    status === "running" && props.showActiveEventPainting === true;
  const isFailed = status === "failed";
  const skillLabelState =
    status === "running"
      ? "skill_running"
      : isFailed
        ? "skill_failed"
        : "skill_done";
  const fileTitle = useToolLabelText("read_file", statusToLifecycle(status));
  const skillTitle = useToolLabelText("read_file", skillLabelState);
  const title = isSkill ? skillTitle : fileTitle;

  const {
    isHeaderHovered,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
    handleLocate,
  } = useBlockHeader({ eventId });

  const toolIcon = useMemo(
    () =>
      isSkill ? (
        <HugeiconsIcon
          icon={Briefcase01Icon}
          data-icon="briefcase"
          size={SESSION_UI_TOKENS.ICON.SIZE_SM}
          className="text-text-2"
        />
      ) : (
        getToolIcon("read_file", {
          size: SESSION_UI_TOKENS.ICON.SIZE_SM,
          className: "text-text-2",
        })
      ),
    [isSkill]
  );

  const content = (
    <div className={`${getEventBlockContainerClasses(false)} animate-fade-in`}>
      <EventBlockHeader
        isCollapsed
        withHover={false}
        onClick={handleLocate}
        onNavigate={handleLocate}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
        rightContent={
          props.toolUsage ? (
            <ToolUsageBadge usage={props.toolUsage} />
          ) : undefined
        }
      >
        <EventBlockHeaderIcon
          icon={toolIcon}
          isCollapsed
          isHeaderHovered={isHeaderHovered}
          hasContent={false}
          revealChevronOnIconHoverOnly={Boolean(eventId)}
          isLoading={isLoading}
          isFailed={isFailed}
        />
        <EventBlockHeaderTitle
          isLoading={isLoading}
          className={isFailed ? "text-text-3" : "text-text-1"}
        >
          {title}
        </EventBlockHeaderTitle>
        <EventBlockHeaderSubtitle
          isLoading={isLoading}
          className={isFailed ? "text-text-3" : "text-text-1"}
        >
          {!isSkill && (
            <FileTypeIcon
              fileName={iconName}
              size="small"
              className="mr-1.5 shrink-0"
            />
          )}
          <span
            data-testid="read-file-path"
            className={`min-w-0 truncate ${isLoading ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}` : isFailed ? "text-text-3" : "text-text-1"}`.trim()}
          >
            {displayName}
          </span>
          {lineRange && !isSkill && (
            <span
              data-testid="read-file-line-range"
              className={`ml-2 shrink-0 ${isLoading ? EVENT_LOADING_SHIMMER_TEXT_CLASSES : "text-text-4"}`.trim()}
            >
              {lineRange}
            </span>
          )}
        </EventBlockHeaderSubtitle>
      </EventBlockHeader>
    </div>
  );

  if (isSkill || !filePath) return content;

  return (
    <EventFileHoverPreview path={filePath} repoPath={props.repoPath}>
      {content}
    </EventFileHoverPreview>
  );
};

ReadFileBlock.displayName = "ReadFileBlock";

export default ReadFileBlock;
