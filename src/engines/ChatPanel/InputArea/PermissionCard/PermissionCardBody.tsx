/**
 * PermissionCardBody
 *
 * Pure presentational component for permission/approval cards.
 * Uses the composer stack bar pattern (same as QueuedMessages / CompactFileChanges).
 *
 * Used by PermissionCard (live session) and ApprovalPreview (DevTools playground).
 */
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS,
  COMPOSER_CARD_SHELL_CLASSES,
} from "@src/config/composerStackTokens";
import { HugeiconsIcon, NotificationBubbleIcon } from "@src/icons";

import ComposerStackHeader from "../components/ComposerStackHeader";

interface ArgPreview {
  key: string;
  value: string;
}

export interface PermissionCardBodyProps {
  /** Header label (e.g. "Permission Request" or "Command Requires Approval") */
  label: string;
  /** Optional header badge (e.g. tool name or "+N" queue count) */
  badge?: React.ReactNode;
  /** Command text for command-confirm style */
  commandText?: string | null;
  /** Description / reason text */
  description?: string | null;
  /** Key-value args preview rows */
  argsPreview?: ArgPreview[];
  /** Callbacks for the three buttons. When absent, buttons are no-ops. */
  onDeny?: () => void;
  onAlwaysAllow?: () => void;
  onAllow?: () => void;
  /** Disable all buttons (e.g. during submission) */
  disabled?: boolean;
  /** When true, renders nothing — pill shown in row instead. */
  collapsed?: boolean;
  /** Called when the user collapses the card. */
  onCollapse?: () => void;
}

export function PermissionCardBody({
  label,
  badge,
  commandText,
  description,
  argsPreview = [],
  onDeny,
  onAlwaysAllow,
  onAllow,
  disabled = false,
  collapsed = false,
  onCollapse,
}: PermissionCardBodyProps) {
  const { t } = useTranslation("sessions");
  const [localExpanded, setLocalExpanded] = useState(true);
  const expanded = collapsed ? false : localExpanded;
  const toggleExpanded = useCallback(() => {
    if (localExpanded && onCollapse) {
      onCollapse();
    } else {
      setLocalExpanded((prev) => !prev);
    }
  }, [localExpanded, onCollapse]);

  const noop = useCallback(() => {}, []);

  if (collapsed) return null;

  return (
    <div className={COMPOSER_CARD_SHELL_CLASSES}>
      <ComposerStackHeader
        icon={
          <HugeiconsIcon
            icon={NotificationBubbleIcon}
            data-icon="bell-ring"
            size={14}
          />
        }
        label={label}
        labelVariant="primary"
        expanded={expanded}
        onToggle={toggleExpanded}
        badges={badge}
      />

      {expanded && (
        <>
          <div
            className={`${CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS} pb-1`}
          >
            {commandText ? (
              <div className="px-1.5">
                <div className="mb-1.5 rounded-md bg-fill-2 px-3 py-2">
                  <code className="chat-block-title break-all font-semibold text-primary-6">
                    {commandText}
                  </code>
                </div>
                {description && (
                  <p className="chat-block-title leading-[1.5] text-text-2">
                    {description}
                  </p>
                )}
              </div>
            ) : (
              <div className="px-1.5">
                {description && (
                  <p className="chat-block-title leading-[1.5] text-text-2">
                    {description}
                  </p>
                )}
                {argsPreview.length > 0 && (
                  <div className="scrollbar-overlay flex max-h-[120px] flex-col gap-1 overflow-y-auto">
                    {argsPreview.map(({ key, value }) => (
                      <div
                        key={key}
                        className="chat-block-title flex gap-1.5 leading-[1.5]"
                      >
                        <span className="shrink-0 font-medium text-text-3">
                          {key}:
                        </span>
                        <span className="break-all text-text-2">{value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-1.5 px-2.5 py-1.5">
            <Button
              variant="tertiary"
              size="mini"
              onClick={onDeny ?? noop}
              disabled={disabled}
            >
              {t("chat.deny", "Deny")}
            </Button>
            <Button
              variant="secondary"
              size="mini"
              onClick={onAlwaysAllow ?? noop}
              disabled={disabled}
            >
              {t("chat.alwaysAllow", "Always Allow")}
            </Button>
            <Button
              variant="primary"
              size="mini"
              onClick={onAllow ?? noop}
              disabled={disabled}
            >
              {t("chat.allow", "Allow")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

PermissionCardBody.displayName = "PermissionCardBody";
