/** Hover-card presentation owned by the WorkStation issues panel. */
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubIssue } from "@src/api/tauri/github";
import HoverCardBase, {
  HoverCardPanel,
  type HoverCardPosition,
  HoverCardRow,
} from "@src/components/SessionHoverCard/HoverCardBase";
import { HoverCardUrlRow } from "@src/components/SessionHoverCard/HoverCardUrlRow";
import { formatHoverCardTimeAgo } from "@src/components/SessionHoverCard/hoverCardTime";
import Tag from "@src/components/Tag";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import {
  CancelCircleIcon,
  CircleDotIcon,
  Clock01Icon,
  HugeiconsIcon,
  Message01Icon,
  TagsIcon,
  UserIcon,
} from "@src/icons";
import { getLabelColorStyle } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";

interface IssueHoverCardProps {
  issue?: GitHubIssue | null;
  children: React.ReactElement;
  position?: HoverCardPosition;
  mouseEnterDelay?: number;
  mouseLeaveDelay?: number;
}

interface IssueHoverCardContentProps {
  issue: GitHubIssue;
}

type TranslationFn = ReturnType<typeof useTranslation>["t"];

function formatIssueState(state: string, t: TranslationFn): string {
  return t(`git.issues.status.${state}`, state);
}

const IssueHoverCardContent: React.FC<IssueHoverCardContentProps> = memo(
  ({ issue }) => {
    const { i18n, t } = useTranslation("common");
    const isOpen = issue.state === "open";
    const labelsTitle = issue.labels.map((label) => label.name).join(", ");
    const assigneesTitle = issue.assignees
      .map((assignee) => assignee.login)
      .join(", ");
    const wasUpdated = issue.updated_at !== issue.created_at;

    return (
      <HoverCardPanel title={issue.title}>
        <HoverCardRow
          icon={
            isOpen ? (
              <HugeiconsIcon
                icon={CircleDotIcon}
                data-icon="circle-dot"
                size={13}
                strokeWidth={1.75}
              />
            ) : (
              <HugeiconsIcon
                icon={CancelCircleIcon}
                data-icon="xcircle"
                size={13}
                strokeWidth={1.75}
              />
            )
          }
          iconClassName={isOpen ? "text-success-6" : "text-text-3"}
        >
          <div className="truncate text-text-2">
            <span>{formatIssueState(issue.state, t)}</span>
            <span className="mx-1 text-text-4">·</span>
            <span>#{issue.number}</span>
          </div>
        </HoverCardRow>

        {issue.html_url && <HoverCardUrlRow url={issue.html_url} />}

        <HoverCardRow
          icon={
            <HugeiconsIcon
              icon={UserIcon}
              data-icon="user"
              size={13}
              strokeWidth={1.75}
            />
          }
        >
          <div className="truncate text-text-2">
            <span>{issue.user.login}</span>
            <span className="mx-1 text-text-4">·</span>
            <span className="text-text-3">
              {formatHoverCardTimeAgo(issue.created_at, i18n.language)}
            </span>
          </div>
        </HoverCardRow>

        <HoverCardRow
          icon={
            <HugeiconsIcon
              icon={Clock01Icon}
              data-icon="clock"
              size={13}
              strokeWidth={1.75}
            />
          }
        >
          <div className="truncate text-text-2">
            <span className="text-text-3">
              {wasUpdated
                ? t("git.issues.updated", { defaultValue: "Last updated" })
                : t("git.issues.notUpdated", {
                    defaultValue: "not updated",
                  })}
            </span>
            {wasUpdated && (
              <>
                <span className="mx-1 text-text-4">·</span>
                <span>
                  {formatHoverCardTimeAgo(issue.updated_at, i18n.language)}
                </span>
              </>
            )}
          </div>
        </HoverCardRow>

        {issue.labels.length > 0 && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={TagsIcon}
                data-icon="tags"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div
              className="relative top-[2px] flex min-w-0 flex-wrap items-center gap-1"
              title={labelsTitle}
            >
              {issue.labels.map((label) => (
                <Tag
                  key={label.id}
                  size="mini"
                  pill
                  className={`${TYPOGRAPHY.badge} !px-1.5 !py-[1px] !leading-tight`}
                  style={getLabelColorStyle(label.color)}
                >
                  {label.name}
                </Tag>
              ))}
            </div>
          </HoverCardRow>
        )}

        {issue.assignees.length > 0 && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={UserIcon}
                data-icon="user"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2" title={assigneesTitle}>
              {t("git.issues.assignedTo", {
                defaultValue: "Assigned to {{assignees}}",
                assignees: assigneesTitle,
              })}
            </div>
          </HoverCardRow>
        )}

        {issue.comments > 0 && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={Message01Icon}
                data-icon="message-square"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2">
              {t("git.issues.commentCount", {
                count: issue.comments,
                defaultValue_one: "{{count}} comment",
                defaultValue_other: "{{count}} comments",
              })}
            </div>
          </HoverCardRow>
        )}

        {issue.body && (
          <>
            <div className="my-1 h-px bg-border-2" />
            <p className="line-clamp-4 whitespace-pre-wrap text-[12px] leading-5 text-text-2">
              {issue.body}
            </p>
          </>
        )}
      </HoverCardPanel>
    );
  }
);

IssueHoverCardContent.displayName = "IssueHoverCardContent";

const IssueHoverCard: React.FC<IssueHoverCardProps> = ({
  issue,
  children,
  position = "right-start",
  mouseEnterDelay,
  mouseLeaveDelay,
}) => {
  const renderContent = useCallback(
    () => (issue ? <IssueHoverCardContent issue={issue} /> : null),
    [issue]
  );

  return (
    <HoverCardBase
      cardId={issue ? `github-issue:${issue.number}` : null}
      position={position}
      mouseEnterDelay={mouseEnterDelay}
      mouseLeaveDelay={mouseLeaveDelay}
      renderContent={renderContent}
    >
      {children}
    </HoverCardBase>
  );
};

export default IssueHoverCard;
