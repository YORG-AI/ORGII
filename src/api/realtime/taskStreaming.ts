/**
 * Task Streaming API
 *
 * Provides real-time output streaming for task execution (npm, yarn, etc.)
 * Uses Server-Sent Events (SSE) via the Rust HTTP IDE server.
 */
import { IDE_SERVER_HTTP_URL } from "@src/config/ideServer";

import { createSSEStream } from "./sseStream";

const RUST_BASE_URL = `${IDE_SERVER_HTTP_URL}/api/tasks`;

/**
 * Callbacks for task streaming events
 */
export interface TaskStreamCallbacks {
  /** Called when the task starts */
  onStart?: () => void;
  /** Called for each output line */
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
  /** Called when the task completes */
  onComplete?: (success: boolean, exitCode?: number) => void;
  /** Called on error */
  onError?: (error: string) => void;
}

/**
 * Stream task execution output in real-time
 *
 * @example
 * ```typescript
 * const cleanup = await taskRunStream(
 *   {
 *     task_id: "build-1",
 *     command: "npm run build",
 *     cwd: "/path/to/project",
 *   },
 *   {
 *     onOutput: (line) => *
 * // Later: cleanup() to stop the stream
 * ```
 */
export async function taskRunStream(
  params: {
    task_id: string;
    command: string;
    cwd: string;
    shell?: string;
  },
  callbacks: TaskStreamCallbacks
): Promise<() => void> {
  const queryParams = new URLSearchParams({
    command: params.command,
    cwd: params.cwd,
  });

  if (params.shell) {
    queryParams.append("shell", params.shell);
  }

  const url = `${RUST_BASE_URL}/${encodeURIComponent(params.task_id)}/run/stream?${queryParams.toString()}`;

  return createSSEStream({
    url,
    onStart: () => callbacks.onStart?.(),
    onOutput: (data) =>
      callbacks.onOutput?.(data.line, data.stream as "stdout" | "stderr"),
    onEnd: (data) => {
      const exitCode =
        typeof data === "object" && "exitCode" in data
          ? (data.exitCode as number)
          : undefined;
      callbacks.onComplete?.(data.success, exitCode);
    },
    onError: (error) => callbacks.onError?.(error),
  });
}

/**
 * Convenience function for running npm scripts
 */
export async function npmRunStream(
  params: {
    task_id: string;
    script: string;
    cwd: string;
  },
  callbacks: TaskStreamCallbacks
): Promise<() => void> {
  return taskRunStream(
    {
      task_id: params.task_id,
      command: `npm run ${params.script}`,
      cwd: params.cwd,
    },
    callbacks
  );
}

/**
 * Convenience function for running yarn scripts
 */
export async function yarnRunStream(
  params: {
    task_id: string;
    script: string;
    cwd: string;
  },
  callbacks: TaskStreamCallbacks
): Promise<() => void> {
  return taskRunStream(
    {
      task_id: params.task_id,
      command: `yarn ${params.script}`,
      cwd: params.cwd,
    },
    callbacks
  );
}

/**
 * Convenience function for running pnpm scripts
 */
export async function pnpmRunStream(
  params: {
    task_id: string;
    script: string;
    cwd: string;
  },
  callbacks: TaskStreamCallbacks
): Promise<() => void> {
  return taskRunStream(
    {
      task_id: params.task_id,
      command: `pnpm ${params.script}`,
      cwd: params.cwd,
    },
    callbacks
  );
}
