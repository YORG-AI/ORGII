/**
 * PermissionSheet — mobile remote permission approval surface.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import BottomSheet from "@src/components/BottomSheet";
import { HugeiconsIcon, NotificationBubbleIcon } from "@src/icons";

import { PermissionPromptActions } from "./PermissionPromptActions";
import { PermissionPromptContent } from "./PermissionPromptContent";
import {
  type PermissionArgPreview,
  resolvePermissionPromptViewModel,
} from "./permissionPromptHelpers";

export interface PermissionSheetRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  toolArgs: Record<string, unknown>;
  origin?: "rust_agent" | "cli_hook" | "acp";
}

export interface PermissionSheetProps {
  open: boolean;
  request: PermissionSheetRequest | null;
  desktopName?: string;
  queueDepth?: number;
  submitting?: boolean;
  onDeny: () => void;
  onAllow: () => void;
  onAlwaysAllow: () => void;
}

export function PermissionSheet({
  open,
  request,
  desktopName,
  queueDepth = 0,
  submitting = false,
  onDeny,
  onAllow,
  onAlwaysAllow,
}: PermissionSheetProps) {
  const { t } = useTranslation("sessions");

  if (!request) return null;

  const viewModel = resolvePermissionPromptViewModel({
    tool: request.toolName,
    args: request.toolArgs,
    permissionPromptLabel: t(
      "chat.permissionPrompt",
      "Your permission is needed"
    ),
    commandConfirmTitle: t(
      "chat.commandConfirmTitle",
      "Command Requires Approval"
    ),
  });

  const footerNote =
    desktopName &&
    t(
      "chat.remoteExecutionNotice",
      "This action will run on {{desktopName}}.",
      {
        desktopName,
      }
    );

  const badge =
    queueDepth > 1 ? (
      <span className="ml-2 text-xs text-text-3">+{queueDepth - 1}</span>
    ) : null;

  return (
    <BottomSheet
      open={open}
      dismissible={false}
      title={
        <span className="inline-flex items-center gap-2">
          <HugeiconsIcon icon={NotificationBubbleIcon} size={16} />
          <span>{viewModel.label}</span>
          {badge}
          {!viewModel.commandText && request.toolName ? (
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-xs font-medium text-text-2">
              {request.toolName}
            </span>
          ) : null}
        </span>
      }
      footer={
        <PermissionPromptActions
          layout="mobile"
          disabled={submitting}
          onDeny={onDeny}
          onAllow={onAllow}
          onAlwaysAllow={onAlwaysAllow}
        />
      }
    >
      <PermissionPromptContent
        commandText={viewModel.commandText}
        description={viewModel.description}
        argsPreview={viewModel.argsPreview as PermissionArgPreview[]}
        footerNote={footerNote || undefined}
      />
    </BottomSheet>
  );
}

PermissionSheet.displayName = "PermissionSheet";

export default PermissionSheet;
