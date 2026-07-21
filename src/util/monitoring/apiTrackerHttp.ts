import axios, { AxiosResponse, InternalAxiosRequestConfig } from "axios";

import { detectInteractionType } from "./apiTrackerInteractions";
import {
  addApiCall,
  dispatchApiCallUpdatedIfTracing,
  findApiCall,
  finishRequestTiming,
  isTrackingEnabled,
  startRequestTiming,
} from "./apiTrackerState";
import type { ApiCall } from "./apiTrackerTypes";
import {
  extractFileInfo,
  generateRequestId,
  getApiStack,
  getComponentInfo,
} from "./apiTrackerUtils";

interface TrackedAxiosConfig extends InternalAxiosRequestConfig {
  __requestId?: string;
  __captureId?: string;
}

const pendingCallInfo = new Map<
  string,
  {
    stack: string;
    fileInfo: ReturnType<typeof extractFileInfo>;
    componentInfo: ReturnType<typeof getComponentInfo>;
  }
>();

function getHttpStack(): string {
  return getApiStack()
    .split("\n")
    .filter((line) => !line.includes("apiTrackerHttp.ts"))
    .join("\n");
}

/**
 * Capture API call stack at the point of calling the API function.
 * This should be called from apiConfig.ts before the axios request is made.
 * Returns a capture ID that should be passed to the axios config.
 */
