import { IDE_SERVER_HTTP_URL } from "@src/config/ideServer";

export const MAX_EDIT_LOG_SIZE = 100;
export const IDE_SERVER_URL = IDE_SERVER_HTTP_URL;
export const FILE_API_BASE_URL = `${IDE_SERVER_URL}/git/api/file`;
export const MAX_METADATA_CACHE_SIZE = 500;
export const MAX_LOADED_FILES_SIZE = 1000;
