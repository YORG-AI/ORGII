/**
 * Typed Tauri invoke wrapper with Zod validation.
 *
 * Provides runtime type safety for Tauri IPC calls by validating
 * both input parameters and output responses against Zod schemas.
 * Errors from Rust are surfaced as typed RpcError instead of raw strings.
 */
import { invoke } from "@tauri-apps/api/core";
import type { z } from "zod/v4";

import { recordDiagnosticsRpc } from "@src/diagnostics/runtimeCounters";

// ============================================================================
// Error types
// ============================================================================

export class RpcError extends Error {
  readonly command: string;
  readonly cause?: unknown;

  constructor(command: string, message: string, cause?: unknown) {
    super(`[RPC:${command}] ${message}`);
    this.name = "RpcError";
    this.command = command;
    this.cause = cause;
  }
}

// ============================================================================
// Output-validation policy
// ============================================================================

/**
 * How `typedInvoke` reacts when a Rust response fails its `output` Zod schema
 * (i.e. the TS<->Rust contract has drifted):
 *
 * - `"off"`   — skip output validation entirely (lowest overhead).
 * - `"warn"`  — validate, `console.error` + record the drift, but still return
 *               the raw data so the UI keeps working.
 * - `"throw"` — validate and throw a {@link RpcError} on mismatch. Intended for
 *               CI / E2E runs so contract drift fails the build instead of
 *               silently slipping through.
 *
 * Default preserves the historical behavior: `"warn"` in dev/test, `"off"` in
 * production (output validation is not free on large payloads). Flip it with
 * {@link setRpcOutputValidationMode} — e.g. an E2E harness sets `"throw"`.
 */
export type RpcOutputValidationMode = "off" | "warn" | "throw";

const DEFAULT_OUTPUT_VALIDATION_MODE: RpcOutputValidationMode =
  process.env.NODE_ENV === "production" ? "off" : "warn";

let outputValidationMode: RpcOutputValidationMode =
  DEFAULT_OUTPUT_VALIDATION_MODE;

/** Override how output-schema drift is handled process-wide. */
export function setRpcOutputValidationMode(
  mode: RpcOutputValidationMode
): void {
  outputValidationMode = mode;
}

/** Current output-validation mode (see {@link RpcOutputValidationMode}). */
export function getRpcOutputValidationMode(): RpcOutputValidationMode {
  return outputValidationMode;
}

/** Reset the output-validation mode to the env-derived default. */
export function resetRpcOutputValidationMode(): void {
  outputValidationMode = DEFAULT_OUTPUT_VALIDATION_MODE;
}

const MAX_OUTPUT_DRIFT_RECORDS = 200;

/**
 * Record an output-schema drift into a window ring buffer so E2E / CI (and the
 * runtime diagnostics panel) can observe contract drift without spying on
 * `console`. No-op outside a browser/webview context.
 */
function recordOutputDrift(command: string, issues: unknown): void {
  if (typeof window === "undefined") return;
  window.__orgiiRpcOutputDrift ??= [];
  window.__orgiiRpcOutputDrift.push({ command, issues, at: Date.now() });
  const overflow =
    window.__orgiiRpcOutputDrift.length - MAX_OUTPUT_DRIFT_RECORDS;
  if (overflow > 0) {
    window.__orgiiRpcOutputDrift.splice(0, overflow);
  }
}

// ============================================================================
// Procedure definition
// ============================================================================

/**
 * A single RPC procedure definition: command name + optional Zod schemas.
 *
 * - `input` validates the payload sent to Rust (catches bad args before IPC)
 * - `output` validates the response from Rust (catches schema drift early)
 * - Both are optional: omit `input` for commands with no args,
 *   omit `output` for void commands.
 */
export interface RpcProcedure<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  command: string;
  input?: TInput;
  output?: TOutput;
  /**
   * Transform Rust snake_case response to camelCase TS types.
   * Runs BEFORE Zod output validation so the schema should match
   * the transformed shape.
   */
  transform?: (raw: unknown) => unknown;
}

// ============================================================================
// Core invoke
// ============================================================================

declare global {
  interface Window {
    __orgiiE2ERpcCounts?: Record<string, number>;
    __orgiiE2ERpcLog?: Array<{ command: string; at: number }>;
    /**
     * Ring buffer of the most recent output-validation drifts (TS schema vs the
     * actual Rust response). Populated whenever output validation runs and
     * fails, regardless of mode, so E2E / CI can assert drift without spying on
     * `console`. Bounded to avoid unbounded growth on a long-lived session.
     */
    __orgiiRpcOutputDrift?: Array<{
      command: string;
      issues: unknown;
      at: number;
    }>;
  }
}

function recordE2ERpcInvoke(command: string): void {
  if (process.env.NODE_ENV === "production") return;
  if (typeof window === "undefined") return;
  window.__orgiiE2ERpcCounts ??= {};
  window.__orgiiE2ERpcCounts[command] =
    (window.__orgiiE2ERpcCounts[command] ?? 0) + 1;
  window.__orgiiE2ERpcLog ??= [];
  window.__orgiiE2ERpcLog.push({ command, at: performance.now() });
  if (window.__orgiiE2ERpcLog.length > 500) {
    window.__orgiiE2ERpcLog.splice(0, window.__orgiiE2ERpcLog.length - 500);
  }
}

