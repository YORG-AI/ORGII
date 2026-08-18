/**
 * API Core Types
 *
 * Type definitions for the HTTP client layer.
 */
import type { ApiAuthFailure } from "./authFailure";

export type { ApiTarget } from "./authFailure";

// ============================================
// Response Types
// ============================================

/**
 * Standard API response wrapper
 * status: 0 = success, 1 = error
 */
export type DataField<T> = {
  status: number;
  data: T & { title?: string; message?: string };
};

// ============================================
// Error Types
// ============================================

export interface ApiErrorResponse {
  response?: {
    status: number;
    data: { detail?: string };
  };
}

// ============================================
// Request Types
// ============================================

export interface RequestOptions {
  onError?: () => void;
  onNoAuth?: (failure: ApiAuthFailure) => void;
  signal?: AbortSignal;
  captureId?: string;
  /** Request timeout in milliseconds (default: 30000 for most, extended for hosted-service target) */
  timeout?: number;
  /** Suppress error toast notifications (for best-effort operations like profile sync) */
  silent?: boolean;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
