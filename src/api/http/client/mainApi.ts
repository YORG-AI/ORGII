/**
 * Main Backend API
 *
 * Public HTTP methods targeting the main backend server.
 */
import { captureApiCallStack } from "@src/util/monitoring/apiTracker";

import type { ApiAuthFailure } from "./authFailure";
import { makeDeleteRequest, makeRequest } from "./requestHandler";
import type { DataField } from "./types";

export async function getApi<T>(
  url: string,
  params?: object,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void
): Promise<DataField<T> | undefined> {
  const captureId = captureApiCallStack();
  return makeRequest<T>("GET", url, "main", params, {
    onError,
    onNoAuth,
    signal,
    captureId,
  });
}

export async function postApi<T>(
  url: string,
  params?: object | string,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void
): Promise<DataField<T> | undefined> {
  const captureId = captureApiCallStack();
  return makeRequest<T>("POST", url, "main", params, {
    onError,
    onNoAuth,
    signal,
    captureId,
  });
}

export async function putApi<T>(
  url: string,
  params?: object | string,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void
): Promise<DataField<T> | undefined> {
  const captureId = captureApiCallStack();
  return makeRequest<T>("PUT", url, "main", params, {
    onError,
    onNoAuth,
    signal,
    captureId,
  });
}

export async function patchApi<T>(
  url: string,
  params?: object | string,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void
): Promise<DataField<T> | undefined> {
  const captureId = captureApiCallStack();
  return makeRequest<T>("PATCH", url, "main", params, {
    onError,
    onNoAuth,
    signal,
    captureId,
  });
}

export async function deleteApi<T>(
  url: string,
  params?: object,
  _auth?: boolean,
  onError?: () => void
): Promise<DataField<T> | undefined> {
  const captureId = captureApiCallStack();
  return makeDeleteRequest<T>(url, "main", params, { onError, captureId });
}
