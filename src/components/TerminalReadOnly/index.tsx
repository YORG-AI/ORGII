import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isShellTool } from "@src/engines/SessionCore/sync/adapters/shared";
import { listenTauri } from "@src/util/platform/tauri/init";
import {
  type PtyOutputPayload,
  ptyPayloadBytes,
} from "@src/util/terminal/ptyOutputPayload";

import XtermOutput from "../XtermOutput";

interface TerminalReadOnlyProps {
  agentSessionId: string;
}

const PTY_SESSION_ID = "osagent-pty-main";
const MAX_WRITTEN_IDS = 500;
const RETAINED_WRITTEN_IDS = 200;
const MAX_OUTPUT_CHARS = 500_000;
function safeStr(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
  }
  return undefined;
}

function extractShellFromEvent(event: SessionEvent): {
  command: string;
  output?: string;
  exitCode?: number;
} {
  const { args, result } = event;

  const outputObj = result?.output as Record<string, unknown> | undefined;
  const nestedSuccess = (outputObj?.success as Record<string, unknown>) || {};
  const directSuccess = (result?.success as Record<string, unknown>) || {};
  const successData =
    Object.keys(nestedSuccess).length > 0 ? nestedSuccess : directSuccess;

  const nestedFailure = (outputObj?.failure as Record<string, unknown>) || {};
  const directFailure = (result?.failure as Record<string, unknown>) || {};
  const failureData =
    Object.keys(nestedFailure).length > 0 ? nestedFailure : directFailure;

  const commandData =
    Object.keys(successData).length > 0 ? successData : failureData;

  const command =
    (commandData?.command as string) ||
    (args?.command as string) ||
    (result?.command as string) ||
    "";

  const shellOutput =
    safeStr(commandData?.interleavedOutput) ||
    safeStr(commandData?.interleaved_output) ||
    safeStr(commandData?.stdout) ||
    safeStr(result?.stdout) ||
    safeStr(commandData?.stderr) ||
    safeStr(result?.stderr) ||
    (typeof result?.output === "string"
      ? (result.output as string)
      : undefined) ||
    safeStr(result?.observation) ||
    safeStr(result?.content) ||
    undefined;

  const exitCode =
    (commandData?.exitCode as number) ??
    (commandData?.exit_code as number) ??
    (result?.exit_code as number) ??
    undefined;

  return { command, output: shellOutput, exitCode };
}

function formatSystemLine(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\r\n").trim();
  if (!trimmed) return "";
  return `${trimmed}\r\n`;
}

function trimOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(text.length - MAX_OUTPUT_CHARS);
}

const TerminalReadOnly: React.FC<TerminalReadOnlyProps> = ({
  agentSessionId,
}) => {
  const agentSessionIdRef = useRef(agentSessionId);
  const eventsAtomRef = useRef<SessionEvent[]>([]);
  const streamingReceivedIdsRef = useRef<Set<string>>(new Set());
  const historyWrittenIdsRef = useRef<Set<string>>(new Set());
  const [output, setOutput] = useState("");

  const events = useAtomValue(eventsAtom);

  useEffect(() => {
    eventsAtomRef.current = events;
  }, [events]);

  useEffect(() => {
    agentSessionIdRef.current = agentSessionId;
    streamingReceivedIdsRef.current.clear();
    historyWrittenIdsRef.current.clear();
    queueMicrotask(() => setOutput(""));
  }, [agentSessionId]);

  const appendOutput = useCallback((text: string) => {
    if (!text) return;
    setOutput((previous) => trimOutput(previous + text));
  }, []);

  useEffect(() => {
    function handleExecOutput(evt: Event) {
      const detail = (
        evt as CustomEvent<{
          sessionId: string;
          chunk: string;
          stream: string;
        }>
      ).detail;
      if (!detail) return;
      if (detail.sessionId !== agentSessionIdRef.current) return;

      appendOutput(
        detail.stream === "system"
          ? formatSystemLine(detail.chunk)
          : detail.chunk
      );

      const currentEvents = eventsAtomRef.current;
      for (const event of currentEvents) {
        if (event.sessionId !== agentSessionIdRef.current) continue;
        if (!isShellTool(event.functionName)) continue;
        if (event.isDelta) continue;
        if (event.displayStatus === "running") {
          streamingReceivedIdsRef.current.add(event.id);
          break;
        }
      }
    }

    window.addEventListener("agent-exec-output", handleExecOutput);
    return () => {
      window.removeEventListener("agent-exec-output", handleExecOutput);
    };
  }, [appendOutput]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

    listenTauri<PtyOutputPayload>(`pty-output-${PTY_SESSION_ID}`, (event) => {
      if (cancelled) return;

      const chunk = ptyPayloadBytes(event.payload);
      if (chunk && chunk.length > 0) {
        const decoded = utf8Decoder.decode(chunk, { stream: true });
        appendOutput(decoded);
      } else if (event.payload.data) {
        appendOutput(event.payload.data);
      }
    }).then((unlistenFn) => {
      if (cancelled) {
        unlistenFn();
      } else {
        unlisten = unlistenFn;
      }
    });

    return () => {
      cancelled = true;
      utf8Decoder.decode();
      if (unlisten) unlisten();
    };
  }, [appendOutput]);

  useEffect(() => {
    const streamingReceived = streamingReceivedIdsRef.current;
    const historyWritten = historyWrittenIdsRef.current;
    let replayBatch = "";

    for (const event of events) {
      if (event.sessionId !== agentSessionIdRef.current) continue;
      if (!isShellTool(event.functionName)) continue;
      if (event.isDelta) continue;
      if (historyWritten.has(event.id)) continue;
      if (event.displayStatus === "running") continue;
      if (streamingReceived.has(event.id)) continue;

      const {
        command,
        output: eventOutput,
        exitCode,
      } = extractShellFromEvent(event);
      let replayOutput = "";

      if (command) {
        replayOutput += formatSystemLine(`$ ${command}`);
      }

      if (eventOutput) {
        replayOutput += eventOutput;
        if (!replayOutput.endsWith("\n") && !replayOutput.endsWith("\r\n")) {
          replayOutput += "\r\n";
        }
      }

      if (exitCode !== undefined) {
        replayOutput += formatSystemLine(`[exit code: ${exitCode}]`);
      }

      replayBatch += replayOutput;
      historyWritten.add(event.id);
    }

    if (replayBatch) {
      queueMicrotask(() => appendOutput(replayBatch));
    }

    for (const setRef of [streamingReceived, historyWritten]) {
      if (setRef.size > MAX_WRITTEN_IDS) {
        const idsArray = [...setRef];
        setRef.clear();
        for (const id of idsArray.slice(-RETAINED_WRITTEN_IDS)) {
          setRef.add(id);
        }
      }
    }
  }, [appendOutput, events]);

  return (
    <div className="h-full w-full overflow-hidden">
      <XtermOutput content={output} className="h-full w-full" />
    </div>
  );
};

export type { TerminalReadOnlyProps };
export default TerminalReadOnly;
