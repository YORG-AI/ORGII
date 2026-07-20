/**
 * PermissionCard Component
 *
 * Displays pending permission requests from OS Agent, SDE Agent, and Custom Agents.
 * Allows the user to Approve, Deny, or Always Allow tool executions.
 * Renders the session-scoped pending permission store populated by the agent
 * event handler, so requests survive component remounts and session switches.
 *
 * Delegates all rendering to PermissionCardBody (shared with ApprovalPreview).
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { respondPermission } from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import {
  clearPendingPermissionRequest,
  getPendingPermissionRequests,
  pendingPermissionRequestsAtom,
} from "@src/store/session/permissionRequestAtom";

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
  const permissionMap = useAtomValue(pendingPermissionRequestsAtom);
  const setPermissionMap = useSetAtom(pendingPermissionRequestsAtom);
  const queue = useMemo(
    () => getPendingPermissionRequests(permissionMap, sessionId),
    [permissionMap, sessionId]
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const pending = queue.length > 0 ? queue[0] : null;

  const respond = useCallback(
    async (response: "allow" | "deny" | "always_allow") => {
      if (!pending) return;
      setIsSubmitting(true);
      const respondingId = pending.requestId;
      try {
        await respondPermission(
          pending.sessionId ?? "",
          pending.requestId,
          response,
          pending.tool,
          pending.args
        );
        setPermissionMap((prev) =>
          clearPendingPermissionRequest(prev, pending.sessionId, respondingId)
        );
      } catch (err) {
        log.error("[PermissionCard] Failed to respond:", err);
        Message.error(t("chat.permissionFailed"));
      } finally {
        setIsSubmitting(false);
      }
    },
    [pending, setPermissionMap, t]
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
