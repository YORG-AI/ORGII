import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getFullKey } from "@src/api/services/keyValidation";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import { isApiKeyProvider } from "@src/assets/providers";
import Message from "@src/components/Message";
import {
  getQuotaBgColorClass,
  getQuotaTextColorClass,
} from "@src/components/QuotaBar";
import StatusDot from "@src/components/StatusDot";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  formatQuotaResetHint,
  getGroupedUsageItemsForDisplay,
  getQuotaUsageLabel as getSharedQuotaUsageLabel,
  resolveAccountUsageItems,
  resolveQuotaPlanLabel,
} from "@src/hooks/keyVault/accountQuotaDisplay";
import { useCopyCheck } from "@src/hooks/ui";
import { Copy01Icon, HugeiconsIcon, Tick01Icon } from "@src/icons";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";
import InlineExpandedSplitCard from "@src/modules/shared/layouts/blocks/InlineExpandedSplitCard";
import { copyText } from "@src/util/data/clipboard";

import { AccountCompatibilitySection } from "./AccountCompatibilitySection";
import KeyHealthBadge from "./KeyHealthBadge";
import VerificationStatusBadge from "./VerificationStatusBadge";

interface AccountInlineDetailsProps {
  account: KeyVaultAccount;
}

function shouldShowAccountQuota(account: KeyVaultAccount): boolean {
  return Boolean(
    account.quotaInfo &&
    account.healthStatus !== "invalid" &&
    account.listingStatus !== "suspended"
  );
}

function hasTotalPercentUsed(
  quotaInfo: KeyVaultAccount["quotaInfo"]
): quotaInfo is NonNullable<KeyVaultAccount["quotaInfo"]> & {
  total_percent_used: number;
} {
  return (
    Boolean(quotaInfo) &&
    typeof (quotaInfo as { total_percent_used?: unknown })
      .total_percent_used === "number"
  );
}

function resolvePlanLabel(account: KeyVaultAccount): string | null {
  return resolveQuotaPlanLabel(account);
}

