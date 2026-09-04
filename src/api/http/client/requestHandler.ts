/**
 * Request Handler
 *
 * Core HTTP request logic with error handling, auth token injection,
 * and status-code-specific response mapping.
 */
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import { recordDiagnosticsHttp } from "@src/diagnostics/runtimeCounters";
import { createLogger } from "@src/hooks/logger";
import { triggerSessionExpired } from "@src/store/ui/uiAtom";
import { getGlobalCommonHeaders } from "@src/util/config/headers";

import {
  API_BASE_URLS,
  DEFAULT_TIMEOUT,
  ERROR_CONFIG,
  NOTIFICATION_DURATION,
} from "./config";
import {
  buildErrorMessage,
  showErrorNotification,
  showResponseErrorNotification,
  showServerErrorNotification,
  showTimeoutErrorNotification,
  showWorkflowErrorNotification,
} from "./errorHandling";
import type {
  ApiErrorResponse,
  ApiTarget,
  DataField,
  HttpMethod,
  RequestOptions,
} from "./types";

const log = createLogger("API");

/**
 * Unified API request handler that processes all HTTP methods
 */
export async function makeRequest<T>(
  method: HttpMethod,
  url: string,
  target: ApiTarget,
  payload?: object | string,
  options: RequestOptions = {}
): Promise<DataField<T> | undefined> {
  const { onError, onNoAuth, signal, captureId, timeout, silent } = options;
  const headers = getGlobalCommonHeaders();

  const baseUrl = API_BASE_URLS[target];
  const fullUrl = baseUrl + url;
  const isAgentApi = target === "agent";

  const config: AxiosRequestConfig & { __captureId?: string } = {
    method,
    url: fullUrl,
    headers,
    signal,
    timeout: timeout ?? DEFAULT_TIMEOUT,
    __captureId: captureId,
  };

  if (method === "GET") {
    config.params = payload;
  } else {
    config.data = payload;
  }

  const diagnosticsStart = performance.now();
  let diagnosticsOk = false;

  try {
    const response: AxiosResponse<DataField<T>> = await axios(config);
    diagnosticsOk = response.data.status !== 1;

    if (response.data.status === 1) {
      const errorData = response.data.data as {
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
      return response.data;
    }

    return response.data;
  } catch (error) {
    if (axios.isCancel(error)) {
      return undefined;
    }

    const axiosError = error as { code?: string; message?: string };
    if (
      axiosError.code === "ECONNABORTED" ||
      axiosError.message?.includes("timeout")
    ) {
      log.error(`API ${method} timeout [${url}]:`, error);
      showTimeoutErrorNotification();
      onError?.();
      return undefined;
    }

    const typedError = error as ApiErrorResponse;
    const status = typedError.response?.status;

    if (status === 500) {
      const isWorkflowApi = url.includes("/workflows");
      if (isWorkflowApi) {
        showWorkflowErrorNotification();
      } else {
        if (ERROR_CONFIG.redirectOn500) {
          window.location.href = "/";
        } else {
          showServerErrorNotification(url, method, isAgentApi);
        }
      }
      log.error(`API ${method} 500 error [${url}]:`, typedError.response);
      onError?.();
      return undefined;
    }

    if (status === 401) {
      const errorData = typedError.response?.data as
        | { detail?: string; message?: string }
        | undefined;
      const detail = errorData?.detail || errorData?.message;

      log.error("[API] 401 Unauthorized - Session expired or invalid token");
      triggerSessionExpired();
      onNoAuth?.();

      return {
        status: 1,
        data: {
          title: "Authentication Required",
          message: detail || "Please log in first",
        },
      } as DataField<T>;
    }

    if (status === 400) {
      const errorData = typedError.response?.data as
        | { detail?: string; message?: string }
        | undefined;
      const detail = errorData?.detail || errorData?.message;
      return {
        status: 1,
        data: {
          title: "Validation Error",
          message: detail || "Bad request",
        },
      } as DataField<T>;
    }

    if (status === 403) {
      const errorData = typedError.response?.data as
        | { detail?: string; message?: string }
        | undefined;
      const detail = errorData?.detail || errorData?.message;
      if (detail === "Not authenticated" || detail === "Expired token") {
        log.error("[API] 403 Forbidden - Session expired:", detail);
        triggerSessionExpired();
        onNoAuth?.();
      }
      return {
        status: 1,
        data: {
          title: "Access Denied",
          message: detail || "You don't have permission to perform this action",
        },
      } as DataField<T>;
    }

    if (status === 404) {
      const errorData = typedError.response?.data as
        | { detail?: string; message?: string }
        | undefined;
      const detail = errorData?.detail || errorData?.message;
      return {
        status: 1,
        data: {
          title: "Not Found",
          message: detail || "Resource not found",
        },
      } as DataField<T>;
    }

    const errorMessage = buildErrorMessage(typedError, method, url);
    if (!silent) {
      showErrorNotification(url, errorMessage, method, isAgentApi);
    }
    log.error(`API ${method} error [${url}]:`, typedError.response);
    onError?.();
    return undefined;
  } finally {
    recordDiagnosticsHttp(
      target,
      performance.now() - diagnosticsStart,
      diagnosticsOk
    );
  }
}

/**
 * Special handler for DELETE requests with query parameters
 */
export async function makeDeleteRequest<T>(
  url: string,
  target: ApiTarget,
  params?: object,
  options: RequestOptions = {}
): Promise<DataField<T> | undefined> {
  const { onError, onNoAuth, captureId } = options;
  const headers = getGlobalCommonHeaders();

  const baseUrl = API_BASE_URLS[target];
  const isAgentApi = target === "agent";
  const fullUrl = baseUrl + url;
  const diagnosticsStart = performance.now();
  let diagnosticsOk = false;

  try {
    const response: AxiosResponse<DataField<T>> = await axios.delete(fullUrl, {
      headers,
      params,
      __captureId: captureId,
    } as AxiosRequestConfig & { __captureId?: string });
    diagnosticsOk = response.data.status !== 1;

    if (response.data.status === 1) {
      showResponseErrorNotification(
        response.data.data.title,
        response.data.data.message,
        NOTIFICATION_DURATION
      );
      onError?.();
      return undefined;
    }

    return response.data;
  } catch (error) {
    const typedError = error as ApiErrorResponse;
    const status = typedError.response?.status;

    if (status === 401) {
      const detail = typedError.response?.data?.detail;
      log.error("[API DELETE] 401 Unauthorized - Session expired");
      triggerSessionExpired();
      return {
        status: 1,
        data: { message: detail || "Authentication required" },
      } as DataField<T>;
    }

    if (status === 403) {
      const detail = typedError.response?.data?.detail;
      if (detail === "Not authenticated" || detail === "Expired token") {
        log.error("[API DELETE] 403 Forbidden - Session expired:", detail);
        triggerSessionExpired();
        onNoAuth?.();
      }
      return {
        status: 1,
        data: { message: detail },
      } as DataField<T>;
    }

    if (status === 500) {
      if (ERROR_CONFIG.redirectOn500) {
        window.location.href = "/";
      } else {
        showServerErrorNotification(url, "DELETE", isAgentApi);
      }
      log.error(`API DELETE 500 error [${url}]:`, typedError.response);
      onError?.();
      return undefined;
    }

    const errorMessage = buildErrorMessage(typedError, "DELETE", url);
    showErrorNotification(url, errorMessage, "DELETE", isAgentApi);
    log.error(`API DELETE error [${url}]:`, typedError.response);
    onError?.();
    return undefined;
  } finally {
    recordDiagnosticsHttp(
      target,
      performance.now() - diagnosticsStart,
      diagnosticsOk
    );
  }
}
