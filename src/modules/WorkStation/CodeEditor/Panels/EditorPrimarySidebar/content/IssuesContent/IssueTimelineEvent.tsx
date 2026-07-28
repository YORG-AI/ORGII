import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bell,
  BellOff,
  CheckCircle2,
  CircleDot,
  CopyCheck,
  CopyX,
  Eye,
  Flag,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  Link2,
  Lock,
  MessageSquare,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Rocket,
  ShieldBan,
  SquareKanban,
  Tag as TagIcon,
  Unlink2,
  Unlock,
  UserMinus,
  UserPlus,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type {
  GitHubIssueTimelineItem,
  GitHubIssueTimelineSource,
} from "@src/api/tauri/github";
import Tag from "@src/components/Tag";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import { getLabelColorStyle } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";
import {
  ActivityTimestamp,
  TimelineEventCard,
} from "@src/modules/shared/components/ActivityTimeline";

const EVENT_ICON_PROPS = { size: 13, strokeWidth: 1.8 } as const;

function humanizeEventName(event: string): string {
  return event.replace(/[_-]/g, " ");
}

function getSourceStateClassName(state: string): string {
  if (state === "open") return "text-success-6";
  if (state === "closed") return "text-purple-6";
  return "text-text-3";
}

function TimelineEventIcon({ event }: { event: string }): React.ReactNode {
  switch (event) {
    case "assigned":
      return <UserPlus {...EVENT_ICON_PROPS} />;
    case "unassigned":
      return <UserMinus {...EVENT_ICON_PROPS} />;
    case "labeled":
    case "unlabeled":
      return <TagIcon {...EVENT_ICON_PROPS} />;
    case "milestoned":
    case "demilestoned":
      return <Flag {...EVENT_ICON_PROPS} />;
    case "closed":
      return <CheckCircle2 {...EVENT_ICON_PROPS} />;
    case "reopened":
      return <CircleDot {...EVENT_ICON_PROPS} />;
    case "renamed":
      return <Pencil {...EVENT_ICON_PROPS} />;
    case "locked":
      return <Lock {...EVENT_ICON_PROPS} />;
    case "unlocked":
      return <Unlock {...EVENT_ICON_PROPS} />;
    case "cross-referenced":
      return <GitPullRequest {...EVENT_ICON_PROPS} />;
    case "referenced":
      return <GitCommitHorizontal {...EVENT_ICON_PROPS} />;
    case "connected":
      return <Link2 {...EVENT_ICON_PROPS} />;
    case "disconnected":
      return <Unlink2 {...EVENT_ICON_PROPS} />;
    case "pinned":
      return <Pin {...EVENT_ICON_PROPS} />;
    case "unpinned":
      return <PinOff {...EVENT_ICON_PROPS} />;
    case "mentioned":
    case "commented":
      return <MessageSquare {...EVENT_ICON_PROPS} />;
    case "marked_as_duplicate":
      return <CopyCheck {...EVENT_ICON_PROPS} />;
    case "unmarked_as_duplicate":
      return <CopyX {...EVENT_ICON_PROPS} />;
    case "transferred":
      return <ArrowRightLeft {...EVENT_ICON_PROPS} />;
    case "converted_to_discussion":
      return <MessagesSquare {...EVENT_ICON_PROPS} />;
    case "subscribed":
      return <Bell {...EVENT_ICON_PROPS} />;
    case "unsubscribed":
      return <BellOff {...EVENT_ICON_PROPS} />;
    case "added_to_project":
    case "moved_columns_in_project":
    case "removed_from_project":
      return <SquareKanban {...EVENT_ICON_PROPS} />;
    case "archived":
      return <Archive {...EVENT_ICON_PROPS} />;
    case "unarchived":
      return <ArchiveRestore {...EVENT_ICON_PROPS} />;
    case "merged":
      return <GitMerge {...EVENT_ICON_PROPS} />;
    case "committed":
      return <GitCommitHorizontal {...EVENT_ICON_PROPS} />;
    case "head_ref_deleted":
    case "head_ref_restored":
    case "head_ref_force_pushed":
      return <GitBranch {...EVENT_ICON_PROPS} />;
    case "base_ref_changed":
    case "automatic_base_change_failed":
    case "automatic_base_change_succeeded":
      return <GitCompareArrows {...EVENT_ICON_PROPS} />;
    case "deployed":
    case "deployment_environment_changed":
      return <Rocket {...EVENT_ICON_PROPS} />;
    case "ready_for_review":
    case "review_requested":
    case "review_request_removed":
    case "reviewed":
    case "review_dismissed":
      return <Eye {...EVENT_ICON_PROPS} />;
    case "user_blocked":
      return <ShieldBan {...EVENT_ICON_PROPS} />;
    default:
      return <Activity {...EVENT_ICON_PROPS} />;
  }
}

function TimelineUser({ login }: { login: string }): React.ReactNode {
  return (
    <span className="whitespace-nowrap font-medium text-text-1">{login}</span>
  );
}

