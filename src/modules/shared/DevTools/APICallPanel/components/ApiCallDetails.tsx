// ============================================
// ApiCallDetails Component
// ============================================
import React from "react";

import type { ApiCall } from "@src/util/monitoring/apiTracker";

import { formatJson } from "../utils";

// ============================================
// Type Definitions
// ============================================

export interface ApiCallDetailsProps {
  call: ApiCall;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Build component display string from call data
 */
function getComponentDisplay(call: ApiCall): string | null {
  const parts: string[] = [];

  if (call.componentName) {
    parts.push(call.componentName);
  }

  if (call.functionName && call.functionName !== call.componentName) {
    parts.push(call.functionName);
  }

  if (parts.length === 0) return null;

  let display = parts.join(" → ");

  if (call.filePath) {
    const fileName = call.filePath.split("/").pop() || call.filePath;
    display += ` (${fileName}${call.lineNumber ? `:${call.lineNumber}` : ""})`;
  } else if (call.lineNumber) {
    display += `:${call.lineNumber}`;
  }

  return display;
}

// ============================================
// Component
// ============================================

const ApiCallDetails: React.FC<ApiCallDetailsProps> = ({ call }) => {
  const componentDisplay = getComponentDisplay(call);
  const isTauri = call.transport === "tauri";

  const responseContent = call.error
    ? formatJson(call.error)
    : call.response
      ? formatJson(call.response, 500)
      : "—";

  const hasError = Boolean(call.error);

  return (
    <div className="flex flex-col gap-3">
      {isTauri ? (
        <div className="flex items-start gap-3">
          <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-3">
            Command
          </span>
          <code className="flex-1 break-all text-[11px] text-text-1">
            {call.tauriCommand}
          </code>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-3">
            URL
          </span>
          <code className="flex-1 break-all text-[11px] text-text-1">
            {call.fullUrl}
          </code>
        </div>
      )}

      {isTauri && !!call.tauriArgs && (
        <div className="flex items-start gap-3">
          <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-3">
            Args
          </span>
          <pre className="bg-bg-4 max-h-[150px] flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-2 p-2.5 text-[11px] text-text-1">
            <code>{formatJson(call.tauriArgs, 500)}</code>
          </pre>
        </div>
      )}

      <div className="flex items-start gap-3">
        <span
          className={`w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide ${hasError ? "text-danger-6" : "text-text-3"}`}
        >
          {hasError ? "Error" : "Response"}
        </span>
        <pre
          className={`max-h-[150px] flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border p-2.5 text-[11px] ${
            hasError
              ? "border-danger-6/30 bg-danger-6/5 text-danger-6"
              : "bg-bg-4 border-border-2 text-text-1"
          }`}
        >
          <code>{responseContent}</code>
        </pre>
      </div>

      {componentDisplay && (
        <div className="flex items-start gap-3">
          <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-3">
            Component
          </span>
          <code className="flex-1 text-[11px] text-primary-6">
            {componentDisplay}
          </code>
        </div>
      )}

      {call.stack && (
        <div className="flex items-start gap-3">
          <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-3">
            Stack
          </span>
          <pre className="bg-bg-4 max-h-[180px] flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-2 p-2.5 text-[11px] text-text-2">
            <code>{call.stack}</code>
          </pre>
        </div>
      )}
    </div>
  );
};

export default ApiCallDetails;
