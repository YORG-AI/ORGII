import type { AvailableAgent } from "@src/config/cliAgents";
import type { KeyVaultAccount } from "@src/hooks/keyVault";

export const CLI_CLIENT_INLINE_TAB = {
  STATUS: "status",
  SUBSCRIPTIONS: "subscriptions",
  CLIENT: "client",
} as const;

export type CliClientInlineTab =
  (typeof CLI_CLIENT_INLINE_TAB)[keyof typeof CLI_CLIENT_INLINE_TAB];

export interface CliAgentsHandlers {
  actionMap: Record<string, "installing" | "detecting" | null>;
  handleInstall: (agentName: string, installCmd?: string) => Promise<void>;
  handleUninstall: (agentName: string, uninstallCmd?: string) => Promise<void>;
}

export interface CliClientInlineExpandedCardProps {
  agent: AvailableAgent;
  accounts: KeyVaultAccount[];
  activeTab: CliClientInlineTab;
  onActiveTabChange: (tab: CliClientInlineTab) => void;
  onRefresh?: () => Promise<void>;
  refreshing?: boolean;
  onAdd?: () => void;
  cliAgents?: CliAgentsHandlers;
}
