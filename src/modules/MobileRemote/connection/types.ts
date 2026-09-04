/** Mobile wire protocol — shared types (no Tauri imports). */

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type DesktopPresence = "online" | "offline" | "unknown";

export type MobilePermissionTier = "full" | "read_only";

export interface MobileRemoteCapabilities {
  roundHistory?: boolean;
  /** Open an event-owned file in the paired Desktop app. */
  openSessionFile?: boolean;
  /** Session model picker backed by desktop KeyVault. */
  modelSelection?: boolean;
}

export interface MobileRpcError {
  code: number;
  message: string;
}

export interface MobileSessionModelConfig {
  sessionId: string;
  model?: string;
  accountId?: string;
  keySource?: string;
  cliAgentType?: string;
  modelEditable: boolean;
}

export interface MobileModelOption {
  id: string;
  accountId: string;
  accountLabel: string;
}

export interface MobileSessionModelState {
  config: MobileSessionModelConfig | null;
  options: MobileModelOption[];
  loading: boolean;
  patching: boolean;
  error?: string;
}

/** Image attachment sent with `session/send` (base64 data URL). */
export interface MobileSendAttachment {
  dataUrl: string;
  fileName?: string;
}

export interface InitializeResult {
  protocolVersion: number;
  desktopId?: string;
  desktopName?: string;
  orgiiVersion?: string;
  tier?: MobilePermissionTier;
  capabilities?: MobileRemoteCapabilities;
}

export interface MobileSessionRow {
  id: string;
  name: string;
  status: "running" | "idle" | "offline";
  category?: "live" | "cloud";
  sendCapability?: "native" | "external_codex" | "read_only";
  updatedAtMs?: number;
}

export interface MobileConnectionConfig {
  /** Full ws/wss URL, or host+port+token for Phase 0 LAN. */
  wsUrl?: string;
  host?: string;
  port?: number;
  token?: string;
  /** Phase 1 device credential embedded in the one-time desktop QR payload. */
  deviceToken?: string;
  /** Phase 1 pending pairing that becomes active after desktop SAS confirmation. */
  pairingCode?: string;
  desktopId?: string;
  deviceLabel?: string;
}

export interface MobileConnectionState {
  status: ConnectionStatus;
  presence: DesktopPresence;
  desktopId?: string;
  desktopName?: string;
  tier?: MobilePermissionTier;
  capabilities?: MobileRemoteCapabilities;
  error?: MobileRpcError;
  demoMode: boolean;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: MobileRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcInbound = JsonRpcResponse | JsonRpcNotification;

export function isJsonRpcResponse(
  message: JsonRpcInbound
): message is JsonRpcResponse {
  return "id" in message && message.id != null;
}
