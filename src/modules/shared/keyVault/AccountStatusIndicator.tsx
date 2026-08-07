import React from "react";
import { useTranslation } from "react-i18next";

import StatusDot from "@src/components/StatusDot";
import type { KeyVaultAccount } from "@src/hooks/keyVault";

import { KEY_VAULT_STATUS_DOT } from "./statusColors";

interface AccountStatusIndicatorProps {
  account: KeyVaultAccount;
}

export function AccountStatusIndicator({
  account,
}: AccountStatusIndicatorProps): React.ReactElement {
  const { t } = useTranslation("integrations");
  const statusLabel =
    {
      ready: t("status.ready"),
      needs_setup: t("status.needsSetup"),
      error: t("status.error"),
      expired: t("status.expired"),
      pending_approval: t("status.pendingApproval"),
    }[account.status] ?? account.status;

  return (
    <StatusDot
      color={KEY_VAULT_STATUS_DOT[account.status] ?? "bg-fill-3"}
      size="inline"
      label={statusLabel}
    />
  );
}
