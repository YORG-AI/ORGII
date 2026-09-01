/**
 * Typed RPC Layer for Tauri IPC
 *
 * Replaces raw `invoke()` calls with a typed, schema-validated RPC client.
 *
 * ## Quick start
 *
 * ```ts
 * import { rpc } from "@src/api/tauri/rpc";
 *
 * // Domain-grouped, fully typed
 * const keys = await rpc.validation.listKeys();
 * const settings = await rpc.settings.read();
 * const exists = await rpc.terminal.checkExists({ sessionId: "abc" });
 * ```
 *
 * ## Adding new commands
 *
 * 1. Add Zod schemas in `schemas/{domain}.ts`
 * 2. Add procedure in `router.ts` under the domain
 * 3. Use via `rpc.{domain}.{procedure}(input)`
 *
 * @see `src/api/api_organization.md` (section `rpc/` — typed RPC)
 */

export { rpc } from "./router";
export { defineProcedure } from "./invoke";
export type { RpcProcedure } from "./invoke";
export { snakeToCamel } from "./transforms";
export * as schemas from "./schemas";
