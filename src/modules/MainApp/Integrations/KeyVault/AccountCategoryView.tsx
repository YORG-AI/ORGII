import React from "react";

import { KeyVaultWizard } from "@src/scaffold/WizardSystem/variants/KeyVault";

import { AccountsTable } from "./Table/AccountsTable";
import type { AccountsCategoryTableProps } from "./categoryTableProps";
import type { useKeyVaultPage } from "./hooks/useKeyVaultPage";

export const AccountCategoryView: React.FC<{
  accounts: ReturnType<typeof useKeyVaultPage>;
  tableProps: AccountsCategoryTableProps;
  fullPage: boolean;
  onBack: () => void;
  onExpand?: () => void;
  onClosePreview: () => void;
}> = ({ accounts, tableProps }) => {
  if (accounts.showAddForm) {
    return (
      <KeyVaultWizard
        onSubmit={accounts.handleFormSubmit}
        onCancel={accounts.handleFormCancel}
        loading={accounts.formLoading}
        initialAgentType={accounts.formInitialAgentType}
        initialData={accounts.formInitialData}
        autoStartCodexLogin={accounts.autoStartCodexLogin}
        existingAccountNames={accounts.formExistingAccountNames}
      />
    );
  }

  return <AccountsTable {...tableProps} />;
};
