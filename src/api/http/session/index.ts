/**
 * Session API Endpoints
 *
 * Hosted-key activity endpoints and URL-source helpers.
 */

// Hosted key activity API (for hosted ORGII sessions)
export {
  getHostedKeyCursor,
  getHostedKeyActivity,
  storeHostedKeyActivityBatch,
  compareStreamIds,
  hostedKeyActivityApi,
  type HostedKeyActivityEvent,
  type HostedKeyCursorData,
  type HostedKeyActivityChunk,
  type HostedKeyActivityListData,
  type HostedKeyActivityBatchRequest,
  type HostedKeyActivityBatchData,
} from "./hostedKey";

export {
  isHostedFromUrl,
  isHostedFromSearchParams,
  unifiedSessionApi,
} from "./unified";