function CrossReferenceLink({
  source,
}: {
  source: GitHubIssueTimelineSource;
}): React.ReactNode {
  return (
    <a
      href={source.html_url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden align-bottom font-medium text-primary-6 hover:underline"
      title={source.title}
    >
      {source.is_pull_request ? (
        <GitPullRequest
          size={12}
          strokeWidth={1.8}
          className={`shrink-0 ${getSourceStateClassName(source.state)}`}
        />
      ) : (
        <CircleDot
          size={12}
          strokeWidth={1.8}
          className={`shrink-0 ${getSourceStateClassName(source.state)}`}
        />
      )}
      <span className="shrink-0">#{source.number}</span>
      <span className="min-w-0 truncate">{source.title}</span>
    </a>
  );
}

export function IssueTimelineEventDescription({
  item,
}: {
  item: GitHubIssueTimelineItem;
}): React.ReactNode {
  const { t } = useTranslation("common");

  switch (item.event) {
    case "assigned":
      return item.assignee ? (
        <>
          {t("git.issues.activity.assigned", "assigned")}{" "}
          <TimelineUser login={item.assignee.login} />
        </>
      ) : (
        <>{t("git.issues.activity.assignedIssue", "assigned this issue")}</>
      );
    case "unassigned":
      return item.assignee ? (
        <>
          {t("git.issues.activity.unassigned", "unassigned")}{" "}
          <TimelineUser login={item.assignee.login} />
        </>
      ) : (
        <>{t("git.issues.activity.removedAssignee", "removed an assignee")}</>
      );
    case "labeled":
    case "unlabeled":
      return (
        <>
          {item.event === "labeled"
            ? t("git.issues.activity.added", "added")
            : t("git.issues.activity.removed", "removed")}{" "}
          {item.label ? (
            <Tag
              size="mini"
              pill
              className={`${TYPOGRAPHY.badge} !px-2 !py-[2px] !leading-tight`}
              style={getLabelColorStyle(item.label.color)}
            >
              {item.label.name}
            </Tag>
          ) : (
            t("git.issues.activity.label", "a label")
          )}
        </>
      );
    case "milestoned":
      return (
        <>
          {t("git.issues.activity.milestoned", {
            milestone: item.milestone ?? "",
            defaultValue: "added this issue to milestone {{milestone}}",
          })}
        </>
      );
    case "demilestoned":
      return (
        <>
          {t("git.issues.activity.demilestoned", {
            milestone: item.milestone ?? "",
            defaultValue: "removed this issue from milestone {{milestone}}",
          })}
        </>
      );
    case "closed":
      return item.commit_id ? (
        <>
          {t("git.issues.activity.closedViaCommit", {
            commit: item.commit_id.slice(0, 7),
            defaultValue: "closed this issue via commit {{commit}}",
          })}
        </>
      ) : (
        <>{t("git.issues.activity.closed", "closed this issue")}</>
      );
    case "reopened":
      return <>{t("git.issues.activity.reopened", "reopened this issue")}</>;
    case "renamed":
      return item.rename ? (
        <>
          {t("git.issues.activity.renamedTo", "renamed this issue to")}{" "}
          <q>{item.rename.to}</q>
        </>
      ) : (
        <>{t("git.issues.activity.renamed", "renamed this issue")}</>
      );
    case "locked":
      return item.lock_reason ? (
        <>
          {t("git.issues.activity.lockedAs", {
            reason: item.lock_reason,
            defaultValue: "locked this conversation as {{reason}}",
          })}
        </>
      ) : (
        <>{t("git.issues.activity.locked", "locked this conversation")}</>
      );
    case "unlocked":
      return (
        <>{t("git.issues.activity.unlocked", "unlocked this conversation")}</>
      );
    case "cross-referenced":
      return item.source ? (
        <>
          {t(
            "git.issues.activity.crossReferencedFrom",
            "referenced this issue from"
          )}{" "}
          <CrossReferenceLink source={item.source} />
        </>
      ) : (
        <>
          {t(
            "git.issues.activity.crossReferenced",
            "cross-referenced this issue"
          )}
        </>
      );
    case "referenced":
      return item.commit_id ? (
        <>
          {t("git.issues.activity.referencedInCommit", {
            commit: item.commit_id.slice(0, 7),
            defaultValue: "referenced this issue in commit {{commit}}",
          })}
        </>
      ) : (
        <>
          {t(
            "git.issues.activity.referencedInACommit",
            "referenced this issue in a commit"
          )}
        </>
      );
    case "connected":
      return <>{t("git.issues.activity.connected", "linked this issue")}</>;
    case "disconnected":
      return (
        <>{t("git.issues.activity.disconnected", "unlinked this issue")}</>
      );
    case "marked_as_duplicate":
      return (
        <>
          {t(
            "git.issues.activity.markedAsDuplicate",
            "marked this issue as a duplicate"
          )}
        </>
      );
    case "unmarked_as_duplicate":
      return (
        <>
          {t(
            "git.issues.activity.unmarkedAsDuplicate",
            "removed the duplicate marking"
          )}
        </>
      );
    case "pinned":
      return <>{t("git.issues.activity.pinned", "pinned this issue")}</>;
    case "unpinned":
      return <>{t("git.issues.activity.unpinned", "unpinned this issue")}</>;
    case "transferred":
      return (
        <>{t("git.issues.activity.transferred", "transferred this issue")}</>
      );
    case "converted_to_discussion":
      return (
        <>
          {t(
            "git.issues.activity.convertedToDiscussion",
            "converted this issue to a discussion"
          )}
        </>
      );
    case "mentioned":
      return <>{t("git.issues.activity.mentioned", "mentioned this issue")}</>;
    default:
      return <>{humanizeEventName(item.event)}</>;
  }
}

export function IssueTimelineEventRow({
  item,
}: {
  item: GitHubIssueTimelineItem;
}): React.ReactNode {
  const actorName = item.actor?.login ?? "GitHub";

  return (
    <TimelineEventCard icon={<TimelineEventIcon event={item.event} />}>
      <>
        <span className="font-medium text-text-1">{actorName}</span>{" "}
        <IssueTimelineEventDescription item={item} />
        {item.created_at ? (
          <>
            <span className="mx-1">·</span>
            <ActivityTimestamp timestamp={item.created_at} />
          </>
        ) : null}
      </>
    </TimelineEventCard>
  );
}
