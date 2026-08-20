/**
 * Task Output Integration Hook
 *
 * Integrates task execution (npm, yarn, etc.) with the Output panel.
 * Automatically streams command output to the Build channel.
 */
import React, { useCallback, useRef } from "react";

import { taskRunStream } from "@src/api/realtime/taskStreaming";
import type {
  UseOutputChannelsReturn,
  UseTaskOutputIntegrationReturn,
} from "@src/types/workstation/output";

export interface UseTaskOutputIntegrationOptions {
  /** Output panel state */
  outputState: UseOutputChannelsReturn;
  /** Working directory for tasks */
  cwd: string;
  /** Auto-switch to Output panel when task starts (default: true) */
  autoSwitchToOutput?: boolean;
  /** Callback to switch to Output panel */
  onSwitchToOutput?: () => void;
}

/**
 * Hook to integrate task execution with the Output panel
 *
 * @example
 * ```typescript
 * const taskOutput = useTaskOutputIntegration({
 *   outputState,
 *   cwd: "/path/to/project",
 * });
 *
 * // Run a task
 * await taskOutput.runNpmScriptWithOutput({
 *   taskId: "build-1",
 *   script: "build",
 * });
 * ```
 */
export function useTaskOutputIntegration(
  options: UseTaskOutputIntegrationOptions
): UseTaskOutputIntegrationReturn {
  const {
    outputState,
    cwd,
    autoSwitchToOutput = true,
    onSwitchToOutput,
  } = options;
  const cleanupRef = useRef<(() => void) | null>(null);

  // Ensure Build channel exists
  React.useEffect(() => {
    const existingChannel = outputState.channels.find(
      (ch) => ch.type === "build"
    );
    if (!existingChannel) {
      outputState.createChannel("Build", "build");
    }
  }, [outputState]);

  // Helper to get or create Build channel ID
  const getBuildChannelId = useCallback((): string => {
    const channel = outputState.channels.find((ch) => ch.type === "build");
    if (!channel) {
      return outputState.createChannel("Build", "build");
    }
    return channel.id;
  }, [outputState]);

  // Helper: Format timestamp - local time with subdued italic styling
  const formatTimestamp = React.useCallback(() => {
    const now = new Date();
    // Format as YYYY-MM-DD HH:MM:SS.mmm
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const ms = now.getMilliseconds().toString().padStart(3, "0");
    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
    // Apply text-3 color (dimmed) and italic using ANSI codes
    return `\x1b[2m\x1b[3m${timestamp}\x1b[0m`;
  }, []);

  // Run task with output streaming
  const runTaskWithOutput = useCallback(
    async (params: { taskId: string; command: string; shell?: string }) => {
      const channelId = getBuildChannelId();
      const command = params.command;
      const startTime = Date.now();
      const timestamp = formatTimestamp();

      outputState.appendToChannel(
        channelId,
        `${timestamp} \x1b[36m[info]\x1b[0m > ${command}\n`
      );
      outputState.setActiveChannel(channelId);
      outputState.setChannelActive(channelId, true);

      // Auto-switch to Output panel
      if (autoSwitchToOutput && onSwitchToOutput) {
        onSwitchToOutput();
      }

      // Clean up previous stream if exists
      if (cleanupRef.current) {
        cleanupRef.current();
      }

      const cleanup = await taskRunStream(
        {
          task_id: params.taskId,
          command: params.command,
          cwd,
          shell: params.shell,
        },
        {
          onOutput: (line) => {
            outputState.appendToChannel(channelId, `${line}\n`);
          },
          onComplete: (success, exitCode) => {
            outputState.setChannelActive(channelId, false);
            const duration = Date.now() - startTime;
            const endTimestamp = formatTimestamp();
            const message = success
              ? `${endTimestamp} \x1b[32m[info]\x1b[0m ✓ Task completed (exit: ${exitCode || 0}) [\x1b[90m${duration}ms\x1b[0m]\n`
              : `${endTimestamp} \x1b[31m[error]\x1b[0m ✗ Task failed (exit: ${exitCode || 1}) [\x1b[90m${duration}ms\x1b[0m]\n`;
            outputState.appendToChannel(channelId, message);
          },
          onError: (error) => {
            outputState.setChannelActive(channelId, false);
            const endTimestamp = formatTimestamp();
            outputState.appendToChannel(
              channelId,
              `${endTimestamp} \x1b[31m[error]\x1b[0m ✗ ${error}\n`
            );
          },
        }
      );

      cleanupRef.current = cleanup;
      return cleanup;
    },
    [
      getBuildChannelId,
      outputState,
      cwd,
      autoSwitchToOutput,
      onSwitchToOutput,
      formatTimestamp,
    ]
  );

  // Run npm script with output streaming
  const runNpmScriptWithOutput = useCallback(
    async (params: { taskId: string; script: string }) => {
      return runTaskWithOutput({
        taskId: params.taskId,
        command: `npm run ${params.script}`,
      });
    },
    [runTaskWithOutput]
  );

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, []);

  return {
    runTaskWithOutput,
    runNpmScriptWithOutput,
  };
}
