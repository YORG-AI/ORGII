import {
  CheckCircle2,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Link2,
  MessageSquare,
  MoreHorizontal,
} from "lucide-react";
import { useCallback, useState } from "react";

import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { getPrStatusVariant } from "@src/shared/pr/prStatus";

import { GitHubWorkItemRow } from "./GitHubWorkItemList";
import {
  type ManagedIssueItem,
  type ManagedIssueLabel,
  type ManagedPrItem,
} from "./githubManagedItemModel";
import { GITHUB_QUERY_STATE } from "./githubWorkItemsSearchQuery";

function getLabelTextColor(color: string): string {
  const normalized = color.replace("#", "");
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 140
    ? "#24292f"
    : "#ffffff";
}

function IssueLabelTag({ label }: { label: ManagedIssueLabel }) {
  const backgroundColor = `#${label.color.replace("#", "")}`;
  return (
    <span
      className="inline-flex h-5 items-center rounded-full px-[7px] text-[11px] font-semibold leading-none"
      style={{ backgroundColor, color: getLabelTextColor(backgroundColor) }}
    >
      {label.name}
    </span>
  );
}

export function ManagedIssueRow({
  issue,
  addLabel,
  openInBrowserLabel,
  openInMyStationLabel,
  moreActionsLabel,
  onOpenIssue,
  onOpenIssueInBrowser,
  onOpenIssueInMyStation,
  onAddIssue,
}: {
  issue: ManagedIssueItem;
  addLabel: string;
  openInBrowserLabel: string;
  openInMyStationLabel: string;
  moreActionsLabel: string;
  onOpenIssue: (issue: ManagedIssueItem) => void;
  onOpenIssueInBrowser: (issue: ManagedIssueItem) => void;
  onOpenIssueInMyStation: (issue: ManagedIssueItem) => void;
  onAddIssue: (issue: ManagedIssueItem) => void;
}) {
  const [menuVisible, setMenuVisible] = useState(false);
  const closeMenu = useCallback(() => setMenuVisible(false), []);
  const droplist = (
    <div className={`${DROPDOWN_CLASSES.menuPanelBase} min-w-[180px]`}>
      <button
        type="button"
        className={DROPDOWN_CLASSES.menuActionItem}
        onClick={() => {
          onOpenIssueInBrowser(issue);
          closeMenu();
        }}
      >
        <span className="min-w-0 flex-1 truncate">{openInBrowserLabel}</span>
      </button>
      <button
        type="button"
        className={DROPDOWN_CLASSES.menuActionItem}
        onClick={() => {
          onOpenIssueInMyStation(issue);
          closeMenu();
        }}
      >
        <span className="min-w-0 flex-1 truncate">{openInMyStationLabel}</span>
      </button>
    </div>
  );
  return (
    <GitHubWorkItemRow
      icon={
        <span
          className={
            issue.state === "closed" ? "text-purple-6" : "text-success-6"
          }
        >
          {issue.state === "closed" ? (
            <CheckCircle2 size={14} strokeWidth={1.8} />
          ) : (
            <CircleDot size={14} strokeWidth={1.8} />
          )}
        </span>
      }
      content={
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus-visible:outline-none"
          onClick={() => onOpenIssue(issue)}
          aria-label={`Open issue #${issue.id}: ${issue.title}`}
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h3 className="m-0 min-w-0 text-[13px] font-semibold leading-5 text-text-1 group-hover:text-primary-6">
              {issue.title}
            </h3>
            {issue.labels.map((label) => (
              <IssueLabelTag key={label.name} label={label} />
            ))}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-3">
            <span>#{issue.id}</span>
            <span>·</span>
            <span>{issue.repo}</span>
            <span>·</span>
            <span>{issue.author}</span>
            <span>·</span>
            <span>{issue.timeAgo}</span>
          </div>
        </button>
      }
      trailing={
        <>
          {issue.comments > 0 ? (
            <span className="mt-1 flex shrink-0 items-center gap-1 text-[11px] text-text-3">
              <MessageSquare size={12} strokeWidth={1.8} />
              {issue.comments}
            </span>
          ) : null}
          <img
            src={issue.rawIssue.user.avatar_url}
            alt=""
            title={issue.author}
            className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-fill-2 object-cover"
          />
        </>
      }
      actions={
        <>
          <Button
            htmlType="button"
            variant="tertiary"
            appearance="ghost"
            size="mini"
            icon={<Link2 size={12} />}
            className="mt-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onAddIssue(issue);
            }}
            aria-label={`Add issue #${issue.id} to chat`}
          >
            {addLabel}
          </Button>
          <span onClick={(event) => event.stopPropagation()}>
            <Dropdown
              droplist={droplist}
              trigger="click"
              position="bottom-end"
              popupVisible={menuVisible}
              onVisibleChange={setMenuVisible}
            >
              <Button
                htmlType="button"
                variant="tertiary"
                appearance="ghost"
                size="mini"
                icon={<MoreHorizontal size={13} />}
                iconOnly
                className="mt-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={moreActionsLabel}
                aria-expanded={menuVisible}
              />
            </Dropdown>
          </span>
        </>
      }
    />
  );
}

export function ManagedPrRow({
  pr,
  addLabel,
  onOpenPr,
  onAddPr,
}: {
  pr: ManagedPrItem;
  addLabel: string;
  onOpenPr: (pr: ManagedPrItem) => void;
  onAddPr: (pr: ManagedPrItem) => void;
}) {
  const statusVariant = getPrStatusVariant(pr.state);
  const PrIcon =
    pr.state === GITHUB_QUERY_STATE.MERGED
      ? GitMerge
      : pr.state === GITHUB_QUERY_STATE.CLOSED
        ? GitPullRequestClosed
        : GitPullRequest;
  return (
    <GitHubWorkItemRow
      icon={
        <span className={statusVariant.dotClass.replace("bg-", "text-")}>
          <PrIcon size={14} strokeWidth={1.8} />
        </span>
      }
      content={
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus-visible:outline-none"
          onClick={() => onOpenPr(pr)}
          aria-label={`Open pull request #${pr.id}: ${pr.title}`}
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h3 className="m-0 min-w-0 text-[13px] font-semibold leading-5 text-text-1 group-hover:text-primary-6">
              {pr.title}
            </h3>
            {pr.rawPr.draft ? (
              <span className="rounded-full border border-border-2 bg-fill-1 px-1.5 py-0.5 text-[10px] font-medium text-text-2">
                Draft
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-3">
            <span>#{pr.id}</span>
            <span>·</span>
            <span>{pr.repo}</span>
            <span>·</span>
            <span>{pr.sourceBranch}</span>
            <span>→</span>
            <span>{pr.targetBranch}</span>
            <span>·</span>
            <span>{pr.timeAgo}</span>
          </div>
        </button>
      }
      actions={
        <Button
          htmlType="button"
          variant="tertiary"
          appearance="ghost"
          size="mini"
          icon={<Link2 size={12} />}
          className="mt-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => onAddPr(pr)}
          aria-label={`Add pull request #${pr.id} to chat`}
        >
          {addLabel}
        </Button>
      }
    />
  );
}
