/**
 * Shared permission prompt body — command block and args preview.
 */
import React from "react";

import type { PermissionArgPreview } from "./permissionPromptHelpers";

export interface PermissionPromptContentProps {
  commandText?: string | null;
  description?: string | null;
  argsPreview?: PermissionArgPreview[];
  /** Extra context line (e.g. mobile remote execution notice). */
  footerNote?: React.ReactNode;
  className?: string;
}

export function PermissionPromptContent({
  commandText,
  description,
  argsPreview = [],
  footerNote,
  className = "",
}: PermissionPromptContentProps) {
  return (
    <div className={`flex flex-col gap-2 ${className}`.trim()}>
      {commandText ? (
        <div>
          <div className="rounded-md bg-fill-2 px-3 py-2">
            <code className="text-sm font-semibold break-all text-primary-6">
              {commandText}
            </code>
          </div>
          {description ? (
            <p className="mt-2 text-sm leading-relaxed text-text-2">
              {description}
            </p>
          ) : null}
        </div>
      ) : (
        <div>
          {description ? (
            <p className="text-sm leading-relaxed text-text-2">{description}</p>
          ) : null}
          {argsPreview.length > 0 ? (
            <div className="scrollbar-overlay mt-2 flex max-h-[160px] flex-col gap-1 overflow-y-auto">
              {argsPreview.map(({ key, value }) => (
                <div key={key} className="flex gap-1.5 text-sm leading-relaxed">
                  <span className="shrink-0 font-medium text-text-3">
                    {key}:
                  </span>
                  <span className="break-all text-text-2">{value}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {footerNote ? (
        <p className="text-xs leading-relaxed text-text-3">{footerNote}</p>
      ) : null}
    </div>
  );
}

PermissionPromptContent.displayName = "PermissionPromptContent";
