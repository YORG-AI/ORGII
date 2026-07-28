/**
 * Local IDE server (the Rust HTTP server inside this app) endpoint config.
 *
 * Webpack's env value is the browser/test fallback. Desktop startup replaces
 * it from the identifier embedded in the running Tauri binary before the App
 * module graph is loaded, so a directly launched isolated executable always
 * talks to its own backend.
 */
import { runtimeInstanceProfileForIdentifier } from "./runtimeInstance";

export let IDE_SERVER_PORT = process.env.ORGII_IDE_SERVER_PORT ?? "13847";

export let IDE_SERVER_HTTP_URL = `http://localhost:${IDE_SERVER_PORT}`;

export let IDE_SERVER_WS_URL = `ws://localhost:${IDE_SERVER_PORT}/ws`;

export function configureIdeServerForIdentifier(identifier: string): number {
  const { ideServerPort } = runtimeInstanceProfileForIdentifier(identifier);
  IDE_SERVER_PORT = String(ideServerPort);
  IDE_SERVER_HTTP_URL = `http://localhost:${IDE_SERVER_PORT}`;
  IDE_SERVER_WS_URL = `ws://localhost:${IDE_SERVER_PORT}/ws`;
  return ideServerPort;
}
