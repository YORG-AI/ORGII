/**
 * Agent Backend API
 *
 * Public HTTP methods targeting the agent backend server.
 */
import { captureApiCallStack } from "@src/util/monitoring/apiTracker";

import type { ApiAuthFailure } from "./authFailure";
import { makeDeleteRequest, makeRequest } from "./requestHandler";
import type { DataField } from "./types";

export async function getAgentApi<T>(
  url: string,
  params?: object,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void
): Promise<DataField<T> | undefined> {
  const captureId = captureApiCallStack();
  return makeRequest<T>("GET", url, "agent", params, {
    onError,
    onNoAuth,
    signal,
    captureId,
  });
}

export async function postAgentApi<T>(
  url: string,
  params?: object | string,
  _auth?: boolean,
  onError?: () => void,
  signal?: AbortSignal,
  onNoAuth?: (failure: ApiAuthFailure) => void,
  timeout?: number
): Promise<DataField<T> | undefined> {
  const captureId = captureApiCallStack();
  return makeRequest<T>("POST", url, "agent", params, {
    onError,
    onNoAuth,
    signal,
    captureId,
    timeout,
  });
}

export async function deleteAgentApi<T>(
  url: string,
  params?: object,
  _auth?: boolean,
  onError?: () => void
): Promise<DataField<T> | undefined> {
  const captureId = captureApiCallStack();
  return makeDeleteRequest<T>(url, "agent", params, { onError, captureId });
}