export const AccountInlineDetails: React.FC<AccountInlineDetailsProps> = ({
  account,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation();

  const modelCount = account.availableModels?.length ?? 0;
  const enabledModelCount = account.enabledModels?.length ?? 0;
  const isApiKey = isApiKeyProvider(account.modelType);
  const isCursorAccount = account.modelType === CLI_AGENT.CURSOR;
  const showApiKey =
    account.hasApiKey && account.authMethod !== "oauth" && account.hasLocalKey;
  const showCursorApiStatus = isCursorAccount && account.hasLocalKey;
  const showSessionToken =
    account.hasSessionToken && isCursorAccount && account.hasLocalKey;
  const showQuota = shouldShowAccountQuota(account);

  const isMarketAccount = account.isListed;

  const effectiveHealthStatus = (() => {
    if (account.listingStatus === "suspended") return "invalid";
    return account.healthStatus;
  })();

  const showHealthBadge =
    effectiveHealthStatus === "invalid" || effectiveHealthStatus === "degraded";

  const showVerificationStatus =
    isMarketAccount &&
    account.modelType === CLI_AGENT.CURSOR &&
    (account.listingStatus === "pending" ||
      account.listingStatus === "rejected");

  const showMarketHealthWarning =
    account.hasLocalKey &&
    account.isListed &&
    (account.marketHealthStatus === "invalid" ||
      account.marketHealthStatus === "degraded");

  const authMethodValue =
    account.authMethod === "oauth"
      ? t("keyVault.info.oauthLogin")
      : t("keyVault.info.apiKey");
  const categoryValue = isApiKey
    ? t("keyVault.categoryApi")
    : t("keyVault.categorySubscription");
  const overviewValue = [
    account.authMethod ? authMethodValue : null,
    categoryValue,
  ]
    .filter(Boolean)
    .join(" · ");

  const quotaSummary = useMemo(() => {
    if (!showQuota || !account.quotaInfo) return null;

    const quotaInfo = account.quotaInfo;
    const planLabel = resolvePlanLabel(account);
    const remainingPercent = hasTotalPercentUsed(quotaInfo)
      ? 100 - quotaInfo.total_percent_used
      : (quotaInfo.remaining_percentage ?? 0);

    return {
      planLabel,
      remainingPercent,
      barBgClass: getQuotaBgColorClass(remainingPercent),
      textColorClass: getQuotaTextColorClass(remainingPercent),
      isUnlimited: quotaInfo.is_unlimited === true,
    };
  }, [account, showQuota]);

  const quotaUsageItems = useMemo(() => {
    if (!showQuota || !account.quotaInfo) {
      return [];
    }

    return getGroupedUsageItemsForDisplay(
      account,
      resolveAccountUsageItems(account)
    );
  }, [account, showQuota]);

  const resolveQuotaUsageLabel = useCallback(
    (usageType: string): string =>
      getSharedQuotaUsageLabel(account.modelType, usageType, t),
    [account.modelType, t]
  );

  const copyApiKey = useCallback(async () => {
    const cred = await getFullKey(account.modelType, account.id);
    const key = cred?.api_key;
    if (!key) {
      Message.error({ content: tCommon("errors.notFound") });
      return;
    }
    await copyText(key);
    Message.success({ content: tCommon("status.copied") });
  }, [account.modelType, account.id, tCommon]);

  const { copied: apiKeyCopied, handleCopy: handleCopyApiKey } =
    useCopyCheck(copyApiKey);

  const connectedAtLabel = account.connectedAt
    ? `${account.connectedAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(account.connectedAt.getFullYear() === new Date().getFullYear()
          ? {}
          : { year: "numeric" }),
      })}, ${account.connectedAt.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`
    : null;

  const accountEmail = account.accountMetadata?.email;

  const accountUsageRows = (
    <>
      {modelCount > 0 ? (
        <InfoRow
          label={t("keyVault.info.availableModels")}
          value={t("keyVault.info.modelsEnabledAddable", {
            enabled: enabledModelCount,
            addable: modelCount - enabledModelCount,
          })}
        />
      ) : null}
      {quotaSummary ? (
        <>
          {quotaUsageItems.length > 0 ? (
            quotaUsageItems.map((item) => {
              const remainingPercent = item.remaining_percentage;
              const barBgClass = getQuotaBgColorClass(remainingPercent);
              const textColorClass = getQuotaTextColorClass(remainingPercent);
              const resetHint = formatQuotaResetHint(
                item.usage_type,
                remainingPercent,
                item.reset_time,
                t
              );
              const usageLabel = resolveQuotaUsageLabel(item.usage_type);

              return (
                <InfoRow
                  key={item.usage_type}
                  label={
                    resetHint
                      ? `${usageLabel} (${resetHint.compact})`
                      : usageLabel
                  }
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-fill-3">
                      <div
                        className={`h-full rounded-full transition-all ${barBgClass}`}
                        style={{ width: `${remainingPercent}%` }}
                      />
                    </div>
                    <span className={`shrink-0 text-[12px] ${textColorClass}`}>
                      {t("keyVault.quota.percentLeft", {
                        percent: Math.round(remainingPercent),
                      })}
                    </span>
                  </div>
                </InfoRow>
              );
            })
          ) : (
            <InfoRow label={t("keyVault.quota.quotaUsage")}>
              <div className="flex min-w-0 items-center gap-2">
                <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-fill-3">
                  <div
                    className={`h-full rounded-full transition-all ${quotaSummary.barBgClass}`}
                    style={{
                      width: `${
                        quotaSummary.isUnlimited
                          ? 100
                          : quotaSummary.remainingPercent
                      }%`,
                    }}
                  />
                </div>
                <span
                  className={`shrink-0 text-[12px] ${quotaSummary.textColorClass}`}
                >
                  {quotaSummary.isUnlimited
                    ? "∞"
                    : t("keyVault.quota.percentLeft", {
                        percent: Math.round(quotaSummary.remainingPercent),
                      })}
                </span>
              </div>
            </InfoRow>
          )}
        </>
      ) : null}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {showVerificationStatus ? (
        <VerificationStatusBadge
          listingStatus={account.listingStatus!}
          verificationData={account.verificationData}
          rejectionReason={account.rejectionReason}
        />
      ) : null}
      {showHealthBadge && !showVerificationStatus ? (
        <KeyHealthBadge
          context={account.hasLocalKey ? "local" : "listing"}
          healthStatus={effectiveHealthStatus}
          failureCount={account.failureCount}
          lastFailureMessage={account.lastFailureMessage}
          temporaryUnavailableUntil={account.temporaryUnavailableUntil}
          temporaryUnavailableReason={account.temporaryUnavailableReason}
          lastUpstreamStatus={account.lastUpstreamStatus}
          availableModelCount={account.availableModels?.length}
          enabledModelCount={account.enabledModels?.length}
        />
      ) : null}
      {showMarketHealthWarning ? (
        <KeyHealthBadge
          context="cloud_warning"
          healthStatus={account.marketHealthStatus}
          lastFailureMessage={account.marketFailureMessage}
        />
      ) : null}
      <InlineExpandedSplitCard
        wrapInCard={false}
        equalColumns
        left={
          <div className="flex min-w-0 flex-col gap-2">
            <InfoRow label={tCommon("common.overview")} value={overviewValue} />
            {quotaSummary ? (
              <InfoRow
                label={t("keyVault.quota.plan")}
                value={quotaSummary.planLabel ?? "—"}
              />
            ) : null}
            {connectedAtLabel ? (
              <InfoRow
                label={t("keyVault.info.connectedAt")}
                value={connectedAtLabel}
              />
            ) : null}
            {accountEmail ? (
              <InfoRow
                label={t("keyVault.info.accountEmail")}
                value={accountEmail}
              />
            ) : null}
          </div>
        }
        right={
          <div className="flex min-w-0 flex-col gap-2">
            {accountUsageRows}
            {account.baseUrl ? (
              <InfoRow
                label={t("keyVault.info.baseUrl")}
                value={account.baseUrl}
              />
            ) : null}
            {showSessionToken ? (
              <InfoRow label={t("keyVault.info.cursorSessionAccess")}>
                <StatusDot
                  color="bg-success-6"
                  size="inline"
                  label={t("keyVault.info.cursorSessionReady")}
                />
              </InfoRow>
            ) : null}
            {showCursorApiStatus ? (
              <InfoRow label={t("keyVault.info.cursorApiKeyAccess")}>
                <StatusDot
                  color={account.hasApiKey ? "bg-success-6" : "bg-text-4"}
                  size="inline"
                  label={
                    account.hasApiKey
                      ? t("keyVault.info.cursorApiKeyReady")
                      : t("keyVault.info.cursorApiKeyNotProvided")
                  }
                />
              </InfoRow>
            ) : null}
            {showApiKey ? (
              <InfoRow label={t("keyVault.info.apiKey")}>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text-1">
                    {account.apiKeyPreview ?? t("keyVault.info.configured")}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyApiKey}
                    className={`transition-colors ${apiKeyCopied ? "text-success-6" : "text-text-2 hover:text-text-1"}`}
                  >
                    {apiKeyCopied ? (
                      <HugeiconsIcon
                        icon={Tick01Icon}
                        data-icon="check"
                        size={13}
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={Copy01Icon}
                        data-icon="copy"
                        size={13}
                      />
                    )}
                  </button>
                </div>
              </InfoRow>
            ) : null}
          </div>
        }
      />
      <div className="border-t border-border-2 pt-2">
        <AccountCompatibilitySection account={account} />
      </div>
      {account.description ? (
        <div className="flex min-w-0 flex-col gap-1 border-t border-border-2 pt-2">
          <span className="text-[12px] font-semibold text-text-1">
            {t("keyVault.descriptionOptional")}
          </span>
          <p className="text-[12px] wrap-break-word whitespace-pre-wrap text-text-2">
            {account.description}
          </p>
        </div>
      ) : null}
    </div>
  );
};

export default AccountInlineDetails;
