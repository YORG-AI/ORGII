import { useCallback, useMemo, useState } from "react";

import { CLI_AGENT } from "@src/api/types/keys";
import { formatModelAgentType } from "@src/assets/providers";
import Button from "@src/components/Button";
import ModelIcon from "@src/components/ModelIcon";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
  type SettingsTableSelectFilter,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import { MODEL_TABLE_SWITCH_SIZE } from "@src/config/modelTable";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { Add01Icon, Delete02Icon, HugeiconsIcon, Pen01Icon } from "@src/icons";
import { groupModels } from "@src/util/modelGrouping";

import { EnabledFractionText } from "../../../shared/EnabledFractionText";
import { KEY_VAULT_STATUS_DOT } from "../../statusColors";
import AccountInlineExpandedCard, {
  ACCOUNT_INLINE_TAB,
  type AccountInlineTab,
} from "./AccountInlineExpandedCard";

const ACCOUNT_PROVIDER_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  [CLI_AGENT.CLAUDE_CODE]: "Anthropic",
  [CLI_AGENT.CODEX]: "OpenAI",
};

function formatAccountProviderLabel(modelType: string): string {
  return (
    ACCOUNT_PROVIDER_LABEL_OVERRIDES[modelType] ??
    formatModelAgentType(modelType)
  );
}

function formatAccountDisplayName(account: KeyVaultAccount): string {
  if (account.modelType === CLI_AGENT.CLAUDE_CODE) {
    if (account.name.startsWith("Claude Code")) return "Anthropic";
  }
  if (account.modelType === CLI_AGENT.CODEX) {
    if (account.name.startsWith("Codex CLI OAuth")) return "OpenAI";
  }
  return account.name;
}