export const captureApiCallStack = (): string => {
  const captureId = `capture-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

  if (!isTrackingEnabled()) return captureId;

  const stack = getHttpStack();
  const fileInfo = extractFileInfo(stack);
  const componentInfo = getComponentInfo();

  pendingCallInfo.set(captureId, { stack, fileInfo, componentInfo });

  setTimeout(() => {
    pendingCallInfo.delete(captureId);
  }, 5000);

  return captureId;
};

let interceptorsInitialized = false;

export const initializeApiTracking = (): (() => void) | undefined => {
  if (interceptorsInitialized || typeof window === "undefined") {
    return undefined;
  }

  const requestInterceptor = axios.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      if (!isTrackingEnabled()) return config;

      const requestId = generateRequestId();
      startRequestTiming(requestId);
      (config as TrackedAxiosConfig).__requestId = requestId;

      const captureId = (config as TrackedAxiosConfig).__captureId ?? "";
      const preCaptured = pendingCallInfo.get(captureId);
      if (preCaptured) pendingCallInfo.delete(captureId);

      const componentInfo = preCaptured?.componentInfo || getComponentInfo();
      const stack = preCaptured?.stack || getHttpStack();
      const fileInfo = preCaptured?.fileInfo || extractFileInfo(stack);

      const apiCall: ApiCall = {
        id: requestId,
        method: (config.method || "GET").toUpperCase(),
        url: config.url || "",
        fullUrl: config.baseURL
          ? `${config.baseURL}${config.url}`
          : config.url || "",
        transport: "http",
        headers: config.headers as Record<string, string>,
        params: config.params,
        data: config.data,
        timestamp: new Date().toISOString(),
        componentSelector: componentInfo.selector,
        componentLabel: componentInfo.label,
        interactionType: detectInteractionType(),
        filePath: fileInfo.filePath,
        componentName: fileInfo.componentName,
        functionName: fileInfo.functionName,
        lineNumber: fileInfo.lineNumber,
        stack,
      };

      addApiCall(apiCall);
      dispatchApiCallUpdatedIfTracing(apiCall);

      return config;
    },
    (error) => Promise.reject(error)
  );

  const responseInterceptor = axios.interceptors.response.use(
    (response: AxiosResponse) => {
      if (!isTrackingEnabled()) return response;

      const requestId = (response.config as TrackedAxiosConfig).__requestId;
      if (requestId) {
        const duration = finishRequestTiming(requestId);
        const apiCall = findApiCall(requestId);
        if (apiCall) {
          apiCall.status = response.status;
          apiCall.statusText = response.statusText;
          apiCall.response = response.data;
          apiCall.duration = duration;
          dispatchApiCallUpdatedIfTracing(apiCall);
        }
      }

      return response;
    },
    (error) => {
      if (!isTrackingEnabled()) return Promise.reject(error);

      const requestId = (error.config as TrackedAxiosConfig | undefined)
        ?.__requestId;
      if (requestId) {
        const duration = finishRequestTiming(requestId);
        const apiCall = findApiCall(requestId);
        if (apiCall) {
          apiCall.status = error.response?.status;
          apiCall.statusText = error.response?.statusText;
          apiCall.error = error.response?.data || error.message;
          apiCall.duration = duration;
          dispatchApiCallUpdatedIfTracing(apiCall);
        }
      }

      return Promise.reject(error);
    }
  );

  interceptorsInitialized = true;

  return () => {
    axios.interceptors.request.eject(requestInterceptor);
    axios.interceptors.response.eject(responseInterceptor);
    interceptorsInitialized = false;
  };
};

let fetchTrackingPatched = false;

function describeFetchTarget(input: RequestInfo | URL): {
  url: string;
  method?: string;
} {
  if (typeof input === "string") return { url: input };
  if (input instanceof URL) return { url: input.href };
  return { url: input.url, method: input.method };
}

function isFetchNoise(url: string): boolean {
  return url.includes("hot-update") || url.includes("__webpack");
}

export function installFetchTracking(): (() => void) | undefined {
  if (fetchTrackingPatched || typeof window === "undefined") return undefined;

  const originalFetch = window.fetch.bind(window);

  const patchedFetch: typeof window.fetch = async (input, init) => {
    const target = describeFetchTarget(input as RequestInfo | URL);
    if (!isTrackingEnabled() || isFetchNoise(target.url)) {
      return originalFetch(input, init);
    }

    const requestId = generateRequestId();
    const stack = getHttpStack();
    const fileInfo = extractFileInfo(stack);
    const componentInfo = getComponentInfo();
    const method = (init?.method || target.method || "GET").toUpperCase();

    const apiCall: ApiCall = {
      id: requestId,
      method,
      url: target.url,
      fullUrl: target.url,
      transport: "http",
      data: init?.body,
      timestamp: new Date().toISOString(),
      componentSelector: componentInfo.selector,
      componentLabel: componentInfo.label,
      interactionType: detectInteractionType(),
      filePath: fileInfo.filePath,
      componentName: fileInfo.componentName,
      functionName: fileInfo.functionName,
      lineNumber: fileInfo.lineNumber,
      stack,
    };
    addApiCall(apiCall);
    startRequestTiming(requestId);

    const finish = (status?: number, statusText?: string, error?: unknown) => {
      apiCall.duration = finishRequestTiming(requestId);
      apiCall.status = status;
      apiCall.statusText = statusText;
      if (error !== undefined) apiCall.error = error;
      dispatchApiCallUpdatedIfTracing(apiCall);
    };

    try {
      const response = await originalFetch(input, init);
      finish(response.status, response.statusText);
      return response;
    } catch (error) {
      finish(undefined, "Network Error", error);
      throw error;
    }
  };

  try {
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: patchedFetch,
      writable: true,
    });
  } catch {
    return undefined;
  }
  fetchTrackingPatched = true;

  return () => {
    try {
      Object.defineProperty(window, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
      });
    } finally {
      fetchTrackingPatched = false;
    }
  };
}

export function clearPendingHttpTrackingState(): void {
  pendingCallInfo.clear();
}

interface TrackedXmlHttpRequest {
  method: string;
  url: string;
}

let xmlHttpRequestTrackingPatched = false;

/** Axios uses XMLHttpRequest internally in the WebView and is already covered
 * by the richer Axios interceptors above. Ignore those internal XHRs so the
 * same request does not appear twice. */
function isAxiosXmlHttpRequest(stack: string): boolean {
  return (
    stack.includes("node_modules/axios") ||
    stack.includes("axios/lib/") ||
    stack.includes("dispatchXhrRequest")
  );
}

/** Track direct XMLHttpRequest traffic (currently used by file uploads).
 * Installed only while the API panel is open. */
export function installXmlHttpRequestTracking(): (() => void) | undefined {
  if (
    xmlHttpRequestTrackingPatched ||
    typeof window === "undefined" ||
    typeof window.XMLHttpRequest === "undefined"
  ) {
    return undefined;
  }

  const prototype = window.XMLHttpRequest.prototype;
  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const requests = new WeakMap<XMLHttpRequest, TrackedXmlHttpRequest>();
  const callOriginalOpen = originalOpen as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) => void;

  prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null
  ): void {
    requests.set(this, { method: method.toUpperCase(), url: String(url) });
    callOriginalOpen.call(this, method, url, async, username, password);
  } as XMLHttpRequest["open"];

  prototype.send = function patchedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const request = requests.get(this);
    if (!isTrackingEnabled() || !request) {
      originalSend.call(this, body);
      return;
    }

    const rawStack = new Error().stack || "";
    if (isAxiosXmlHttpRequest(rawStack)) {
      originalSend.call(this, body);
      return;
    }

    const stack = getHttpStack();
    const requestId = `xhr-${generateRequestId()}`;
    const fileInfo = extractFileInfo(stack);
    const componentInfo = getComponentInfo();
    const apiCall: ApiCall = {
      id: requestId,
      method: request.method,
      url: request.url,
      fullUrl: request.url,
      transport: "http",
      data: body,
      timestamp: new Date().toISOString(),
      componentSelector: componentInfo.selector,
      componentLabel: componentInfo.label,
      interactionType: detectInteractionType(),
      filePath: fileInfo.filePath,
      componentName: fileInfo.componentName,
      functionName: fileInfo.functionName,
      lineNumber: fileInfo.lineNumber,
      stack,
    };

    addApiCall(apiCall);
    startRequestTiming(requestId);
    dispatchApiCallUpdatedIfTracing(apiCall);

    const finish = (): void => {
      if (apiCall.duration !== undefined) return;
      apiCall.duration = finishRequestTiming(requestId);
      apiCall.status = this.status || undefined;
      apiCall.statusText = this.statusText || undefined;
      if (this.status >= 400 || this.status === 0) {
        apiCall.error = this.statusText || "XMLHttpRequest failed";
      } else if (this.responseType === "" || this.responseType === "text") {
        apiCall.response = this.responseText;
      } else {
        apiCall.response = this.response;
      }
      dispatchApiCallUpdatedIfTracing(apiCall);
    };

    this.addEventListener("loadend", finish, { once: true });
    originalSend.call(this, body);
  };

  xmlHttpRequestTrackingPatched = true;

  return () => {
    prototype.open = originalOpen;
    prototype.send = originalSend;
    xmlHttpRequestTrackingPatched = false;
  };
}
