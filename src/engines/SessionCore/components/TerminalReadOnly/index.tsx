import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import { isShellTool } from "@src/engines/SessionCore/sync/adapters/shared";
import XtermOutput from "@src/engines/TerminalCore/components/XtermOutput";

import {
  type TerminalExecOutputDetail,
  appendBoundedTerminalTail,
  execOutputKey,
  historyPreviewFromEvent,
} from "./outputBuffer";

interface TerminalReadOnlyProps {
  agentSessionId: string;
}

const MAX_WRITTEN_IDS = 500;
const RETAINED_WRITTEN_IDS = 200;

function formatSystemLine(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\r\n").trim();
  if (!trimmed) return "";
  return `${trimmed}\r\n`;
}

const TerminalReadOnly: React.FC<TerminalReadOnlyProps> = ({
  agentSessionId,
}) => {
  const agentSessionIdRef = useRef(agentSessionId);
  const streamingReceivedKeysRef = useRef<Set<string>>(new Set());
  const historyWrittenKeysRef = useRef<Set<string>>(new Set());
  const [output, setOutput] = useState("");

  const events = useAtomValue(eventsAtom);

  useEffect(() => {
    agentSessionIdRef.current = agentSessionId;
    streamingReceivedKeysRef.current.clear();
    historyWrittenKeysRef.current.clear();
    queueMicrotask(() => setOutput(""));
  }, [agentSessionId]);

  const appendOutput = useCallback((text: string) => {
    if (!text) return;
    setOutput((previous) => appendBoundedTerminalTail(previous, text));
  }, []);

  useEffect(() => {
    function handleExecOutput(evt: Event) {
      const detail = (evt as CustomEvent<TerminalExecOutputDetail>).detail;
      const key = execOutputKey(detail, agentSessionIdRef.current);
      if (!key) return;

      appendOutput(detail.chunk);
      streamingReceivedKeysRef.current.add(key);
    }

    window.addEventListener("agent-exec-output", handleExecOutput);
    return () => {
      window.removeEventListener("agent-exec-output", handleExecOutput);
    };
  }, [appendOutput]);

  useEffect(() => {
    const streamingReceived = streamingReceivedKeysRef.current;
    const historyWritten = historyWrittenKeysRef.current;
    let replayBatch = "";

    for (const event of events) {
      if (event.sessionId !== agentSessionIdRef.current) continue;
      if (!isShellTool(event.functionName)) continue;
      if (event.isDelta) continue;
      if (event.displayStatus === "running") continue;
      const preview = historyPreviewFromEvent(event);
      if (!preview) continue;
      if (historyWritten.has(preview.key)) continue;
      if (streamingReceived.has(preview.key)) continue;

      const { command, output: eventOutput, exitCode } = preview;
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

      replayBatch = appendBoundedTerminalTail(replayBatch, replayOutput);
      historyWritten.add(preview.key);
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
  }, [agentSessionId, appendOutput, events]);

  return (
    <div className="h-full w-full overflow-hidden">
      <XtermOutput content={output} className="h-full w-full" />
    </div>
  );
};

export default TerminalReadOnly;
