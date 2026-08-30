/**
 * API Core - Main Export
 *
 * Centralized HTTP client infrastructure.
 * All API endpoints should import from here or from specific submodules.
 */

// ============================================
// Types
// ============================================

export type {
  ApiErrorResponse,
  ApiTarget,
  DataField,
  HttpMethod,
  RequestOptions,
} from "./types";

// ============================================
// Configuration
// ============================================

export {
  API_BASE_URLS,
  DEFAULT_TIMEOUT,
  ERROR_CONFIG,
  NOTIFICATION_DURATION,
  SERVER_ERROR_NOTIFICATION_DURATION,
} from "./config";

// ============================================
// Error Handling
// ============================================

export {
  buildErrorMessage,
  capitalize,
  showErrorNotification,
  showResponseErrorNotification,
  showServerErrorNotification,
  showWorkflowErrorNotification,
} from "./errorHandling";

// ============================================
// Token Management
// ============================================

export { getOrRefreshHostedToken } from "./tokenRefresh";

// ============================================
// HTTP Client Methods — Main Backend
// ============================================

export { deleteApi, getApi, patchApi, postApi, putApi } from "./mainApi";

// ============================================
// HTTP Client Methods — Agent Backend
// ============================================

export { deleteAgentApi, getAgentApi, postAgentApi } from "./agentApi";
