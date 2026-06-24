/**
 * Typed RPC Router — assembles domain procedures into a callable client.
 *
 * Usage:
 * ```ts
 * import { rpc } from "@src/api/tauri/rpc";
 *
 * const result = await rpc.validation.validateKey({
 *   agentType: "openai",
 *   apiKey: "sk-...",
 * });
 * const settings = await rpc.settings.read();
 * ```
 *
 * Procedure definitions live in `./procedures/` — one file per domain.
 * Each procedure has:
 *   - A Tauri command name (the Rust #[tauri::command] name)
 *   - An input Zod schema (validated before IPC)
 *   - An output Zod schema (validated in dev after IPC)
 *   - An optional transform (snake_case → camelCase)
 */
import { type RpcProcedure, rpcCall } from "./invoke";
import * as p from "./procedures";

// ============================================================================
// Procedure map
// ============================================================================

export const procedures = {
  validation: p.validation,
  settings: p.settings,
  terminal: p.terminal,
  diff: p.diff,
  gateway: p.gateway,
  agentDef: p.agentDef,
  agentOrgs: p.agentOrgs,
  agentSession: p.agentSession,
  integrations: p.integrations,
  sessionAggregate: p.sessionAggregate,
  sessionCore: p.sessionCore,
  learning: p.learning,
  workspaceMemory: p.workspaceMemory,
  lineage: p.lineage,
  searchRegex: p.searchRegex,
  searchSymbol: p.searchSymbol,
  tools: p.tools,
  mcp: p.mcp,
  flow: p.flow,
  quota: p.quota,
} as const;

// ============================================================================
// Callable router
// ============================================================================

type ProcedureCaller<P> =
  P extends RpcProcedure<infer TInput, infer TOutput>
    ? import("zod/v4").input<TInput> extends void | undefined
      ? () => Promise<
          TOutput extends import("zod/v4").ZodType
            ? import("zod/v4").output<TOutput>
            : void
        >
      : (
          input: import("zod/v4").input<TInput>
        ) => Promise<
          TOutput extends import("zod/v4").ZodType
            ? import("zod/v4").output<TOutput>
            : void
        >
    : never;

type ProcedureTree = {
  readonly [key: string]: RpcProcedure | ProcedureTree;
};

type DomainRouter<T> = {
  [K in keyof T]: T[K] extends RpcProcedure
    ? ProcedureCaller<T[K]>
    : T[K] extends ProcedureTree
      ? DomainRouter<T[K]>
      : never;
};

function isRpcProcedure(value: unknown): value is RpcProcedure {
  return (
    typeof value === "object" &&
    value !== null &&
    "command" in value &&
    typeof (value as { command?: unknown }).command === "string"
  );
}

function createRouter<T extends ProcedureTree>(
  procedureMap: T
): DomainRouter<T> {
  const router: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(procedureMap)) {
    if (isRpcProcedure(value)) {
      router[name] = (input?: unknown) => rpcCall(value, input as never);
    } else {
      router[name] = createRouter(value as ProcedureTree);
    }
  }

  return router as DomainRouter<T>;
}

/**
 * The typed RPC client. Auto-validates input/output via Zod in development.
 *
 * ```ts
 * import { rpc } from "@src/api/tauri/rpc";
 *
 * const keys = await rpc.validation.listKeys();
 * const settings = await rpc.settings.read();
 * ```
 */
export const rpc = createRouter(procedures);
