/**
 * LinkedSessionsList
 *
 * Table of the agent sessions linked to a Work Item, plus the creation
 * session that produced it. Prop-only; no Work Item state is read here.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { WorkItemOriginSession } from "@src/api/http/project";
import { HugeiconsIcon, RotateLeft01Icon } from "@src/icons";
import {
  formatTokensShort,
  formatUsd,
} from "@src/modules/shared/dataSource/usageFormat";
import {
  SessionTable,
  type SessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import type { LinkedSession } from "@src/types/core/workItem";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import { STATUS_I18N_KEYS } from "../AgentWorkflow/types";
import { retryFailedLinkedSession } from "./discussionCommentForward";
import {
  LINKED_SESSION_STATUS_COLOR,
  formatLinkedSessionAgentLabel,
  formatOriginSessionAgentLabel,
  getLinkedSessionTitle,
  renderSessionAgentIcon,
} from "./linkedSessionPresentation";

interface LinkedSessionsListProps {
  sessions: LinkedSession[];
  originSession?: WorkItemOriginSession;
  shortId?: string | null;
  projectSlug?: string | null;
  orgId?: string | null;
  activeAgentSessionId?: string | null;
  onOpenSession?: (sessionId: string) => void;
}

export const LinkedSessionsList: React.FC<LinkedSessionsListProps> = ({
  sessions,
  originSession,
  shortId,
  projectSlug,
  orgId,
  activeAgentSessionId,
  onOpenSession,
}) => {
  const { t, i18n } = useTranslation(["projects", "common"]);
  const dateTimeLabelOptions = useMemo(
    () => ({
      todayLabel: t("common:relativeDate.today"),
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.resolvedLanguage),
    }),
    [i18n.resolvedLanguage, t]
  );
  const tableItems = useMemo<SessionTableItem[]>(() => {
    if (sessions.length === 0 && !originSession) {
      return [
        {
          id: "work-item-linked-sessions-empty",
          title: t("workItems.sessions.emptyOverview"),
          statusLabel: "—",
          disabled: true,
          testId: "work-item-linked-sessions-empty-row",
        },
      ];
    }

    const executionItems = sessions.map((session) => {
      const statusLabelKey = STATUS_I18N_KEYS[session.status];
      const statusLabel = statusLabelKey ? t(statusLabelKey) : session.status;

      return {
        id: session.session_id,
        title: getLinkedSessionTitle(session),
        description:
          session.result_preview &&
          session.result_preview !== session.session_id
            ? session.session_id
            : undefined,
        statusLabel,
        statusColor: LINKED_SESSION_STATUS_COLOR[session.status],
        agentIcon: renderSessionAgentIcon(session.session_type),
        agentLabel: formatLinkedSessionAgentLabel(session),
        modelLabel: session.session_type,
        workspaceLabel: session.parent_session_id,
        workspaceTitle: session.parent_session_id,
        startedLabel: formatReplayDateLabel(session.started_at, {
          ...dateTimeLabelOptions,
          withSeconds: false,
          monthStyle: "short",
        }),
        lastUpdatedLabel: formatReplayDateLabel(
          session.completed_at ?? session.started_at,
          {
            ...dateTimeLabelOptions,
            withSeconds: false,
            monthStyle: "short",
          }
        ),
        tokensLabel:
          session.total_tokens > 0
            ? formatTokensShort(session.total_tokens)
            : undefined,
        tokensValue:
          session.total_tokens > 0 ? session.total_tokens : undefined,
        active: session.session_id === activeAgentSessionId,
        testId: `work-item-linked-session-${session.session_id}`,
        rowAction:
          session.status === "failed" && shortId ? (
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
              onClick={() => {
                retryFailedLinkedSession({
                  projectSlug,
                  orgId,
                  shortId,
                  sessionId: session.session_id,
                });
                onOpenSession?.(session.session_id);
              }}
              aria-label={t("workItems.sessions.retry", {
                defaultValue: "Retry",
              })}
              data-testid={`work-item-session-retry-${session.session_id}`}
            >
              <HugeiconsIcon
                icon={RotateLeft01Icon}
                data-icon="rotate-ccw"
                size={12}
              />
              {t("workItems.sessions.retry", { defaultValue: "Retry" })}
            </button>
          ) : undefined,
      };
    });
    if (
      !originSession ||
      sessions.some(
        (session) => session.session_id === originSession.session_id
      )
    ) {
      return executionItems;
    }
    return [
      {
        id: originSession.session_id,
        title: t("workItems.sessions.originTitle", {
          defaultValue: "Creation session",
        }),
        description: originSession.session_id,
        statusLabel: t("workItems.sessions.originStatus", {
          defaultValue: "Created this item",
        }),
        statusColor: "var(--color-primary-6)",
        agentIcon: renderSessionAgentIcon(
          originSession.session_type,
          originSession.provider
        ),
        agentLabel: formatOriginSessionAgentLabel(originSession.actor_id),
        modelLabel: originSession.session_type,
        startedLabel: formatReplayDateLabel(originSession.captured_at, {
          ...dateTimeLabelOptions,
          withSeconds: false,
          monthStyle: "short",
        }),
        lastUpdatedLabel: formatReplayDateLabel(originSession.captured_at, {
          ...dateTimeLabelOptions,
          withSeconds: false,
          monthStyle: "short",
        }),
        active: originSession.session_id === activeAgentSessionId,
        disabled: originSession.provider !== "org2",
        testId: `work-item-origin-session-${originSession.session_id}`,
      },
      ...executionItems,
    ];
  }, [
    activeAgentSessionId,
    dateTimeLabelOptions,
    onOpenSession,
    originSession,
    orgId,
    projectSlug,
    sessions,
    shortId,
    t,
  ]);

  const totalTokens = sessions.reduce(
    (sum, session) => sum + (session.total_tokens || 0),
    0
  );
  const totalCost = sessions.reduce(
    (sum, session) => sum + (session.cost_usd || 0),
    0
  );

  return (
    <div data-testid="work-item-linked-sessions">
      {sessions.length > 0 && (
        <div
          className="mb-1 flex items-center gap-3 px-1 text-[11px] text-text-4"
          data-testid="work-item-usage-summary"
        >
          <span>
            {t("workItems.sessions.runsCount", {
              defaultValue: "{{count}} runs",
              count: sessions.length,
            })}
          </span>
          {totalTokens > 0 && (
            <span>{formatTokensShort(totalTokens)} tokens</span>
          )}
          {totalCost > 0 && <span>{formatUsd(totalCost, 2)}</span>}
        </div>
      )}
      <SessionTable
        items={tableItems}
        onSelect={(item) => onOpenSession?.(item.id)}
        surfaceVariant="default"
        bodySurface="pane"
        headerBorder={false}
        maxHeight={360}
      />
    </div>
  );
};
