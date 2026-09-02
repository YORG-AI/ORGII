/**
 * AccountListItem Component
 *
 * Displays a single account in the list with:
 * - Provider icon
 * - Account name
 * - Quota percentage (X% left)
 * - Status indicator
 */
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import { getListItemClasses } from "@src/components/ListPanel/tokens";
import ModelIcon from "@src/components/ModelIcon";
import { QuotaBarInline } from "@src/components/QuotaBar";
import Tooltip from "@src/components/Tooltip";
import type { KeyVaultAccount } from "@src/hooks/keyVault";

interface AccountListItemProps {
  account: KeyVaultAccount;
  isSelected: boolean;
  onSelect: (accountId: string) => void;
}

const AccountListItem: React.FC<AccountListItemProps> = React.memo(
  ({ account, isSelected, onSelect }) => {
    const { t } = useTranslation("integrations");
    const handleClick = useCallback(() => {
      onSelect(account.id);
    }, [account.id, onSelect]);

    // Note: health_status is deprecated - status is single source of truth
    // APPROVED = working, SUSPENDED/REJECTED = broken

    // Status badge config - using theme variables
    const statusConfig = useMemo(
      () => ({
        ready: {
          label: t("keyVault.status.readyToUse"),
          colorClass: "bg-success-6",
        },
        needs_setup: {
          label: t("keyVault.status.needsConfiguration"),
          colorClass: "bg-fill-2",
        },
        expired: {
          label: t("keyVault.status.keysExpired"),
          colorClass: "bg-warning-6",
        },
        error: {
          label: t("common:status.error"),
          colorClass: "bg-danger-6",
        },
        pending_approval: {
          label: t("keyVault.status.pendingApproval"),
          colorClass: "bg-primary-6",
        },
      }),
      [t]
    );

    // Check for limited usage items (e.g., premium requests on Copilot Business)
    const usageItems = (
      account.quotaInfo as Record<string, unknown> | undefined
    )?.usage_items as
      | Array<{
          usage_type: string;
          limit: number;
          remaining_percentage: number;
        }>
      | undefined;
    const premiumItem = usageItems?.find(
      (item) => item.usage_type === "premium" && item.limit > 0
    );

    // Use premium remaining if available, otherwise top-level
    const quotaPercentage = premiumItem
      ? premiumItem.remaining_percentage
      : account.quotaInfo?.remaining_percentage;
    const hasValidQuota = quotaPercentage !== undefined && quotaPercentage >= 0;

    const quotaInfoWithOnDemand = account.quotaInfo as
      | { on_demand_enabled?: boolean; on_demand_limit?: number }
      | null
      | undefined;

    // Check if account has unlimited quota (on-demand without limit)
    // But not truly unlimited if there are limited premium quotas
    const isUnlimited =
      (account.quotaInfo?.is_unlimited === true ||
        (quotaInfoWithOnDemand?.on_demand_enabled === true &&
          (quotaInfoWithOnDemand?.on_demand_limit ?? 0) === 0)) &&
      !premiumItem;

    // Get status with color based on health status
    const getStatusInfo = () => {
      // Verification-specific statuses for Cursor listings
      if (account.modelType === CLI_AGENT.CURSOR && account.verificationData) {
        const vState = account.verificationData.state;
        if (account.listingStatus === "pending") {
          if (vState === "pending") {
            return {
              label: t("keyVault.status.pendingVerification"),
              shortLabel: t("keyVault.status.verifying"),
              colorClass: "bg-warning-6",
              textClass: "text-warning-6",
            };
          }
          if (vState === "in_progress") {
            return {
              label: t("keyVault.status.verifyingKeys"),
              shortLabel: t("keyVault.status.verifying"),
              colorClass: "bg-info-6",
              textClass: "text-info-6",
            };
          }
        }
        if (account.listingStatus === "rejected" && vState === "failed") {
          return {
            label: t("keyVault.status.verificationFailedMismatch"),
            shortLabel: t("common:status.failed"),
            colorClass: "bg-danger-6",
            textClass: "text-danger-6",
          };
        }
      }

      if (account.listingStatus === "suspended") {
        return {
          label: t("keyVault.status.suspendedApiKey"),
          shortLabel: t("keyVault.status.suspended"),
          colorClass: "bg-danger-6",
          textClass: "text-danger-6",
        };
      }

      if (account.listingStatus === "rejected") {
        const errorMsg =
          account.verificationData?.error || t("keyVault.status.invalidKeys");
        return {
          label: t("keyVault.status.validationFailed", {
            error: errorMsg,
          }),
          shortLabel: t("common:status.failed"),
          colorClass: "bg-danger-6",
          textClass: "text-danger-6",
        };
      }

      if (account.listingStatus === "pending") {
        return {
          label: t("keyVault.status.validatingKeys"),
          shortLabel: t("keyVault.status.validating"),
          colorClass: "bg-warning-6",
          textClass: "text-warning-6",
        };
      }

      const effectiveStatus = account.status;

      // Default to base status config
      const base = statusConfig[effectiveStatus] || statusConfig.error;
      return {
        ...base,
        shortLabel: effectiveStatus === "ready" ? "" : base.label.split(" ")[0],
        textClass:
          effectiveStatus === "ready"
            ? ""
            : effectiveStatus === "needs_setup"
              ? "text-text-3"
              : "text-warning-6",
      };
    };

    const status = getStatusInfo();

    const isKeyBroken =
      account.listingStatus === "suspended" ||
      account.listingStatus === "rejected";

    const isVerifying =
      account.listingStatus === "pending" &&
      account.verificationData?.state &&
      ["pending", "in_progress"].includes(account.verificationData.state);

    const isVerificationFailed =
      account.listingStatus === "rejected" &&
      account.verificationData?.state === "failed";

    const showStatusText =
      isKeyBroken ||
      isVerifying ||
      isVerificationFailed ||
      account.status === "needs_setup";

    // Show quota if key works and not verifying/broken (those show status text instead)
    const showQuota =
      !isKeyBroken &&
      !isVerifying &&
      !isVerificationFailed &&
      hasValidQuota &&
      quotaPercentage != null;

    return (
      <div
        className={getListItemClasses(isSelected)}
        data-account-id={account.id}
        data-account-name={account.name}
        data-testid="key-vault-account-row"
        onClick={handleClick}
      >
        {/* Left: Provider Icon */}
        <div className="flex shrink-0 items-center">
          <ModelIcon agentType={account.modelType} size={16} />
        </div>

        {/* Middle: Name */}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {account.name}
        </span>

        {/* Right: Status info + Status dot */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Quota percentage - reuse QuotaBarInline */}
          {showQuota && (
            <QuotaBarInline
              remainingPercent={quotaPercentage}
              isUnlimited={isUnlimited}
            />
          )}
          {/* Status text for problem accounts */}
          {showStatusText && status.shortLabel && (
            <span className={`text-[11px] font-medium ${status.textClass}`}>
              {status.shortLabel}
            </span>
          )}
          {/* Status dot with tooltip */}
          <Tooltip content={status.label} position="top">
            <div
              className={`h-2 w-2 shrink-0 rounded-full ${status.colorClass}`}
            />
          </Tooltip>
        </div>
      </div>
    );
  }
);

AccountListItem.displayName = "AccountListItem";

export default AccountListItem;
