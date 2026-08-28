/**
 * QueuedMessageItem
 *
 * A single sortable row inside QueuedMessages.
 * Uses dnd-kit's useSortable for drag-and-drop reordering.
 *
 * Edit triggers the main input box — no inline editing here.
 */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  COMPOSER_STACK_ROW_ACTIONS,
  COMPOSER_STACK_ROW_BASE,
  COMPOSER_STACK_ROW_HOVER,
  COMPOSER_STACK_ROW_LABEL,
} from "@src/config/composerStackTokens";
import {
  ArrowUp02Icon,
  Clock01Icon,
  Delete02Icon,
  HugeiconsIcon,
  Loading03Icon,
  Pen01Icon,
} from "@src/icons";
import type { QueuedMessage } from "@src/store/ui/messageQueueAtom";

const MAX_PREVIEW_LENGTH = 80;

interface QueuedMessageItemProps {
  msg: QueuedMessage;
  draggable: boolean;
  isDragging: boolean;
  isEditing: boolean;
  onStartEdit: (msg: QueuedMessage) => void;
  onSendNow: (messageId: string) => void;
  onCancel: (messageId: string) => void;
}

const QueuedMessageItem: React.FC<QueuedMessageItemProps> = memo(
  ({
    msg,
    draggable,
    isDragging,
    isEditing,
    onStartEdit,
    onSendNow,
    onCancel,
  }) => {
    const { t } = useTranslation();
    // "now" priority = Send Now clicked; the dispatcher delivers the moment
    // the interrupted turn's terminal lands. Render as "sending now…" so the
    // user sees their click took effect during the interrupt window.
    const isSendingNow = msg.priority === "now";
    const { attributes, listeners, setNodeRef, transform, transition } =
      useSortable({
        id: msg.id,
        disabled: isEditing || isSendingNow || !draggable,
      });

    const style: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.4 : 1,
    };

    const preview =
      msg.displayContent.length > MAX_PREVIEW_LENGTH
        ? msg.displayContent.slice(0, MAX_PREVIEW_LENGTH) + "…"
        : msg.displayContent;

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={`${COMPOSER_STACK_ROW_BASE} ${
          isEditing ? "bg-primary-1" : COMPOSER_STACK_ROW_HOVER
        } ${draggable && !isEditing && !isSendingNow ? "cursor-grab active:cursor-grabbing" : ""}`}
        data-testid="queued-message-item"
        data-queued-message-id={msg.id}
        data-queued-message-content={msg.displayContent}
        data-queued-message-sending={isSendingNow || undefined}
        title={msg.displayContent}
        aria-label={msg.displayContent}
        {...(draggable && !isEditing && !isSendingNow
          ? { ...attributes, ...listeners }
          : {})}
      >
        <div className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
          {isSendingNow ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={14}
              className="animate-spin text-primary-6"
            />
          ) : (
            <HugeiconsIcon
              icon={Clock01Icon}
              data-icon="clock"
              size={14}
              className={isEditing ? "text-primary-6" : "text-text-2"}
            />
          )}
        </div>
        <span
          className={`${COMPOSER_STACK_ROW_LABEL} ${isEditing ? "!text-primary-6" : ""}`}
        >
          {preview}
        </span>
        {isSendingNow && (
          <span className="shrink-0 text-[10px] text-primary-6">
            {t("common:labels.sendingNow")}
          </span>
        )}
        {!isEditing && !isSendingNow && (
          <span className={COMPOSER_STACK_ROW_ACTIONS}>
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon icon={Pen01Icon} data-icon="pencil" size={12} />
              }
              iconOnly
              className="enabled:hover:bg-fill-3 enabled:hover:text-text-1"
              onClick={() => onStartEdit(msg)}
              title={t("common:actions.edit")}
            />
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={Delete02Icon}
                  data-icon="trash-2"
                  size={12}
                />
              }
              iconOnly
              className="enabled:hover:bg-fill-3 enabled:hover:text-danger-6"
              onClick={() => onCancel(msg.id)}
              title={t("common:actions.delete")}
            />
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={ArrowUp02Icon}
                  data-icon="arrow-up"
                  size={12}
                />
              }
              iconOnly
              className="enabled:hover:bg-fill-3 enabled:hover:text-primary-6"
              onClick={() => onSendNow(msg.id)}
              title={t("common:actions.sendNow")}
              data-testid="queued-message-send-now"
            />
          </span>
        )}
      </div>
    );
  }
);

QueuedMessageItem.displayName = "QueuedMessageItem";

export default QueuedMessageItem;
