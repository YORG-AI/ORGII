/**
 * API Layer
 *
 * Organized by transport + domain:
 * - http/     - REST endpoints (Axios)
 * - tauri/    - Tauri IPC commands (invoke)
 * - realtime/ - WebSocket + SSE streaming
 * - services/ - Stateful facades (key validation, notifications)
 * - types/    - Shared API types
 *
 * @see ./api_organization.md
 */

// Typed RPC layer (Zod-validated Tauri IPC) — the blessed standard
export { rpc } from "./tauri/rpc";

// Shared API types
export type {
  ModelType,
  AuthMethod,
  HealthStatus,
  KeyInfo,
  SaveKeyRequest,
  FullKeyResponse,
  KeysListResponse,
  DetectedKey,
  AutoDetectResponse,
  QuotaInfo,
  ValidateKeyResponse,
} from "./types/keys";
