import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { stripAnsiCodes } from "@src/components/TerminalDisplay/utils/ansiProcessor";
import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isShellTool } from "@src/engines/SessionCore/sync/adapters/shared";
import { listenTauri } from "@src/util/platform/tauri/init";

interface TerminalReadOnlyProps {
  agentSessionId: string;
}

interface PtyOutputPayload {
  bytes?: number[];
  byte_count?: number;
  data?: string;
}

const PTY_SESSION_ID = "osagent-pty-main";
const MAX_WRITTEN_IDS = 500;
const RETAINED_WRITTEN_IDS = 200;
const MAX_OUTPUT_CHARS = 30_000;
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

function normalizeTerminalText(text: string): string {
  return stripAnsiCodes(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function formatPlainLine(text: string): string {
  const normalized = normalizeTerminalText(text).trim();
  if (!normalized) return "";
  return `${normalized}\n`;
}

function trimOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(text.length - MAX_OUTPUT_CHARS);
}

const TerminalReadOnly: React.FC<TerminalReadOnlyProps> = ({
  agentSessionId,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentSessionIdRef = useRef(agentSessionId);
  const eventsAtomRef = useRef<SessionEvent[]>([]);
  const streamingReceivedIdsRef = useRef<Set<string>>(new Set());
  const historyWrittenIdsRef = useRef<Set<string>>(new Set());
  const followFrameRef = useRef<number | null>(null);
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

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
    }

    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      scrollToBottom();
    });
  }, [scrollToBottom]);

  const appendOutput = useCallback((text: string) => {
    const normalized = normalizeTerminalText(text);
    if (!normalized) return;

    setOutput((previous) => trimOutput(previous + normalized));
  }, []);

  useEffect(() => {
    scheduleScrollToBottom();
  }, [output, scheduleScrollToBottom]);

  useEffect(() => {
    return () => {
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
      }
    };
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
          ? formatPlainLine(detail.chunk)
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

      const { bytes, data } = event.payload;
      if (bytes && bytes.length > 0) {
        const decoded = utf8Decoder.decode(new Uint8Array(bytes), {
          stream: true,
        });
        appendOutput(decoded);
      } else if (data) {
        appendOutput(data);
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
        replayOutput += formatPlainLine(`$ ${command}`);
      }

      if (eventOutput) {
        replayOutput += normalizeTerminalText(eventOutput);
        if (!replayOutput.endsWith("\n")) {
          replayOutput += "\n";
        }
      }

      if (exitCode !== undefined) {
        replayOutput += formatPlainLine(`[exit code: ${exitCode}]`);
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
    <div className="h-full w-full overflow-hidden bg-[var(--cm-editor-background)]">
      <div
        ref={scrollRef}
        className="scrollbar-overlay h-full w-full overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-[13px] leading-5 text-text-2"
      >
        {output}
      </div>
    </div>
  );
};

export type { TerminalReadOnlyProps };
export default TerminalReadOnly;
