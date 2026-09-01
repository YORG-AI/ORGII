/**
 * SpotlightAccountFooter Component
 *
 * Reusable footer rendered below the keyboard-shortcuts footer in selectors.
 *
 * Two modes:
 *  - "api": shows compatible accounts for the hovered model; optional dimmed
 *    row for ready accounts not compatible (e.g. Rust agents)
 *  - "cli": plan vs API-key ready-account counts for the hovered CLI agent
 *    (same source as CliAgentSelector row badges: getCliCompatibleAccounts)
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { isApiKeyProvider } from "@src/assets/providers/index";
import ModelIcon from "@src/components/ModelIcon";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import {
  getCliCompatibleAccounts,
  useAgentCompatibility,
} from "@src/hooks/models/useAgentCompatibility";

// ============ TYPES ============

interface ApiModeProps {
  mode: "api";
  accounts: KeyVaultAccount[];
  /** When set, shows a dimmed row of ready accounts not in `accounts` (compatible set) */
  showIncompatible?: boolean;
  incompatibleAccounts?: KeyVaultAccount[];
}

interface CliModeProps {
  mode: "cli";
  agentType: string;
  accounts: KeyVaultAccount[];
  /** When true, also shows incompatible accounts (dimmed) */
  showIncompatible?: boolean;
}

type SpotlightAccountFooterProps = ApiModeProps | CliModeProps;

// ============ SUBCOMPONENTS ============

const AccountChip: React.FC<{ account: KeyVaultAccount }> = ({ account }) => {
  const isApi = isApiKeyProvider(account.modelType);
  return (
    <span className="inline-flex items-center gap-1 rounded bg-fill-2 px-1.5 py-0.5">
      {isApi ? (
        <ModelIcon agentType={account.modelType} size="small" />
      ) : (
        <ModelIcon agentType={account.modelType} size={12} />
      )}
      <span className="max-w-[100px] truncate">{account.name}</span>
    </span>
  );
};

const StatusDot: React.FC<{ active: boolean }> = ({ active }) => (
  <span
    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
      active ? "bg-success-6" : "bg-fill-3"
    }`}
  />
);

/** Matches CliAgentSelector buildCredentialBadge: green if positive count, red if zero. */
const CliCountDot: React.FC<{ count: number }> = ({ count }) => (
  <span
    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
      count > 0 ? "bg-success-6" : "bg-danger-6"
    }`}
  />
);

// ============ COMPONENT ============

export const SpotlightAccountFooter: React.FC<SpotlightAccountFooterProps> = (
  props
) => {
  const { t } = useTranslation();
  const { registry } = useAgentCompatibility();

  if (props.mode === "api") {
    const {
      accounts,
      showIncompatible = false,
      incompatibleAccounts = [],
    } = props;
    const keyCount = accounts.length;
    const hasKeys = keyCount > 0;
    const incompatibleCount = incompatibleAccounts.length;
    const showIncompatibleRow = showIncompatible && incompatibleCount > 0;

    if (!hasKeys && !showIncompatibleRow) return null;

    return (
      <div className="flex flex-col gap-1 border-t border-border-2 px-5 py-2 text-[11px] text-text-2">
        <div className="flex min-h-[20px] items-center gap-2">
          <StatusDot active={hasKeys} />
          <span className="shrink-0 text-text-3">
            {t("selectors.spotlightFooter.compatibleKeys")}:
          </span>
          <span className="shrink-0 tabular-nums">{keyCount}</span>
          {hasKeys && (
            <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
              {accounts.map((acc) => (
                <AccountChip key={acc.id} account={acc} />
              ))}
            </div>
          )}
        </div>
        {showIncompatibleRow && (
          <div className="flex min-h-[20px] min-w-0 items-center gap-2 opacity-50">
            <StatusDot active={false} />
            <span className="shrink-0 text-text-4">
              {t("selectors.spotlightFooter.incompatible")}:
            </span>
            <span className="shrink-0 tabular-nums text-text-4">
              {incompatibleCount}
            </span>
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide">
              {incompatibleAccounts.map((acc) => (
                <AccountChip key={acc.id} account={acc} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const { agentType, accounts, showIncompatible = false } = props;
  const readyAccounts = getCliCompatibleAccounts(registry, agentType, accounts);
  const planAccounts = readyAccounts.filter(
    (acc) => !isApiKeyProvider(acc.modelType)
  );
  const keysAccounts = readyAccounts.filter((acc) =>
    isApiKeyProvider(acc.modelType)
  );
  const planCount = planAccounts.length;
  const keysCount = keysAccounts.length;

  const compatibleSet = new Set(readyAccounts.map((acc) => acc.id));
  const incompatibleAccounts = showIncompatible
    ? accounts.filter(
        (acc) =>
          acc.status === "ready" && acc.hasKey && !compatibleSet.has(acc.id)
      )
    : [];
  const incompatibleCount = incompatibleAccounts.length;

  return (
    <div className="flex flex-col gap-1 border-t border-border-2 px-5 py-2 text-[11px] text-text-2">
      <div className="flex min-h-[20px] min-w-0 items-center gap-2">
        <CliCountDot count={planCount} />
        <span className="shrink-0 text-text-3">
          {t("selectors.spotlightFooter.planSupport")}:
        </span>
        <span className="shrink-0 tabular-nums">{planCount}</span>
        {planCount > 0 && (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide">
            {planAccounts.map((acc) => (
              <AccountChip key={acc.id} account={acc} />
            ))}
          </div>
        )}
      </div>
      <div className="flex min-h-[20px] min-w-0 items-center gap-2">
        <CliCountDot count={keysCount} />
        <span className="shrink-0 text-text-3">
          {t("selectors.spotlightFooter.byokSupport")}:
        </span>
        <span className="shrink-0 tabular-nums">{keysCount}</span>
        {keysCount > 0 && (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide">
            {keysAccounts.map((acc) => (
              <AccountChip key={acc.id} account={acc} />
            ))}
          </div>
        )}
      </div>
      {showIncompatible && incompatibleCount > 0 && (
        <div className="flex min-h-[20px] min-w-0 items-center gap-2 opacity-50">
          <StatusDot active={false} />
          <span className="shrink-0 text-text-4">
            {t("selectors.spotlightFooter.incompatible")}:
          </span>
          <span className="shrink-0 tabular-nums text-text-4">
            {incompatibleCount}
          </span>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide">
            {incompatibleAccounts.map((acc) => (
              <AccountChip key={acc.id} account={acc} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SpotlightAccountFooter;
