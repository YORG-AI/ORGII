/**
 * PermissionCard Component
 *
 * Displays pending permission requests from OS Agent, SDE Agent, and Custom Agents.
 * Allows the user to Approve, Deny, or Always Allow tool executions.
 * Listens for "agent-permission-request" CustomEvents from the WebSocket handler.
 *
 * Delegates all rendering to PermissionCardBody (shared with ApprovalPreview).
 */
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  respondCliHookPermission,
  respondPermission,
} from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import type { PermissionRequestEvent } from "@src/engines/SessionCore/sync/adapters/shared";
import { createLogger } from "@src/hooks/logger";

import { PermissionCardBody } from "./PermissionCardBody";

const log = createLogger("PermissionCard");

function buildArgsPreview(args: Record<string, unknown>) {
  return Object.entries(args)
    .slice(0, 5)
    .map(([key, value]) => {
      const strValue =
        typeof value === "string" ? value : JSON.stringify(value);
      const truncated =
        strValue.length > 120 ? `${strValue.slice(0, 120)}...` : strValue;
      return { key, value: truncated };
    });
}

interface PermissionCardProps {
  sessionId?: string | null;
  collapsed?: boolean;
  onCollapse?: () => void;
  onHasDataChange?: (hasData: boolean) => void;
}

const PermissionCard: React.FC<PermissionCardProps> = ({
  sessionId,
  collapsed,
  onCollapse,
  onHasDataChange,
}) => {
  const { t } = useTranslation("sessions");
  const [queue, setQueue] = useState<PermissionRequestEvent[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const pending = queue.length > 0 ? queue[0] : null;

  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<PermissionRequestEvent>).detail;
      // Only accept events for the session this card belongs to.
      // Without this filter, a permission request from session B would
      // appear in the card rendered for session A.
      if (sessionId && detail?.sessionId && detail.sessionId !== sessionId)
        return;
      if (detail?.requestId) {
        setQueue((prev) => {
          if (prev.some((req) => req.requestId === detail.requestId))
            return prev;
          return [...prev, detail];
        });
      }
    };
    window.addEventListener("agent-permission-request", handler);
    return () => {
      window.removeEventListener("agent-permission-request", handler);
    };
  }, [sessionId]);

  const respond = useCallback(
    async (response: "allow" | "deny" | "always_allow") => {
      if (!pending) return;
      setIsSubmitting(true);
      const respondingId = pending.requestId;
      try {
        if (pending.origin === "cli_hook" || pending.origin === "acp") {
          // Managed CLI session: the approval is parked in a CLI-side
          // registry (Claude PermissionRequest hook long-poll or an ACP
          // agent's session/request_permission), not the Rust-agent
          // permission manager.
          await respondCliHookPermission(
            pending.sessionId ?? "",
            pending.requestId,
            response
          );
        } else {
          await respondPermission(
            pending.sessionId ?? "",
            pending.requestId,
            response,
            pending.tool,
            pending.args
          );
        }
        setQueue((prev) =>
          prev.filter((req) => req.requestId !== respondingId)
        );
      } catch (err) {
        log.error("[PermissionCard] Failed to respond:", err);
        Message.error(t("chat.permissionFailed"));
      } finally {
        setIsSubmitting(false);
      }
    },
    [pending, t]
  );

  useEffect(() => {
    onHasDataChange?.(queue.length > 0);
  }, [queue.length, onHasDataChange]);

  if (!pending) return null;

  const isCommandConfirm = pending.tool === "exec:command-confirm";

  return (
    <PermissionCardBody
      collapsed={collapsed}
      onCollapse={onCollapse}
      label={
        isCommandConfirm
          ? t("chat.commandConfirmTitle", "Command Requires Approval")
          : t("chat.permissionPrompt", "Your permission is needed")
      }
      badge={
        queue.length > 1 ? (
          <span className="text-[10px] text-text-3">+{queue.length - 1}</span>
        ) : undefined
      }
      commandText={
        isCommandConfirm && typeof pending.args.command === "string"
          ? pending.args.command
          : null
      }
      description={
        isCommandConfirm && typeof pending.args.reason === "string"
          ? pending.args.reason
          : null
      }
      argsPreview={isCommandConfirm ? [] : buildArgsPreview(pending.args)}
      onDeny={() => respond("deny")}
      onAlwaysAllow={() => respond("always_allow")}
      onAllow={() => respond("allow")}
      disabled={isSubmitting}
    />
  );
};

PermissionCard.displayName = "PermissionCard";

export default PermissionCard;
