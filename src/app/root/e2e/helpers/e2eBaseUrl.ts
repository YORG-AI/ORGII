import { IDE_SERVER_PORT } from "@src/config/ideServer";

const DEFAULT_E2E_BASE_URL = `http://127.0.0.1:${IDE_SERVER_PORT}`;
const E2E_BASE_URL_STORAGE_KEY = "orgii:e2eBaseUrl";

export function e2eBaseUrl(): string {
  if (typeof window !== "undefined") {
    const runtimeBaseUrl = window.localStorage.getItem(
      E2E_BASE_URL_STORAGE_KEY
    );
    if (runtimeBaseUrl) return runtimeBaseUrl;
  }
  return process.env.E2E_BASE_URL ?? DEFAULT_E2E_BASE_URL;
}

export function e2eUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${e2eBaseUrl()}${normalizedPath}`;
}
