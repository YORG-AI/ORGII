/**
 * useUnifiedModelPaletteData — Data loading and pure config helpers for the unified model palette.
 *
 * Extracted to keep useUnifiedModelPalette.tsx under the 600-line limit.
 * Owns: account loading + filtering, ORGII pool categories, account lookup,
 * recent model entry tracking.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import type { DispatchCategory } from "@src/api/tauri/session";
import Message from "@src/components/Message";
import {
  type KeyVaultAccount,
  type UseKeyVaultReturn,
  useKeyVault,
} from "@src/hooks/keyVault";
import { withNativeHarnessModels } from "@src/hooks/models/nativeHarnessAccountModels";
import {
  getCliCompatibleAccounts,
  useAgentCompatibility,
} from "@src/hooks/models/useAgentCompatibility";
import { buildAccountLookup } from "@src/hooks/models/useModelAccountLookup";
import { useOrgiiPoolCategories } from "@src/hooks/models/useOrgiiPoolCategories";
import {
  formatRefreshSummary,
  refreshSummaryTone,
} from "@src/modules/MainApp/Integrations/KeyVault/hooks/refreshAccountModels";
import {
  cliAgentTypeAtom,
  dispatchCategoryAtom,
} from "@src/store/session/creatorStateAtom";
import {
  type RecentModelEntry,
  recentModelEntriesAtom,
  recordRecentEntry,
} from "@src/store/session/recentModelEntriesAtom";

import { refreshModelAccounts } from "./modelAccountRefresh";

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseUnifiedModelPaletteDataOptions {
  isOpen: boolean;
  /**
   * When provided, overrides the dispatch category read from the creator atom.
   * Used by ModelPill in an active session so the palette filters accounts
   * for the session's own agent type, not the creator's last selection.
   */
  dispatchCategoryOverride?: DispatchCategory;
  /**
   * When provided, overrides the CLI agent type read from the creator atom.
   * Paired with `dispatchCategoryOverride`.
   */
  cliAgentTypeOverride?: CliAgentType;
}

export interface UnifiedModelPaletteData {
  accounts: KeyVaultAccount[];
  accountLookup: ReturnType<typeof buildAccountLookup>;
  orgiiCategories: ReturnType<typeof useOrgiiPoolCategories>["orgiiCategories"];
  orgiiModelSet: ReturnType<typeof useOrgiiPoolCategories>["orgiiModelSet"];
  orgiiCategoryIds: ReturnType<
    typeof useOrgiiPoolCategories
  >["orgiiCategoryIds"];
  orgiiPoolEnabled: boolean;
  dispatchCategory: string | null;
  cliAgentType: string | null;
  recentEntries: RecentModelEntry[];
  recordRecent: (entry: RecentModelEntry) => void;
  /**
   * Persist key edits (e.g. per-account default variants from the
   * variant pill). Exposed from the same `useKeyVault` instance that
   * supplies `accounts` so optimistic state updates after `saveKey`
   * actually flow back into this palette's account list — using a
   * second `useKeyVault()` would give us a parallel local-state copy
   * that never refreshes until the palette is reopened.
   */
  saveKey: UseKeyVaultReturn["saveKey"];
  /** True while the persisted Key Vault account list is loading. */
  accountsLoading: boolean;
  /** Account-list load failure, if the last attempt failed. */
  accountsError: string | null;
  /** Refresh available models for every loaded account. */
  refreshAllModels: () => Promise<void>;
  /** True while {@link refreshAllModels} is running. */
  refreshingAllModels: boolean;
}

export function useUnifiedModelPaletteData({
  isOpen,
  dispatchCategoryOverride,
  cliAgentTypeOverride,
}: UseUnifiedModelPaletteDataOptions): UnifiedModelPaletteData {
  const creatorDispatchCategory = useAtomValue(dispatchCategoryAtom);
  const creatorCliAgentType = useAtomValue(cliAgentTypeAtom);
  const { registry } = useAgentCompatibility();
  const { t } = useTranslation("integrations");

  // Prefer caller-supplied overrides (in-session model pill) over the creator
  // atom values. Without this, opening the Model palette from inside a Claude
  // Code session would read dispatchCategory="rust_agent" (or whatever the
  // creator last had) and show "No items available" because no accounts pass
  // the getCliCompatibleAccounts filter.
  const dispatchCategory = dispatchCategoryOverride ?? creatorDispatchCategory;
  const cliAgentType = cliAgentTypeOverride ?? creatorCliAgentType;

  const orgiiPoolEnabled = dispatchCategory !== "cli_agent";

  const {
    accounts: allAccounts,
    saveKey,
    refresh,
    loading: accountsLoading,
    error: accountsError,
  } = useKeyVault({ autoLoad: isOpen });

  const [refreshingAllModels, setRefreshingAllModels] = useState(false);

  const accounts = useMemo(() => {
    if (dispatchCategory === "cli_agent" && cliAgentType) {
      return getCliCompatibleAccounts(registry, cliAgentType, allAccounts);
    }

    return withNativeHarnessModels(allAccounts, dispatchCategory);
  }, [dispatchCategory, cliAgentType, allAccounts, registry]);

  const { orgiiCategories, orgiiModelSet, orgiiCategoryIds } =
    useOrgiiPoolCategories();

  const accountLookup = useMemo(() => buildAccountLookup(accounts), [accounts]);

  const recentEntries = useAtomValue(recentModelEntriesAtom);
  const setRecentEntries = useSetAtom(recentModelEntriesAtom);

  const recordRecent = useCallback(
    (entry: RecentModelEntry) => {
      setRecentEntries((prev) => recordRecentEntry(prev, entry));
    },
    [setRecentEntries]
  );

  const refreshAllModels = useCallback(async () => {
    setRefreshingAllModels(true);
    try {
      const summary = await refreshModelAccounts(allAccounts, refresh);
      if (summary) {
        Message[refreshSummaryTone(summary)](
          formatRefreshSummary(summary, t),
          5000
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      Message.error(
        t("keyVault.toasts.refreshError", { name: "Models", error: detail }),
        5000
      );
    } finally {
      setRefreshingAllModels(false);
    }
  }, [allAccounts, refresh, t]);

  return {
    accounts,
    accountLookup,
    orgiiCategories,
    orgiiModelSet,
    orgiiCategoryIds,
    orgiiPoolEnabled,
    dispatchCategory,
    cliAgentType,
    recentEntries,
    recordRecent,
    saveKey,
    accountsLoading,
    accountsError,
    refreshAllModels,
    refreshingAllModels,
  };
}