interface MyAccountsTableSectionProps {
  accounts: KeyVaultAccount[];
  loading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectFilters: SettingsTableSelectFilter[];
  onAdd: () => void;
  onEditAccount?: (accountId: string) => void;
  onDisconnectAccount?: (
    accountId: string,
    deleteType?: "local" | "cloud"
  ) => void;
  onRefreshAccounts?: () => Promise<void>;
  onRefreshAccountUsage?: (accountId: string) => Promise<void>;
  onRevalidateAccount?: (accountId: string) => Promise<void>;
  refreshingAccountId?: string | null;
  onToggleAccount: (account: KeyVaultAccount, enabled: boolean) => void;
  isAccountEnabled: (account: KeyVaultAccount) => boolean;
  onToggleModel?: (
    model: string,
    agentType: string,
    enabled: boolean,
    accountId?: string
  ) => void;
  onUpdateAccountEnabledModels?: (
    accountId: string,
    agentType: string,
    enabledModels: readonly string[]
  ) => void;
  onUpdateAccountDefaultVariant?: (
    accountId: string,
    baseModel: string,
    model: string
  ) => void;
  onEditAccountSave?: (
    accountId: string,
    name: string,
    description: string,
    baseUrl?: string
  ) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function getAccountModelGroupFraction(account: KeyVaultAccount): {
  enabled: number;
  total: number;
} {
  const available = account.availableModels ?? [];
  if (available.length === 0) return { enabled: 0, total: 0 };
  const groups = groupModels([...available]);
  const enabledSet = new Set(account.enabledModels ?? []);
  const enabled = groups.reduce(
    (acc, group) =>
      group.models.some((m) => enabledSet.has(m)) ? acc + 1 : acc,
    0
  );
  return { enabled, total: groups.length };
}

export default function MyAccountsTableSection({
  accounts,
  loading,
  searchQuery,
  onSearchChange,
  selectFilters,
  onAdd,
  onEditAccount,
  onDisconnectAccount,
  onRefreshAccounts,
  onRefreshAccountUsage,
  onRevalidateAccount,
  refreshingAccountId,
  onToggleAccount,
  isAccountEnabled,
  onToggleModel,
  onUpdateAccountEnabledModels,
  onUpdateAccountDefaultVariant,
  onEditAccountSave,
  t,
}: MyAccountsTableSectionProps) {
  const [expandedAccountKeys, setExpandedAccountKeys] = useState<string[]>([]);
  const [activeInlineTab, setActiveInlineTab] = useState<AccountInlineTab>(
    ACCOUNT_INLINE_TAB.STATUS
  );
  const [editRequestedAccountId, setEditRequestedAccountId] = useState<
    string | null
  >(null);

  const setSingleExpandedAccount = useCallback((account: KeyVaultAccount) => {
    setExpandedAccountKeys((currentKeys) => {
      const collapsing = currentKeys.includes(account.id);
      if (collapsing) {
        setEditRequestedAccountId(null);
        return [];
      }
      return [account.id];
    });
  }, []);

  const handleEditAccountInline = useCallback(
    (accountId: string) => {
      setExpandedAccountKeys([accountId]);
      setEditRequestedAccountId(accountId);
      setActiveInlineTab(ACCOUNT_INLINE_TAB.EDIT);
      onEditAccount?.(accountId);
    },
    [onEditAccount]
  );

  const handleEditCancel = useCallback(() => {
    setEditRequestedAccountId(null);
    setActiveInlineTab(ACCOUNT_INLINE_TAB.STATUS);
  }, []);

  const handleActiveTabChange = useCallback((tab: AccountInlineTab) => {
    setActiveInlineTab(tab);
    if (tab !== ACCOUNT_INLINE_TAB.EDIT) {
      setEditRequestedAccountId(null);
    }
  }, []);

  const columns = useMemo<SettingsTableColumn<KeyVaultAccount>[]>(
    () => [
      {
        key: "provider",
        label: t("common:labels.provider"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          formatAccountProviderLabel(rowA.modelType).localeCompare(
            formatAccountProviderLabel(rowB.modelType)
          ),
        renderCell: (account) => (
          <span
            className={`${SETTINGS_TABLE_CELL.value} inline-flex min-w-0 items-center gap-2 whitespace-nowrap`}
          >
            <ModelIcon agentType={account.modelType} size="small" />
            <span className="min-w-0 truncate">
              {formatAccountProviderLabel(account.modelType)}
            </span>
          </span>
        ),
      },
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) =>
          formatAccountDisplayName(rowA).localeCompare(
            formatAccountDisplayName(rowB)
          ),
        renderCell: (account) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} inline-flex items-center gap-1.5 font-bold`}
          >
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${KEY_VAULT_STATUS_DOT[account.status] ?? "bg-fill-3"}`}
            />
            {formatAccountDisplayName(account)}
          </span>
        ),
      },
      {
        key: "models",
        label: t("common:labels.model"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => {
          const fractionA = getAccountModelGroupFraction(rowA);
          const fractionB = getAccountModelGroupFraction(rowB);
          return fractionA.enabled - fractionB.enabled;
        },
        renderCell: (account) => {
          const { enabled, total } = getAccountModelGroupFraction(account);
          if (total === 0) return null;
          return <EnabledFractionText enabled={enabled} total={total} />;
        },
      },
      {
        key: "added",
        label: t("tableHeaders.added"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => {
          const timeA = rowA.connectedAt?.getTime() ?? 0;
          const timeB = rowB.connectedAt?.getTime() ?? 0;
          return timeA - timeB;
        },
        renderCell: (account) => {
          if (!account.connectedAt) return null;
          const isThisYear =
            account.connectedAt.getFullYear() === new Date().getFullYear();
          return (
            <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
              {account.connectedAt.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                ...(isThisYear ? {} : { year: "numeric" }),
              })}
            </span>
          );
        },
      },
      {
        key: "enabled",
        label: <span className="sr-only">{t("common:labels.status")}</span>,
        width: "128px",
        align: "right",
        sorter: (rowA, rowB) =>
          Number(isAccountEnabled(rowA)) - Number(isAccountEnabled(rowB)),
        renderCell: (account) => {
          const showEdit =
            !account.listingId &&
            account.hasLocalKey &&
            Boolean(onEditAccountSave);

          return (
            <div
              className="flex items-center justify-end gap-2 whitespace-nowrap"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Switch
                size={MODEL_TABLE_SWITCH_SIZE}
                checked={isAccountEnabled(account)}
                onCheckedChange={(checked) => onToggleAccount(account, checked)}
              />
              {showEdit ? (
                <Button
                  variant="secondary"
                  size="small"
                  icon={
                    <HugeiconsIcon
                      icon={Pen01Icon}
                      data-icon="pencil"
                      size={14}
                    />
                  }
                  iconOnly
                  onClick={() => handleEditAccountInline(account.id)}
                  aria-label={t("common:actions.edit")}
                  title={t("common:actions.edit")}
                />
              ) : null}
              {onDisconnectAccount ? (
                <Button
                  variant="danger"
                  appearance="outline"
                  size="small"
                  icon={
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      data-icon="trash-2"
                      size={14}
                    />
                  }
                  iconOnly
                  onClick={() => onDisconnectAccount(account.id)}
                  aria-label={
                    account.hasLocalKey
                      ? t("common:actions.remove")
                      : t("common:actions.delete")
                  }
                  title={
                    account.hasLocalKey
                      ? t("common:actions.remove")
                      : t("common:actions.delete")
                  }
                />
              ) : null}
            </div>
          );
        },
      },
    ],
    [
      handleEditAccountInline,
      isAccountEnabled,
      onDisconnectAccount,
      onEditAccountSave,
      onToggleAccount,
      t,
    ]
  );

  const renderExpandedAccountCard = useCallback(
    (account: KeyVaultAccount) => (
      <AccountInlineExpandedCard
        account={account}
        activeTab={activeInlineTab}
        onActiveTabChange={handleActiveTabChange}
        isAccountEnabled={isAccountEnabled(account)}
        onToggleAccount={onToggleAccount}
        onToggleModel={onToggleModel}
        onUpdateAccountEnabledModels={onUpdateAccountEnabledModels}
        onUpdateAccountDefaultVariant={onUpdateAccountDefaultVariant}
        onRefresh={
          onRefreshAccountUsage
            ? () => onRefreshAccountUsage(account.id)
            : onRefreshAccounts
        }
        onRevalidateAccount={onRevalidateAccount}
        refreshing={refreshingAccountId === account.id}
        onEditSave={onEditAccountSave}
        editRequested={editRequestedAccountId === account.id}
        onEditCancel={handleEditCancel}
      />
    ),
    [
      activeInlineTab,
      editRequestedAccountId,
      handleActiveTabChange,
      handleEditCancel,
      isAccountEnabled,
      onEditAccountSave,
      onRefreshAccountUsage,
      onRefreshAccounts,
      onRevalidateAccount,
      onToggleAccount,
      onToggleModel,
      onUpdateAccountEnabledModels,
      onUpdateAccountDefaultVariant,
      refreshingAccountId,
    ]
  );

  const expandable = useMemo(
    () => ({
      rowExpandable: () => true,
      expandedRowRender: renderExpandedAccountCard,
      expandedRowKeys: expandedAccountKeys,
      onExpandedRowsChange: (keys: string[]) => {
        const next = keys.slice(-1);
        setExpandedAccountKeys(next);
        if (next.length === 0) {
          setEditRequestedAccountId(null);
        }
      },
    }),
    [expandedAccountKeys, renderExpandedAccountCard]
  );

  const addKeyButton = (
    <Button
      variant="secondary"
      size="default"
      icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
      iconOnly
      onClick={onAdd}
      aria-label={t("keyVault.addAccount")}
      title={t("keyVault.addAccount")}
      data-testid="key-vault-add-account-button"
    />
  );

  return (
    <SettingsTable<KeyVaultAccount>
      hover
      loading={loading}
      selectFilters={selectFilters}
      columns={columns}
      rows={accounts}
      getRowKey={(account) => account.id}
      rowDataTestId={(account) => `key-vault-account-row-${account.id}`}
      onRowClick={setSingleExpandedAccount}
      expandable={expandable}
      headerHeight="tall"
      className="table-expanded-no-hover table-settings-expanded-compact"
      searchBar={{
        searchValue: searchQuery,
        onSearchChange,
        searchPlaceholder: t("keyVault.searchPlaceholder"),
        allowSearchClear: true,
        rightContent: addKeyButton,
      }}
      emptyTitle={t("keyVault.noAccountsFound")}
      emptyAction={{
        label: t("keyVault.addAccount"),
        onClick: onAdd,
      }}
    />
  );
}
