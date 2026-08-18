/**
 * Hosted Service Backend API
 *
 * Proxied through Tauri's Rust backend to bypass WebView CORS restrictions.
 * All hosted-service HTTP calls go through the `hosted_service_proxy` Tauri
 * command, which forwards them to the ORGII hosted backend via reqwest (not
 * subject to CORS).
 */
import { invoke } from "@tauri-apps/api/core";

import { readIdentitySnapshot } from "@src/features/Identity/identitySnapshotAtom";
import { getActiveIdentitySession } from "@src/features/Identity/identityTypes";
import { createLogger } from "@src/hooks/logger";
import { getGlobalCommonHeaders } from "@src/util/config/headers";
import { captureApiCallStack } from "@src/util/monitoring/apiTracker";

import { type ApiAuthFailure, createApiAuthFailure } from "./authFailure";
import { NOTIFICATION_DURATION } from "./config";
import { showResponseErrorNotification } from "./errorHandling";
import { getOrRefreshHostedToken } from "./tokenRefresh";
import type { DataField, HttpMethod } from "./types";

const log = createLogger("API");

// ============================================
// Types
// ============================================

interface HostedServiceProxyRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  params?: object;
}

interface HostedServiceProxyResponse {
  status: number;
  data: unknown;
}

interface HostedServiceRequestOptions {
  onError?: () => void;
  onNoAuth?: (failure: ApiAuthFailure) => void;
  signal?: AbortSignal;
  silent?: boolean;
}

// ============================================
// Internal Helpers
// ============================================

async function buildHostedServiceHeaders(): Promise<Record<string, string>> {
  const headers = getGlobalCommonHeaders();

  const hostedToken = await getOrRefreshHostedToken();
  if (hostedToken) {
    headers.Authorization = `Bearer ${hostedToken}`;
  } else {
    delete headers.Authorization;
  }

  return headers;
}

function handleServiceAuthError(
  statusCode: number,
  detail: string | undefined,
  sessionId: string | null,
  onNoAuth?: (failure: ApiAuthFailure) => void
): DataField<never> | undefined {
  if (statusCode === 401) {
    log.warn(
      "[API] 401 Hosted-service token invalid - main session unaffected"
    );
    onNoAuth?.(createApiAuthFailure("hostedService", 401, detail, sessionId));
    return {
      status: 1,
      data: {
        title: "Authentication Required",
        message: detail || "Please log in to the hosted service first",
      },
    } as DataField<never>;
  }

  if (statusCode === 403) {
    if (detail === "Not authenticated" || detail === "Expired token") {
      log.warn("[API] 403 Hosted-service auth error:", detail);
      onNoAuth?.(createApiAuthFailure("hostedService", 403, detail, sessionId));
    }
    return {
      status: 1,
      data: {
        title: "Access Denied",
        message: detail || "You don't have permission to perform this action",
      },
    } as DataField<never>;
  }

  return undefined;
}

async function hostedServiceRequest<T>(
  method: HttpMethod,
  path: string,
  payload?: object | string,
  options: HostedServiceRequestOptions = {}
): Promise<DataField<T> | undefined> {
  const { onError, onNoAuth, signal } = options;
  captureApiCallStack();
  const requestSessionId =
    getActiveIdentitySession(readIdentitySnapshot(), "hosted_service_legacy")
      ?.sessionId ?? null;

  const headers = await buildHostedServiceHeaders();

  const request: HostedServiceProxyRequest = { method, path, headers };

  if (method === "GET") {
    if (payload) {
      request.params = payload as object;
    }
  } else if (payload) {
    request.body = typeof payload === "string" ? JSON.parse(payload) : payload;
  }

  if (signal?.aborted) {
    return undefined;
  }

  try {
    const response = await invoke<HostedServiceProxyResponse>(
      "hosted_service_proxy",
      { request }
    );

    const statusCode = response.status;
    const responseData = response.data as DataField<T> | undefined;

    if (statusCode >= 200 && statusCode < 300) {
      if (responseData && (responseData as DataField<T>).status === 1) {
        const errorData = (responseData as DataField<T>).data as {
          title?: string;
          message?: string;
        };
        const isExpectedError =
          errorData.title === "User Not Found" ||
          errorData.title === "Quota Refresh Failed" ||
          errorData.title === "Not Found" ||
          errorData.title === "Authentication Required" ||
          errorData.message?.includes("Provider account not found") ||
          errorData.message?.includes("Not authorized");
        if (!isExpectedError) {
          showResponseErrorNotification(
            errorData.title || "Error",
            errorData.message || "An error occurred",
            NOTIFICATION_DURATION
          );
        }
        onError?.();
        return responseData as DataField<T>;
      }
      return responseData as DataField<T>;
    }

    const errorBody = response.data as {
      detail?: string;
      message?: string;
    } | null;
    const detail = errorBody?.detail || errorBody?.message;

    const authResult = handleServiceAuthError(
      statusCode,
      detail,
      requestSessionId,
      onNoAuth
    );
    if (authResult) {
      onError?.();
      return authResult as DataField<T>;
    }

    if (statusCode === 400) {
      return {
        status: 1,
        data: {
          title: "Validation Error",
          message: detail || "Bad request",
        },
      } as DataField<T>;
    }

    if (statusCode === 404) {
      return {
        status: 1,
        data: {
          title: "Not Found",
          message: detail || "Resource not found",
        },
      } as DataField<T>;
    }

    if (statusCode === 500) {
      log.error(`API ${method} 500 error [${path}]:`, response.data);
      onError?.();
      return undefined;
    }

    log.error(
      `Hosted service API error (${statusCode}) [${path}]:`,
      detail || "Unknown error",
      response.data
    );
    onError?.();
    return undefined;
  } catch (error) {
    if (signal?.aborted) {
      return undefined;
    }

    const errorStr = String(error);
    if (errorStr.includes("timeout")) {
      log.error(`API ${method} timeout [${path}]:`, error);
      onError?.();
      return undefined;
    }

    log.error(`API ${method} error [${path}]:`, error);
    onError?.();
    return undefined;
  }
}

// ============================================
// Public API
// ============================================

export async function getHostedServiceApi<T>(
  url: string,
  params?: object,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void,
  silent?: boolean
): Promise<DataField<T> | undefined> {
  return hostedServiceRequest<T>("GET", url, params, {
    onError,
    onNoAuth,
    signal,
    silent,
  });
}

export async function postHostedServiceApi<T>(
  url: string,
  params?: object | string,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void
): Promise<DataField<T> | undefined> {
  return hostedServiceRequest<T>("POST", url, params, {
    onError,
    onNoAuth,
    signal,
  });
}

export async function putHostedServiceApi<T>(
  url: string,
  params?: object | string,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void,
  silent?: boolean
): Promise<DataField<T> | undefined> {
  return hostedServiceRequest<T>("PUT", url, params, {
    onError,
    onNoAuth,
    signal,
    silent,
  });
}

export async function deleteHostedServiceApi<T>(
  url: string,
  params?: object,
  _auth?: boolean,
  onError?: () => void
): Promise<DataField<T> | undefined> {
  return hostedServiceRequest<T>("DELETE", url, params, { onError });
}

export async function patchHostedServiceApi<T>(
  url: string,
  params?: object | string,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void
): Promise<DataField<T> | undefined> {
  return hostedServiceRequest<T>("PATCH", url, params, {
    onError,
    onNoAuth,
    signal,
  });
}
