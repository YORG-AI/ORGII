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

export { capitalize } from "./errorHandling";

// ============================================
// Token Management
// ============================================

export { getOrRefreshHostedToken } from "./tokenRefresh";

// ============================================
// HTTP Client Methods — Main Backend
// ============================================

export { deleteApi, getApi, patchApi, postApi, putApi } from "./mainApi";
