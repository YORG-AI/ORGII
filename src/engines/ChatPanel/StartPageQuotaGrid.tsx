import { RefreshCw } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import ModelIcon from "@src/components/ModelIcon";
import {
  getQuotaBgColorClass,
  getQuotaTextColorClass,
} from "@src/components/QuotaBar";
import { useKeyVault } from "@src/hooks/keyVault";
import {
  type AccountQuotaCard,
  collectAccountQuotaCards,
  formatQuotaResetHint,
} from "@src/hooks/keyVault/accountQuotaDisplay";
import { createLogger } from "@src/hooks/logger";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
} from "@src/modules/shared/layouts/SectionLayout";

const logger = createLogger("StartPageQuotaGrid");

// Quota cards use the standard settings surface (bg-primary-container) rather
// than the translucent trend surface used by the Usage tab.
const START_PAGE_QUOTA_SURFACE_CLASS =
  "rounded-lg border border-border-1 bg-primary-container";

const QUOTA_REFRESH_GAP_MS = 1_000;

function StartPageQuotaCard({
  entry,
}: {
  entry: AccountQuotaCard;
}): React.ReactNode {
  const { t: tIntegrations } = useTranslation("integrations");

  return (
    <div className={`min-w-0 p-2 ${START_PAGE_QUOTA_SURFACE_CLASS}`}>
      <div className="mb-1 flex min-w-0 items-center gap-1.5">
        <ModelIcon agentType={entry.modelType} size="small" />
        <div
          className="min-w-0 flex-1"
          title={
            entry.accountPlan
              ? `${entry.accountName} · ${entry.accountPlan}`
              : entry.accountName
          }
        >
          <div className="truncate text-[11px] font-semibold leading-4 text-text-1">
            {entry.accountName}
          </div>
          <div className="truncate text-[10px] leading-3 text-text-3">
            {entry.accountPlan ?? "-"}
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        {entry.metrics.map((metric) => {
          const textColorClass = getQuotaTextColorClass(
            metric.remainingPercent
          );
          const barBgClass = getQuotaBgColorClass(metric.remainingPercent);
          const resetHint = formatQuotaResetHint(
            metric.key,
            metric.remainingPercent,
            metric.resetTime,
            tIntegrations
          );
          return (
            <div key={metric.key} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2 text-[10px]">
                <span className="min-w-0 truncate text-text-3">
                  {metric.label}
                  {resetHint ? (
                    <span title={resetHint.full}> ({resetHint.compact})</span>
                  ) : null}
                </span>
                <span
                  className={`shrink-0 font-semibold tabular-nums ${textColorClass}`}
                >
                  {tIntegrations("keyVault.quota.percentLeft", {
                    percent: Math.round(metric.remainingPercent),
                  })}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-fill-3">
                <div
                  className={`h-full rounded-full transition-all ${barBgClass}`}
                  style={{ width: `${metric.remainingPercent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface StartPageQuotaGridProps {
  className?: string;
}

export function StartPageQuotaGrid({
  className,
}: StartPageQuotaGridProps): React.ReactNode {
  const { t } = useTranslation("sessions");
  const { t: tIntegrations } = useTranslation("integrations");
  const { accounts, getAccount, refresh, refreshAccount } = useKeyVault({
    autoLoad: true,
  });
  const [refreshing, setRefreshing] = useState(false);

  // The dedicated Quota tab has room to show every account at once.
  const gridClassName = "grid-cols-2";

  const entries = useMemo(
    () => collectAccountQuotaCards(accounts, t, tIntegrations),
    [accounts, t, tIntegrations]
  );

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    let refreshedCount = 0;
    try {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (index > 0) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, QUOTA_REFRESH_GAP_MS);
          });
        }
        try {
          const refreshed = await refreshAccount(entry.id, true);
          if (!refreshed) {
            throw new Error("Usage refresh failed");
          }
          refreshedCount += 1;
        } catch (err) {
          const name = getAccount(entry.id)?.name || entry.accountName;
          const detail = err instanceof Error ? err.message : String(err);
          Message.error(
            tIntegrations("keyVault.toasts.refreshError", {
              name,
              error: detail,
            }),
            5000
          );
          logger.error("[RefreshUsage] Error:", err);
        }
      }
      if (refreshedCount > 0) {
        await refresh();
      }
    } finally {
      setRefreshing(false);
    }
  }, [entries, getAccount, refresh, refreshAccount, tIntegrations]);

  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    handleRefreshAll,
    refreshing
  );

  return (
    <div className={`${SECTION_GAP_CLASSES} ${className ?? ""}`}>
      <div
        className="sticky top-0 z-20 -mx-4 bg-chat-pane px-4 pb-1"
        data-testid="quota-refresh-controls"
      >
        <div className="flex min-h-9 items-center justify-end">
          <Button
            htmlType="button"
            variant="tertiary"
            appearance="ghost"
            size="small"
            disabled={refreshing || entries.length === 0}
            aria-label={t("chat.startPage.quota.refresh")}
            title={t("chat.startPage.quota.refresh")}
            onClick={handleRefreshClick}
            icon={<RefreshCw size={14} className={spinClass} />}
          >
            {t("chat.startPage.quota.refresh")}
          </Button>
        </div>
      </div>
      <h3 className={SECTION_SUBHEADING_CLASSES}>
        {t("kanban.dataSource.views.quota")}
      </h3>
      {entries.length === 0 ? (
        <p className="px-1 text-center text-[13px] text-text-3">
          {t("chat.startPage.quota.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className={`grid gap-2 ${gridClassName}`}>
            {entries.map((entry) => (
              <StartPageQuotaCard key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
