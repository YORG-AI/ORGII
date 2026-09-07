import type { McpConfigScope } from "@src/api/tauri/rpc/schemas/mcp";
import type {
  McpResource,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  McpToolDef,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";

export interface McpDetailState {
  addMode: boolean;
  /** Scope to pre-select when opening the Add wizard from a section button. */
  addScope: McpConfigScope;
  onAddClose: () => void;
  editName: string | null;
  editConfig: McpServerConfig | null;
  onSave: (
    name: string,
    config: McpServerConfig,
    scope: McpConfigScope
  ) => Promise<void>;
  onTest: (
    name: string,
    config: McpServerConfig,
    scope: McpConfigScope
  ) => Promise<McpTestResult>;
  servers: McpServerStatus[];
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  tools: McpToolDef[];
  toolsLoading: boolean;
  resources: McpResource[];
  resourcesLoading: boolean;
  onReconnect: (name: string) => Promise<void>;
  onEdit: (name: string) => void;
  onDelete: (
    name: string,
    scope: McpServerStatus["scope"]
  ) => Promise<boolean> | boolean;
  onFetchTools: (name: string) => void;
  onFetchResources: (name: string) => void;
  /** Toggle a single server's `disabled` flag. Backend kills the child
   * process when `disabled=true` and respawns when `false`. */
  onSetDisabled: (name: string, disabled: boolean) => Promise<void>;
  /** Bulk version. Returns `{ name: error|null }`. */
  onBulkSetDisabled: (
    names: string[],
    disabled: boolean
  ) => Promise<Record<string, string | null>>;
  /** Bulk reconnect. Skips disabled rows server-side. */
  onBulkReconnect: (names: string[]) => Promise<Record<string, string | null>>;
}
