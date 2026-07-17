/**
 * VerificationStatusBadge
 *
 * Displays the verification status for Cursor listings.
 * Shows different states: pending, in_progress, passed, failed
 *
 * Used for:
 * - Provider's own listing view (shows verification progress)
 * - Admin views
 */
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Loader2,
  XCircle,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type {
  ListingStatus,
  VerificationData,
  VerificationState,
} from "@src/api/types/keyVault";
import InlineAlert from "@src/components/InlineAlert";
import Tag from "@src/components/Tag";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";

export interface VerificationStatusBadgeProps {
  /** Listing status (pending, approved, rejected, etc.) */
  listingStatus: ListingStatus;
  /** Verification data from listing */
  verificationData?: VerificationData;
  /** Show compact version (just the tag) */
  compact?: boolean;
  /** Rejection reason (for rejected listings) */
  rejectionReason?: string;
}

/**
 * Get the effective verification state from listing status and verification data
 */
function getEffectiveState(
  listingStatus: ListingStatus,
  verificationData?: VerificationData
): VerificationState | "approved" | "rejected_other" {
  // If listing is approved, verification passed (or wasn't needed)
  if (listingStatus === "approved") {
    return "approved";
  }

  // If listing is rejected, check if it was due to verification failure
  if (listingStatus === "rejected") {
    if (verificationData?.state === "failed") {
      return "failed";
    }
    // Rejected for other reasons (admin rejection, etc.)
    return "rejected_other";
  }

  // If listing is pending, check verification state
  if (listingStatus === "pending") {
    return verificationData?.state || "pending";
  }

  // Default fallback
  return "pending";
}

const VerificationStatusBadge: React.FC<VerificationStatusBadgeProps> = ({
  listingStatus,
  verificationData,
  compact = false,
  rejectionReason,
}) => {
  const { t } = useTranslation("integrations");
  const effectiveState = getEffectiveState(listingStatus, verificationData);

  // Compact badge (tag only)
  if (compact) {
    switch (effectiveState) {
      case "pending":
        return (
          <Tag color="warning" size="small" icon={<Clock size={12} />}>
            {t("keyVault.verification.pendingVerification")}
          </Tag>
        );
      case "in_progress":
        return (
          <Tag
            color="info"
            size="small"
            icon={
              <Loader2 size={SPINNER_TOKENS.small} className="animate-spin" />
            }
          >
            {t("keyVault.verification.verifying")}
          </Tag>
        );
      case "passed":
      case "approved":
        return (
          <Tag color="success" size="small" icon={<CheckCircle size={12} />}>
            {t("keyVault.verification.verified")}
          </Tag>
        );
      case "failed":
        return (
          <Tag color="danger" size="small" icon={<XCircle size={12} />}>
            {t("keyVault.verification.verificationFailed")}
          </Tag>
        );
      case "rejected_other":
        return (
          <Tag color="danger" size="small" icon={<XCircle size={12} />}>
            {t("keyVault.verification.rejected")}
          </Tag>
        );
      default:
        return null;
    }
  }

  // Full display
  switch (effectiveState) {
    case "pending":
      return (
        <InlineAlert
          type="warning"
          icon={<Clock size={16} className="flex-shrink-0" />}
          title={t("keyVault.verification.pendingVerification")}
        >
          <p className="text-[13px]">
            {t("keyVault.verification.pendingMessage")}
          </p>
          <p className="mt-1 text-xs opacity-70">
            {t("keyVault.verification.pendingTime")}
          </p>
        </InlineAlert>
      );

    case "in_progress":
      return (
        <InlineAlert
          type="info"
          icon={
            <Loader2
              size={SPINNER_TOKENS.default}
              className="flex-shrink-0 animate-spin"
            />
          }
          title={t("keyVault.verification.verifyingKeys")}
        >
          <p className="text-[13px]">
            {t("keyVault.verification.verifyingMessage")}
          </p>
          {verificationData?.models && verificationData.models.length > 0 && (
            <p className="mt-1 text-xs opacity-70">
              {t("keyVault.verification.testingModels", {
                models: verificationData.models.join(", "),
              })}
            </p>
          )}
        </InlineAlert>
      );

    case "passed":
    case "approved":
      return (
        <InlineAlert
          type="success"
          icon={<CheckCircle size={16} className="flex-shrink-0" />}
        >
          {t("keyVault.verification.keysVerified")}
        </InlineAlert>
      );

    case "failed":
      return (
        <InlineAlert
          type="danger"
          icon={<XCircle size={16} className="flex-shrink-0" />}
          title={t("keyVault.verification.verificationFailed")}
        >
          <p className="text-[13px]">
            {t("keyVault.verification.failedMessage")}
          </p>
          {verificationData?.error && (
            <p className="mt-1 text-xs">
              {t("keyVault.verification.failedError", {
                error: verificationData.error,
              })}
            </p>
          )}
          <p className="mt-1 text-xs opacity-70">
            {t("keyVault.verification.failedHint")}
          </p>
        </InlineAlert>
      );

    case "rejected_other":
      return (
        <InlineAlert
          type="danger"
          icon={<AlertTriangle size={16} className="flex-shrink-0" />}
          title={t("keyVault.verification.listingRejected")}
        >
          {rejectionReason ? (
            <p className="text-[13px]">{rejectionReason}</p>
          ) : (
            <p className="text-[13px]">
              {t("keyVault.verification.rejectedByAdmin")}
            </p>
          )}
        </InlineAlert>
      );

    default:
      return null;
  }
};

export default VerificationStatusBadge;
