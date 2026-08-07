/**
 * KeyHealthBadge
 *
 * Reusable component to display key health status.
 * Works for both local keys and market listings.
 * Shows: valid, degraded, invalid
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { HealthStatus } from "@src/api/types/keys";
import InlineAlert from "@src/components/InlineAlert";

export interface KeyHealthBadgeProps {
  /** Health status: valid, degraded, invalid */
  healthStatus?: HealthStatus;
  /** Number of failures (optional) */
  failureCount?: number;
  /** Last failure message (optional) */
  lastFailureMessage?: string;
  /**
   * Context affects messaging:
   * - "local": Local credential issues
   * - "listing": Market listing issues
   * - "cloud_warning": Warning when local works but cloud has issues (shown in All/Local tabs)
   */
  context?: "local" | "listing" | "cloud_warning";
  /** Number of available/working models (for degraded) */
  availableModelCount?: number;
  /** Number of enabled models (for degraded) */
  enabledModelCount?: number;
  temporaryUnavailableUntil?: string;
  temporaryUnavailableReason?: string;
  lastUpstreamStatus?: number;
}

const formatCooldownUntil = (value?: string) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date <= new Date()) return null;
  return date.toLocaleString();
};

const KeyHealthBadge: React.FC<KeyHealthBadgeProps> = ({
  healthStatus = "valid",
  failureCount = 0,
  lastFailureMessage,
  context = "local",
  availableModelCount,
  enabledModelCount,
  temporaryUnavailableUntil,
  temporaryUnavailableReason,
  lastUpstreamStatus,
}) => {
  const { t } = useTranslation("integrations");
  const isListing = context === "listing";
  const isCloudWarning = context === "cloud_warning";
  const isInvalid = healthStatus === "invalid";
  const isDegraded = healthStatus === "degraded";
  const cooldownUntil = formatCooldownUntil(temporaryUnavailableUntil);

  // Cloud warning - local works but cloud has issues (shown in All/Local tabs)
  if (isCloudWarning) {
    const title =
      healthStatus === "invalid"
        ? t("keyVault.health.cloudListingInvalid")
        : t("keyVault.health.cloudListingDegraded");
    const message =
      healthStatus === "invalid"
        ? t("keyVault.health.cloudInvalidMessage")
        : t("keyVault.health.cloudDegradedMessage");

    return (
      <InlineAlert type="warning">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <p className="mt-1 text-sm">{message}</p>
          {lastFailureMessage && (
            <p className="mt-1 break-words text-xs">{lastFailureMessage}</p>
          )}
        </div>
      </InlineAlert>
    );
  }

  // Full display - Invalid (red)
  if (isInvalid) {
    const message = isListing
      ? t("keyVault.health.invalidListingMessage")
      : t("keyVault.health.invalidKeyMessage");

    return (
      <InlineAlert type="danger">
        <div className="min-w-0">
          <div className="text-sm font-medium">{message}</div>
          {failureCount > 0 && (
            <p className="mt-1 text-xs">
              {t("keyVault.health.failuresDetected", {
                count: failureCount,
              })}
            </p>
          )}
          {lastFailureMessage && (
            <p className="mt-1 break-words text-xs">
              {t("keyVault.health.errorWithMessage", {
                message: lastFailureMessage,
              })}
            </p>
          )}
        </div>
      </InlineAlert>
    );
  }

  // Full display - Degraded (orange)
  if (isDegraded) {
    const title = isListing
      ? t("keyVault.health.degradedListing")
      : t("keyVault.health.degradedKey");

    // Build dynamic message
    let message: string;
    if (
      enabledModelCount !== undefined &&
      availableModelCount !== undefined &&
      enabledModelCount < availableModelCount
    ) {
      const disabledCount = availableModelCount - enabledModelCount;
      message = t("keyVault.health.modelsUnavailable", {
        disabled: disabledCount,
        available: availableModelCount,
      });
    } else if (isListing) {
      message = t("keyVault.health.someModelsFailures");
    } else {
      message = t("keyVault.health.someModelsUnavailable");
    }

    return (
      <InlineAlert type="warning">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <p className="mt-1 text-sm">{message}</p>
          {cooldownUntil && (
            <p className="mt-1 text-xs">
              Temporarily unavailable until {cooldownUntil}
              {temporaryUnavailableReason
                ? ` (${temporaryUnavailableReason})`
                : ""}
              {lastUpstreamStatus ? ` · HTTP ${lastUpstreamStatus}` : ""}
            </p>
          )}
          {failureCount > 0 && (
            <p className="mt-1 text-xs">
              {t("keyVault.health.failuresDetected", {
                count: failureCount,
              })}
            </p>
          )}
          {lastFailureMessage && (
            <p className="mt-1 break-words text-xs">{lastFailureMessage}</p>
          )}
        </div>
      </InlineAlert>
    );
  }

  // Valid state (green) - typically not shown, but available if needed
  return (
    <InlineAlert type="success">
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {t("keyVault.quickActions.valid")}
        </div>
      </div>
    </InlineAlert>
  );
};

export default KeyHealthBadge;
