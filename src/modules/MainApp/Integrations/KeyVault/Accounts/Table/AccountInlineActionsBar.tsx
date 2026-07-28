import { RefreshCw } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import { buildCodexReauthPath } from "@src/config/mainAppPaths";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { useRefreshSpin } from "@src/hooks/ui";
import { AccountStatusIndicator } from "@src/modules/shared/keyVault/AccountStatusIndicator";

import { InlineCardFooter } from "../../shared/InlineCardPrimitives";
import { shouldShowCodexReconnect } from "./accountInlineActions";

interface AccountInlineActionsBarProps {
  account: KeyVaultAccount;
  refreshing?: boolean;
  refreshingModels?: boolean;
  refreshLabel?: string;
  onRefresh?: () => void | Promise<void>;
  onRefreshModels?: () => void | Promise<void>;
  onEdit?: () => void;
  onDisconnect?: (accountId: string, deleteType?: "local" | "cloud") => void;
}

export const AccountInlineActionsBar: React.FC<
  AccountInlineActionsBarProps
> = ({
  account,
  refreshing = false,
  refreshingModels = false,
  refreshLabel,
  onRefresh,
  onRefreshModels,
  onEdit,
  onDisconnect,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();

  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    onRefresh ?? (() => {}),
    refreshing
  );
  const { spinClass: modelSpinClass, handleClick: handleRefreshModelsClick } =
    useRefreshSpin(onRefreshModels ?? (() => {}), refreshingModels);

  const showEdit = !account.listingId && account.hasLocalKey && onEdit;
  const showCodexReconnect = shouldShowCodexReconnect(account);
  const resolvedRefreshLabel = refreshLabel ?? tCommon("actions.refresh");
  return (
    <InlineCardFooter>
      <div className="mr-auto flex min-h-7 items-center">
        <AccountStatusIndicator account={account} />
      </div>
      {showCodexReconnect ? (
        <Button
          variant="primary"
          size="small"
          onClick={() => navigate(buildCodexReauthPath(account.id))}
          title={tCommon("errors.reconnectCodex")}
        >
          {tCommon("errors.reconnectCodex")}
        </Button>
      ) : null}
      {onRefresh ? (
        <Button
          variant="secondary"
          size="small"
          onClick={handleRefreshClick}
          disabled={refreshing}
          icon={<RefreshCw size={14} className={spinClass} />}
          title={resolvedRefreshLabel}
        >
          {resolvedRefreshLabel}
        </Button>
      ) : null}
      {onRefreshModels ? (
        <Button
          variant="secondary"
          size="small"
          onClick={handleRefreshModelsClick}
          disabled={refreshingModels}
          icon={<RefreshCw size={14} className={modelSpinClass} />}
          title={t("keyVault.refreshModels.button")}
        >
          {t("keyVault.refreshModels.button")}
        </Button>
      ) : null}
      {showEdit ? (
        <Button variant="secondary" size="small" onClick={onEdit}>
          {tCommon("actions.edit")}
        </Button>
      ) : null}
      {onDisconnect && account.hasLocalKey && account.isListed ? (
        <>
          <Button
            variant="danger"
            appearance="outline"
            size="small"
            onClick={() => onDisconnect(account.id, "local")}
          >
            {t("keyVault.removeLocal")}
          </Button>
          <Button
            variant="danger"
            appearance="outline"
            size="small"
            onClick={() => onDisconnect(account.id, "cloud")}
          >
            {t("keyVault.unlist")}
          </Button>
        </>
      ) : null}
      {onDisconnect && !(account.hasLocalKey && account.isListed) ? (
        <Button
          variant="danger"
          appearance="outline"
          size="small"
          onClick={() => onDisconnect(account.id)}
        >
          {account.hasLocalKey
            ? tCommon("actions.remove")
            : tCommon("actions.delete")}
        </Button>
      ) : null}
    </InlineCardFooter>
  );
};
