import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import ModelIcon from "@src/components/ModelIcon";
import { useCloudOrgRemoteSessions } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useCloudSessionActions } from "@src/features/Org2Cloud/useCloudSessionActions";
import { useOpenCloudBilling } from "@src/features/Org2Cloud/useOpenCloudBilling";
import {
  Placeholder,
  SessionTable,
  type SessionTableColumnKey,
  type SessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import { toIntlLocaleTag } from "@src/util/data/formatters/date";

import { toCloudSessionTableItem } from "./cloudSessionTableItem";

const CLOUD_SESSION_COLUMN_VISIBILITY: Partial<
  Record<SessionTableColumnKey, boolean>
> = {
  owner: true,
  impact: false,
  filesChanged: false,
  relatedCommits: false,
  committedRate: false,
  tokens: false,
  started: false,
};

interface CloudSessionsSectionProps {
  orgId: string;
}

export function CloudSessionsSection({ orgId }: CloudSessionsSectionProps) {
  const { t, i18n } = useTranslation(["navigation", "common"]);
  const { rows, state, refresh } = useCloudOrgRemoteSessions(orgId);
  const {
    replaySession,
    forkSession,
    busySessionRowId,
    retentionExpiredRowId,
  } = useCloudSessionActions(orgId);
  const openCloudBillingPage = useOpenCloudBilling();

  const visibleSessions = useMemo(
    () => rows.filter((session) => !session.deletedAt),
    [rows]
  );
  const dateTimeOptions = useMemo(
    () => ({
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.resolvedLanguage),
    }),
    [i18n.resolvedLanguage, t]
  );
  const tableItems = useMemo<SessionTableItem[]>(
    () =>
      visibleSessions.map((session) => {
        const item = toCloudSessionTableItem(
          session,
          {
            fullReplay: t("navigation:cloud.syncLevel.modeFullReplay"),
            metadataOnly: t("navigation:cloud.syncLevel.modeMetadata"),
            notPublished: t("navigation:cloud.sidebar.notPublished"),
          },
          dateTimeOptions
        );
        const replayable = session.eventsEpoch !== undefined;
        return {
          ...item,
          agentIcon: session.cliAgentType ? (
            <ModelIcon agentType={session.cliAgentType} size={14} />
          ) : undefined,
          modelIcon: session.model ? (
            <ModelIcon
              modelName={session.model}
              agentType={session.cliAgentType}
              size={14}
            />
          ) : undefined,
          rowAction: replayable ? (
            <Button
              htmlType="button"
              size="small"
              variant="secondary"
              disabled={Boolean(busySessionRowId)}
              loading={busySessionRowId === session.id}
              data-testid={`cloud-org-session-fork-${session.sourceSessionId}`}
              onClick={() => void forkSession(session)}
            >
              {t("navigation:cloud.orgPanel.fork")}
            </Button>
          ) : undefined,
        };
      }),
    [busySessionRowId, dateTimeOptions, forkSession, t, visibleSessions]
  );

  const handleSelectSession = useCallback(
    (item: SessionTableItem) => {
      const session = visibleSessions.find(
        (candidate) => candidate.id === item.id
      );
      if (!session || busySessionRowId) return;
      void replaySession(session);
    },
    [busySessionRowId, replaySession, visibleSessions]
  );

  if (state === "idle" || state === "loading") {
    return (
      <Placeholder
        variant="loading"
        title={t("navigation:cloud.orgPanel.loading")}
      />
    );
  }

  if (state === "error") {
    return (
      <Placeholder
        variant="error"
        title={t("navigation:cloud.orgPanel.sessionsLoadError")}
        action={{
          label: t("common:actions.refresh"),
          onClick: refresh,
          dataTestId: "cloud-org-sessions-retry",
        }}
      />
    );
  }

  if (visibleSessions.length === 0) {
    return (
      <Placeholder
        variant="empty"
        title={t("navigation:cloud.orgPanel.sessionsEmpty")}
        action={{
          label: t("common:actions.refresh"),
          onClick: refresh,
          dataTestId: "cloud-org-sessions-refresh-empty",
        }}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col gap-3"
      data-testid="cloud-org-sessions"
    >
      <SessionTable
        items={tableItems}
        onSelect={handleSelectSession}
        showSearch
        pageSize={25}
        pageSizeOptions={[10, 25, 50]}
        columnVisibility={CLOUD_SESSION_COLUMN_VISIBILITY}
        rootClassName="w-full"
      />
      {retentionExpiredRowId ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-1 px-3 py-2 text-[12px] text-warning-6"
          data-testid="cloud-session-retention-upgrade"
        >
          <span>{t("navigation:cloud.orgPanel.retentionUpgrade")}</span>
          <Button
            htmlType="button"
            size="small"
            variant="secondary"
            onClick={openCloudBillingPage}
          >
            {t("navigation:cloud.orgPanel.upgrade")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default CloudSessionsSection;
