/**
 * Local IDE server (the Rust HTTP server inside this app) endpoint config.
 *
 * The port is baked at BUILD time via webpack DefinePlugin from the
 * `ORGII_IDE_SERVER_PORT` env var (default 13847 — see api/server.rs). A
 * second app instance (dual-instance cloud-collab testing) is built with a
 * different port so its frontend talks to ITS OWN backend instead of the
 * first instance's; the launcher must set the same `ORGII_IDE_SERVER_PORT`
 * at runtime for the Rust side.
 */
export const IDE_SERVER_PORT = process.env.ORGII_IDE_SERVER_PORT ?? "13847";

export const IDE_SERVER_HTTP_URL = `http://localhost:${IDE_SERVER_PORT}`;

export const IDE_SERVER_WS_URL = `ws://localhost:${IDE_SERVER_PORT}/ws`;
