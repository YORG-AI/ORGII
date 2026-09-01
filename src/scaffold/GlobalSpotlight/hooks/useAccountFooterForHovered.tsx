/**
 * useAccountFooterForHovered
 *
 * Given the currently-hovered palette item and a resolver that maps it to
 * either a CLI agent type or an API-provider account list, returns the
 * SpotlightAccountFooter node to render in SelectorScaffold.afterListSlot.
 *
 * Palettes pass in the hovered item + a resolver; the hook chooses the CLI
 * or API footer shape based on the resolver's discriminated return value.
 */
import React, { useMemo } from "react";

import type { KeyVaultAccount } from "@src/hooks/keyVault/types";

import { SpotlightAccountFooter } from "../components/SpotlightAccountFooter";
import type { SpotlightItem } from "../types";

interface AccountFooterCliResolverResult {
  mode: "cli";
  agentType: string;
  accounts: KeyVaultAccount[];
  showIncompatible?: boolean;
}

interface AccountFooterApiResolverResult {
  mode: "api";
  accounts: KeyVaultAccount[];
  showIncompatible?: boolean;
  incompatibleAccounts?: KeyVaultAccount[];
}

type AccountFooterResolverResult =
  | AccountFooterCliResolverResult
  | AccountFooterApiResolverResult
  | null;

interface UseAccountFooterForHoveredOptions {
  hoveredItem: SpotlightItem | undefined;
  resolve: (item: SpotlightItem) => AccountFooterResolverResult;
}

export function useAccountFooterForHovered(
  options: UseAccountFooterForHoveredOptions
): React.ReactNode | undefined {
  const { hoveredItem, resolve } = options;

  return useMemo(() => {
    if (!hoveredItem) return undefined;
    const resolved = resolve(hoveredItem);
    if (!resolved) return undefined;
    if (resolved.mode === "cli") {
      return (
        <SpotlightAccountFooter
          mode="cli"
          agentType={resolved.agentType}
          accounts={resolved.accounts}
          showIncompatible={resolved.showIncompatible}
        />
      );
    }
    return (
      <SpotlightAccountFooter
        mode="api"
        accounts={resolved.accounts}
        showIncompatible={resolved.showIncompatible}
        incompatibleAccounts={resolved.incompatibleAccounts}
      />
    );
  }, [hoveredItem, resolve]);
}
