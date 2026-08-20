import { IDE_SERVER_HTTP_URL } from "@src/config/ideServer";

export const MAX_EDIT_LOG_SIZE = 100;
export const IDE_SERVER_URL = IDE_SERVER_HTTP_URL;
export const FILE_API_BASE_URL = `${IDE_SERVER_URL}/git/api/file`;
export const MAX_METADATA_CACHE_SIZE = 500;
export const MAX_LOADED_FILES_SIZE = 1000;

/**
 * Soft cap on `unsavedContentCache` entries. Entries hold a full copy of the
 * buffer text, so without a cap every dirty file ever switched away from is
 * retained for the app lifetime. Only *clean* entries (buffer equal to disk
 * at cache time) are evicted past this cap; dirty entries always survive.
 */
export const MAX_UNSAVED_CONTENT_CACHE_SIZE = 32;
