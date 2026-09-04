import { useStore } from "jotai";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { getIssueLocal } from "@src/api/tauri/github";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { Placeholder } from "@src/components/Placeholder";
import PrStatusBadge from "@src/components/PrStatusBadge";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  CheckmarkCircle01Icon,
  CircleDotIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
  Link02Icon,
  LinkSquare02Icon,
} from "@src/icons";
import { resolveGitHubIssueRemoteUrl } from "@src/modules/ProjectManager/WorkItems/githubIssueRemote";
import { TimelineLoadingSkeleton } from "@src/modules/shared/components/ActivityTimeline";
import {
  loadGitHubDetailAuthScope,
  loadGitHubIssueMetadata,
} from "@src/modules/shared/githubIssueDetailCoordinator";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import {
  type ExtractedGitHubReference,
  type ResolvedGitHubReference,
  loadGitHubReferences,
} from "./references";

export interface GitHubLinkedReferencesProps {
  references: readonly ExtractedGitHubReference[];
  repoPath?: string | null;
  defaultRepoFullName?: string | null;
  enabled?: boolean;
}

interface LinkedReferenceState {
  key: string;
  items: ResolvedGitHubReference[];
}

function referenceIdentity(references: readonly ExtractedGitHubReference[]) {
  return references
    .map(
      (reference) =>
        `${reference.repoFullName?.toLowerCase() ?? "current"}#${reference.number}:${reference.kind}`
    )
    .join("|");
}

