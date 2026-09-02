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
}

export interface MobileRpcError {
  code: number;
  message: string;
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

/** Sanitized local pairing metadata; credentials remain inside platform storage. */
export interface MobilePairedDesktopSummary {
  id: string;
  name: string;
  active: boolean;
  updatedAtMs: number;
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
