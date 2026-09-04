/**
 * AccountListPanel Component
 *
 * Left drill-down panel shown when a full-page account detail is active.
 * Contains:
 * - Back button header
 * - Search input
 * - Accounts list (selectable)
 * - Add Account button
 */
import Button from "@/src/components/Button";
import React from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  Add01Icon,
  ArrowLeft02Icon,
  HugeiconsIcon,
  Search01Icon,
} from "@src/icons";
import { ListPanelScrollArea } from "@src/modules/shared/layouts/blocks";

import AccountListItem from "./AccountListItem";

interface AccountListPanelProps {
  accounts: KeyVaultAccount[];
  filteredAccounts: KeyVaultAccount[];
  selectedAccountId: string | null;
  searchQuery: string;
  loading: boolean;
  error: string | null;
  onAccountSelect: (accountId: string) => void;
  onSearchChange: (query: string) => void;
  onAddAccount: () => void;
  /** Navigate back to the category list */
  onBack?: () => void;
  /** Header title shown next to the back arrow */
  title?: string;
}

const AccountListPanel: React.FC<AccountListPanelProps> = ({
  accounts,
  filteredAccounts,
  selectedAccountId,
  searchQuery,
  loading,
  error,
  onAccountSelect,
  onSearchChange,
  onAddAccount,
  onBack,
  title,
}) => {
  const { t } = useTranslation("integrations");

  return (
    <div className="flex h-full flex-col">
      {onBack && (
        <div className="flex h-10 shrink-0 items-center gap-2 px-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center justify-center rounded-md p-1 text-text-2 transition-colors hover:bg-fill-2 hover:text-text-1"
          >
            <HugeiconsIcon
              icon={ArrowLeft02Icon}
              data-icon="arrow-left"
              size={16}
            />
          </button>
          <span className="text-[13px] font-medium text-text-1">
            {title ?? t("modelsTabs.myAccounts")}
          </span>
        </div>
      )}

      {/* Search */}
      <div className="shrink-0 px-3 pb-2">
        <Input
          prefix={
            <HugeiconsIcon
              icon={Search01Icon}
              data-icon="search"
              size={14}
              strokeWidth={1.75}
            />
          }
          placeholder={t("keyVault.searchPlaceholder")}
          value={searchQuery}
          onChange={onSearchChange}
          size="default"
        />
      </div>

      {/* Account List */}
      <ListPanelScrollArea listPaddingTop="none">
        {loading && accounts.length === 0 ? (
          <Placeholder variant="loading" />
        ) : error &&
          !error.includes("Provider") &&
          !error.includes("not found") ? (
          <Placeholder variant="error" subtitle={error} />
        ) : filteredAccounts.length === 0 ? (
          <Placeholder variant="empty" title={t("keyVault.noAccountsFound")} />
        ) : (
          <div className="flex flex-col gap-1 pb-2">
            {filteredAccounts.map((account) => (
              <AccountListItem
                key={account.id}
                account={account}
                isSelected={selectedAccountId === account.id}
                onSelect={onAccountSelect}
              />
            ))}
          </div>
        )}
      </ListPanelScrollArea>

      {/* Add Account Button */}
      <div className="shrink-0 p-3">
        <Button
          variant="primary"
          size="large"
          icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={16} />}
          long
          onClick={onAddAccount}
          data-testid="key-vault-add-account-button"
        >
          {t("keyVault.addAccount")}
        </Button>
      </div>
    </div>
  );
};

export default AccountListPanel;