/**
 * Type-safe invoke: validates input, calls Tauri, validates output.
 *
 * In production builds, output validation is skipped for performance.
 */
export async function typedInvoke<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  procedure: RpcProcedure<TInput, TOutput>,
  ...[payload]: z.input<TInput> extends void | undefined
    ? [payload?: undefined]
    : [payload: z.input<TInput>]
): Promise<TOutput extends z.ZodType ? z.output<TOutput> : void> {
  const { command, input, output, transform } = procedure;

  // Validate input (always — catches caller bugs before IPC round-trip)
  let validatedInput: unknown = payload;
  if (input && payload !== undefined) {
    const parsed = input.safeParse(payload);
    if (!parsed.success) {
      throw new RpcError(
        command,
        `Invalid input: ${JSON.stringify(parsed.error.issues, null, 2)}`
      );
    }
    validatedInput = parsed.data;
  }

  // Call Rust
  recordE2ERpcInvoke(command);
  const diagnosticsStart = performance.now();
  let raw: unknown;
  try {
    raw = await invoke(
      command,
      (validatedInput as Record<string, unknown>) ?? {}
    );
    recordDiagnosticsRpc(command, performance.now() - diagnosticsStart, true);
  } catch (err) {
    recordDiagnosticsRpc(command, performance.now() - diagnosticsStart, false);
    throw new RpcError(
      command,
      typeof err === "string" ? err : String(err),
      err
    );
  }

  // Optional transform (snake_case → camelCase, etc.)
  const transformed = transform ? transform(raw) : raw;

  // Validate output against the configured drift policy. Default preserves the
  // historical behavior (dev/test: "warn", prod: "off"), but the mode is now
  // switchable so CI/E2E can enforce ("throw") and prod can opt into observing
  // ("warn") — turning silent TS<->Rust contract drift into a catchable signal.
  if (output && outputValidationMode !== "off") {
    const parsed = output.safeParse(transformed);
    if (!parsed.success) {
      // Raw console.error kept intentionally: asserted by rpc/router.test.ts.
      console.error(
        `[RPC:${command}] Output validation failed`,
        parsed.error.issues,
        "Raw:",
        raw
      );
      recordOutputDrift(command, parsed.error.issues);
      if (outputValidationMode === "throw") {
        throw new RpcError(
          command,
          `Output validation failed: ${JSON.stringify(
            parsed.error.issues,
            null,
            2
          )}`,
          parsed.error
        );
      }
      // "warn": still return the data so the app doesn't break — just warn loudly.
    }
  }

  return transformed as TOutput extends z.ZodType ? z.output<TOutput> : void;
}

// ============================================================================
// Procedure builder (fluent API)
// ============================================================================

/**
 * Define a typed RPC procedure with a fluent builder:
 *
 * ```ts
 * const getUser = defineProcedure("get_user")
 *   .input(z.object({ userId: z.string() }))
 *   .output(z.object({ name: z.string(), email: z.string() }))
 *   .build();
 *
 * // Call with full type safety:
 * const user = await rpcCall(getUser, { userId: "abc" });
 * //    ^? { name: string; email: string }
 * ```
 */
export function defineProcedure(command: string) {
  return new ProcedureBuilder(command);
}

class ProcedureBuilder<
  TInput extends z.ZodType = z.ZodVoid,
  TOutput extends z.ZodType = z.ZodVoid,
> {
  private _command: string;
  private _input?: TInput;
  private _output?: TOutput;
  private _transform?: (raw: unknown) => unknown;

  constructor(command: string) {
    this._command = command;
  }

  input<T extends z.ZodType>(schema: T): ProcedureBuilder<T, TOutput> {
    const next = new ProcedureBuilder<T, TOutput>(this._command);
    next._input = schema;
    next._output = this._output;
    next._transform = this._transform;
    return next;
  }

  output<T extends z.ZodType>(schema: T): ProcedureBuilder<TInput, T> {
    const next = new ProcedureBuilder<TInput, T>(this._command);
    next._input = this._input;
    next._output = schema;
    next._transform = this._transform;
    return next;
  }

  transform(fn: (raw: unknown) => unknown): ProcedureBuilder<TInput, TOutput> {
    this._transform = fn;
    return this;
  }

  build(): RpcProcedure<TInput, TOutput> {
    return {
      command: this._command,
      input: this._input,
      output: this._output,
      transform: this._transform,
    };
  }
}

// ============================================================================
// Convenience caller
// ============================================================================

/**
 * Call a typed RPC procedure. Alias for `typedInvoke` with nicer name.
 *
 * ```ts
 * const result = await rpcCall(procedures.validation.validateKey, {
 *   agentType: "openai",
 *   apiKey: "sk-...",
 * });
 * ```
 */
export const rpcCall = typedInvoke;
