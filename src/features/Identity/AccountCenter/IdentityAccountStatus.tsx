import React from "react";
import { useTranslation } from "react-i18next";

import type { IdentitySession, SecureStoreStatus } from "../identityTypes";

const STATUS_CLASS = {
  restoring: "bg-fill-2 text-text-2",
  ready: "bg-success-1 text-success-6",
  offline_degraded: "bg-warning-1 text-warning-6",
  reauth_required: "bg-danger-1 text-danger-6",
  signing_out: "bg-fill-2 text-text-2",
} as const satisfies Record<IdentitySession["status"], string>;

interface IdentityAccountStatusProps {
  identityLabel: string;
  session: IdentitySession;
  secureStoreStatus: SecureStoreStatus;
}

export const IdentityAccountStatus: React.FC<IdentityAccountStatusProps> = ({
  identityLabel,
  session,
  secureStoreStatus,
}) => {
  const { t } = useTranslation("navigation");
  const endpointLabel = new URL(session.issuer).host;
  const statusKey =
    secureStoreStatus === "locked"
      ? "secureStoreLocked"
      : secureStoreStatus === "unavailable"
        ? "secureStoreUnavailable"
        : session.status;
  const statusClass =
    secureStoreStatus === "available"
      ? STATUS_CLASS[session.status]
      : "bg-warning-1 text-warning-6";

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="max-w-56 truncate text-sm text-text-2"
          title={identityLabel}
          data-testid="org2-cloud-signed-in-identity"
          data-identity-source="broker"
        >
          {t("cloud.signedInAs", { name: identityLabel })}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}
          data-testid="org2-cloud-account-status"
        >
          {t(`cloud.accountCenter.status.${statusKey}`)}
        </span>
      </div>
      <span className="text-xs text-text-3" title={session.issuer}>
        {t("cloud.accountCenter.endpoint", { endpoint: endpointLabel })}
      </span>
    </div>
  );
};
