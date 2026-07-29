/**
 * QueuedMessages Component
 *
 * Renders queued messages that attach to the top of InputArea (like CompactFileChanges).
 * Supports drag-and-drop reordering via dnd-kit (vertical sortable list).
 *
 * Edit triggers the main input box via queueEditTargetAtom.
 *
 * Exports `reorderActiveRef` — a module-level flag so the parent file drop zone
 * can check synchronously whether a queue reorder drag is in progress and skip
 * showing the file drop overlay.
 */
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  closestCenter,
} from "@dnd-kit/core";
import {
  restrictToParentElement,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useAtomValue, useSetAtom } from "jotai";
import { MessageCircleMore } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS,
  CHAT_COMPOSER_STACK_BAR_SURFACE_BG_CLASS,
} from "@src/config/composerStackTokens";
import { useWebViewSensors } from "@src/lib/dndKit";
import {
  type QueuedMessage,
  queueEditTargetAtom,
} from "@src/store/ui/messageQueueAtom";

import ComposerStackHeader from "./ComposerStackHeader";
import QueuedMessageItem from "./QueuedMessageItem";

/**
 * Module-level flag — set synchronously in onDragStart, cleared in onDragEnd.
 * Accessible by global drag detection to skip file drop overlay during reorder.
 */
export const reorderActiveRef = { current: false };

export interface QueuedMessagesProps {
  messages: QueuedMessage[];
  onCancel: (messageId: string) => void;
  onSendNow: (messageId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Called when the user closes the card (header collapse button). */
  onToggle: () => void;
}

const QueuedMessages: React.FC<QueuedMessagesProps> = memo(
  ({ messages, onCancel, onSendNow, onReorder, onToggle }) => {
    const { t } = useTranslation();
    const setEditTarget = useSetAtom(queueEditTargetAtom);
    const editTarget = useAtomValue(queueEditTargetAtom);

    // Clear edit target if the message being edited was removed from the queue
    useEffect(() => {
      if (
        editTarget &&
        !messages.some((msg) => msg.id === editTarget.messageId)
      ) {
        setEditTarget(null);
      }
    }, [messages, editTarget, setEditTarget]);

    const [draggingId, setDraggingId] = useState<string | null>(null);

    const sensors = useWebViewSensors({ activationDistance: 5 });
    const sortableIds = useMemo(
      () => messages.map((msg) => msg.id),
      [messages]
    );

    const handleDragStart = useCallback((event: DragStartEvent) => {
      reorderActiveRef.current = true;
      setDraggingId(event.active.id as string);
    }, []);

    const handleDragEnd = useCallback(
      (event: DragEndEvent) => {
        reorderActiveRef.current = false;
        setDraggingId(null);
        const { active, over } = event;
        if (over && active.id !== over.id) {
          const oldIndex = messages.findIndex((msg) => msg.id === active.id);
          const newIndex = messages.findIndex((msg) => msg.id === over.id);
          if (oldIndex !== -1 && newIndex !== -1) {
            onReorder(oldIndex, newIndex);
          }
        }
      },
      [messages, onReorder]
    );

    const handleDragCancel = useCallback(() => {
      reorderActiveRef.current = false;
      setDraggingId(null);
    }, []);

    const startEdit = useCallback(
      (msg: QueuedMessage) => {
        setEditTarget({
          messageId: msg.id,
          content: msg.content,
          imageDataUrls: msg.imageDataUrls,
        });
      },
      [setEditTarget]
    );

    if (messages.length === 0) return null;

    const draggable = messages.length > 1;

    return (
      <div
        className={`${CHAT_COMPOSER_STACK_BAR_SURFACE_BG_CLASS} overflow-hidden rounded-lg border border-solid border-border-2`}
      >
        <ComposerStackHeader
          icon={<MessageCircleMore size={14} />}
          label={t("common:labels.queuedCount", { count: messages.length })}
          actions={
            draggable ? (
              <span className="text-[10px] text-text-4">
                {t("common:labels.dragToReorder")}
              </span>
            ) : undefined
          }
          expanded={true}
          onToggle={onToggle}
        />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={sortableIds}
            strategy={verticalListSortingStrategy}
          >
            <div
              className={`${CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS} max-h-[192px] overflow-y-auto pb-1`}
            >
              {messages.map((msg) => (
                <QueuedMessageItem
                  key={msg.id}
                  msg={msg}
                  draggable={draggable}
                  isDragging={draggingId === msg.id}
                  isEditing={editTarget?.messageId === msg.id}
                  onStartEdit={startEdit}
                  onSendNow={onSendNow}
                  onCancel={onCancel}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    );
  }
);

QueuedMessages.displayName = "QueuedMessages";

export default QueuedMessages;