function LinkedReferenceIcon({
  item,
}: {
  item: ResolvedGitHubReference;
}): React.ReactNode {
  const open = item.state === "open";
  if (item.kind === "pr") {
    return (
      <HugeiconsIcon
        icon={open ? GitPullRequestIcon : GitPullRequestClosedIcon}
        data-icon={open ? "git-pull-request" : "git-pull-request-closed"}
        size={15}
        strokeWidth={1.8}
      />
    );
  }
  if (item.kind === "issue") {
    return (
      <HugeiconsIcon
        icon={open ? CircleDotIcon : CheckmarkCircle01Icon}
        data-icon={open ? "circle-dot" : "check-circle-2"}
        size={15}
        strokeWidth={1.8}
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={LinkSquare02Icon}
      data-icon="link-square-02"
      size={15}
      strokeWidth={1.8}
    />
  );
}

function LinkedReferenceStatePill({
  item,
  label,
}: {
  item: ResolvedGitHubReference;
  label: string;
}): React.ReactNode {
  if (item.kind === "pr") {
    return <PrStatusBadge status={item.state ?? "open"} size="xs" showDot />;
  }
  const isOpen = item.state === "open";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${
        isOpen ? "bg-success-1 text-success-6" : "bg-purple-1 text-purple-6"
      }`}
    >
      {label}
    </span>
  );
}

function LinkedReferenceCard({
  item,
  showRepo,
}: {
  item: ResolvedGitHubReference;
  showRepo: boolean;
}): React.ReactNode {
  const { t } = useTranslation("common");
  const typeLabel =
    item.kind === "pr"
      ? t("git.pr.label", "Pull request")
      : item.kind === "issue"
        ? t("git.issues.label", "Issue")
        : t("git.issues.relatedItems.reference", "GitHub reference");
  const stateLabel = item.state
    ? t(`git.issues.status.${item.state}`, item.state)
    : null;
  const metadata = [
    showRepo ? item.repoFullName : null,
    typeLabel,
    !item.state && item.error
      ? t("git.issues.relatedItems.unavailable", "Details unavailable")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      role="listitem"
      className="group min-w-0 overflow-hidden rounded-xl border border-border-1 bg-primary-container transition-colors group-hover:border-border-2"
      data-testid="github-linked-reference-card"
    >
      <Button
        variant="tertiary"
        appearance="ghost"
        size="large"
        long
        disabled={!item.htmlUrl}
        className="h-auto! items-start! justify-start rounded-xl! px-3! py-3! text-left hover:bg-transparent!"
        aria-label={`${typeLabel} #${item.number}: ${item.title}${
          stateLabel ? ` (${stateLabel})` : ""
        }`}
        data-testid="github-linked-reference-row"
        onClick={() => {
          if (item.htmlUrl) void openExternalLink(item.htmlUrl);
        }}
      >
        <span
          className={`mt-0.5 flex size-5 shrink-0 items-center justify-center ${
            item.state === "open" ? "text-success-6" : "text-text-3"
          }`}
          aria-hidden
        >
          <LinkedReferenceIcon item={item} />
        </span>
        <span className="ml-2 flex min-w-0 flex-1 flex-col items-start gap-1">
          <span className="flex max-w-full min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px] leading-5">
            <span className="shrink-0 font-semibold text-text-3 tabular-nums">
              #{item.number}
            </span>
            <span className="min-w-0 font-semibold wrap-break-word text-text-1">
              {item.title}
            </span>
          </span>
          {metadata ? (
            <span className="max-w-full truncate text-[12px] text-text-3">
              {metadata}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 ml-2 flex shrink-0 items-center gap-1.5">
          {stateLabel ? (
            <LinkedReferenceStatePill item={item} label={stateLabel} />
          ) : null}
          {item.htmlUrl ? (
            <HugeiconsIcon
              icon={LinkSquare02Icon}
              data-icon="link-square-02"
              size={13}
              className="text-text-3"
              aria-hidden
            />
          ) : null}
        </span>
      </Button>
    </article>
  );
}

const GitHubLinkedReferences: React.FC<GitHubLinkedReferencesProps> = ({
  references,
  repoPath,
  defaultRepoFullName,
  enabled = true,
}) => {
  const { t } = useTranslation("common");
  const store = useStore();
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [state, setState] = useState<LinkedReferenceState | null>(null);
  const requestRef = useRef<{
    key: string;
    promise: Promise<ResolvedGitHubReference[]>;
  } | null>(null);
  const baseKey = useMemo(
    () =>
      `${referenceIdentity(references)}|${repoPath ?? ""}|${defaultRepoFullName ?? ""}`,
    [defaultRepoFullName, references, repoPath]
  );
  const requestKey = `${baseKey}|${retryGeneration}`;
  const currentState = state?.key === requestKey ? state : null;

  useEffect(() => {
    if (!enabled || references.length === 0) return;
    let active = true;

    let request = requestRef.current;
    if (!request || request.key !== requestKey) {
      let authScope: Promise<string> | null = null;
      const promise = loadGitHubReferences(references, {
        defaultRepoFullName,
        resolveDefaultRepoFullName: repoPath
          ? async () => {
              const remoteUrl = await resolveGitHubIssueRemoteUrl(repoPath);
              return remoteUrl ? parseGithubRepoFullName(remoteUrl) : null;
            }
          : undefined,
        getIssue: async (repoFullName, issueNumber) => {
          authScope ??= loadGitHubDetailAuthScope(store);
          return loadGitHubIssueMetadata(
            store,
            await authScope,
            repoFullName,
            issueNumber,
            () => getIssueLocal(repoFullName, issueNumber)
          );
        },
      });
      request = { key: requestKey, promise };
      requestRef.current = request;
    }

    void request.promise.then((items) => {
      if (active) setState({ key: requestKey, items });
    });

    return () => {
      active = false;
    };
  }, [defaultRepoFullName, enabled, references, repoPath, requestKey, store]);

  const unresolved = currentState?.items.filter((item) => item.error).length;
  const commonRepoFullName = useMemo(() => {
    if (!currentState) return null;
    const repos = new Set(
      currentState.items.map((item) => item.repoFullName).filter(Boolean)
    );
    return repos.size === 1 ? [...repos][0] : null;
  }, [currentState]);

  if (references.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        fillParentHeight
        title={t("git.issues.relatedItems.emptyTitle", "No related items")}
        subtitle={t(
          "git.issues.relatedItems.emptyDescription",
          "GitHub issues and pull requests mentioned in this conversation will appear here."
        )}
      />
    );
  }

  return (
    <div
      className="scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto"
      data-testid="github-linked-references"
    >
      <div
        className={`${DETAIL_PANEL_TOKENS.headerWidth} ${DETAIL_PANEL_TOKENS.threadContentPadding} flex w-full flex-col gap-3`}
      >
        {!currentState ? (
          <TimelineLoadingSkeleton
            label={t(
              "git.issues.relatedItems.loading",
              "Loading related items"
            )}
          />
        ) : (
          <>
            {unresolved ? (
              <InlineAlert
                type="warning"
                role="status"
                dataTestId="github-linked-references-unresolved-alert"
                action={{
                  label: t("actions.retry", "Retry"),
                  onClick: () => setRetryGeneration((current) => current + 1),
                }}
              >
                {t("git.issues.relatedItems.unavailableCount", {
                  count: unresolved,
                  defaultValue: "{{count}} related item could not be resolved",
                  defaultValue_other:
                    "{{count}} related items could not be resolved",
                })}
              </InlineAlert>
            ) : null}
            <section data-testid="github-linked-references-timeline">
              <div className="flex h-5 items-center gap-2 text-[12px] font-medium text-text-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-fill-2 text-text-2">
                  <HugeiconsIcon
                    icon={Link02Icon}
                    data-icon="link-2"
                    size={13}
                    strokeWidth={1.8}
                    aria-hidden
                  />
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0">
                    {t("git.issues.relatedItems.count", {
                      count: currentState.items.length,
                      defaultValue: "{{count}} related item",
                      defaultValue_other: "{{count}} related items",
                    })}
                  </span>
                  {commonRepoFullName ? (
                    <span
                      className="min-w-0 truncate font-normal text-text-3"
                      title={commonRepoFullName}
                    >
                      · {commonRepoFullName}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="relative mt-2 ml-2.5 border-l border-border-1 pl-5">
                <div role="list" className="flex min-w-0 flex-col gap-2">
                  {currentState.items.map((item) => (
                    <LinkedReferenceCard
                      key={`${item.repoFullName ?? "current"}#${item.number}`}
                      item={item}
                      showRepo={!commonRepoFullName}
                    />
                  ))}
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
};

export default GitHubLinkedReferences;
