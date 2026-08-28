/**
 * MessagesSidebar — Row sub-components
 *
 * Aggregate filter rows for Messages / Todos / Interactions. Each row maps
 * one→one to a MessageViewMode in the right pane; the sidebar is purely a
 * filter picker, never a per-event list (per-event fan-out lived here
 * previously and was removed alongside the per-event tab fan-out in
 * useReplayTabs).
 */
import React, { memo } from "react";

import { TreeRowBase, type TreeRowNode } from "@src/components/TreeRow";
import {
  HugeiconsIcon,
  ListTodoIcon,
  MessageCircleQuestionMarkIcon,
  MessageMultiple01Icon,
} from "@src/icons";

// ── AggregateMessagesRow ─────────────────────────────────────────────────────

interface AggregateMessagesRowProps {
  title: string;
  count: number;
  isSelected: boolean;
  onSelect: () => void;
}

export const AggregateMessagesRow: React.FC<AggregateMessagesRowProps> = memo(
  ({ title, count, isSelected, onSelect }) => {
    const node: TreeRowNode = {
      id: "communication-messages",
      name: title,
      path: title,
      type: "file",
      icon: (
        <HugeiconsIcon
          icon={MessageMultiple01Icon}
          data-icon="messages-square"
          size={14}
          strokeWidth={1.75}
          className="text-text-3"
        />
      ),
    };

    return (
      <TreeRowBase
        node={node}
        depth={0}
        isSelected={isSelected}
        onClick={onSelect}
        showIndentGuides={false}
      >
        <span className="ml-auto shrink-0 text-[11px] text-text-3">
          {count}
        </span>
      </TreeRowBase>
    );
  }
);
AggregateMessagesRow.displayName = "AggregateMessagesRow";

// ── AggregateTodoRow ─────────────────────────────────────────────────────────

interface AggregateTodoRowProps {
  title: string;
  count: number;
  isSelected: boolean;
  onSelect: () => void;
}

export const AggregateTodoRow: React.FC<AggregateTodoRowProps> = memo(
  ({ title, count, isSelected, onSelect }) => {
    const node: TreeRowNode = {
      id: "communication-todo-list",
      name: title,
      path: title,
      type: "file",
      icon: (
        <HugeiconsIcon
          icon={ListTodoIcon}
          data-icon="list-todo"
          size={14}
          strokeWidth={1.75}
          className="text-text-3"
        />
      ),
    };

    return (
      <TreeRowBase
        node={node}
        depth={0}
        isSelected={isSelected}
        onClick={onSelect}
        showIndentGuides={false}
      >
        <span className="ml-auto shrink-0 text-[11px] text-text-3">
          {count}
        </span>
      </TreeRowBase>
    );
  }
);
AggregateTodoRow.displayName = "AggregateTodoRow";

// ── AggregateInteractionsRow ─────────────────────────────────────────────────

interface AggregateInteractionsRowProps {
  title: string;
  count: number;
  isSelected: boolean;
  onSelect: () => void;
}

export const AggregateInteractionsRow: React.FC<AggregateInteractionsRowProps> =
  memo(({ title, count, isSelected, onSelect }) => {
    const node: TreeRowNode = {
      id: "communication-interactions",
      name: title,
      path: title,
      type: "file",
      icon: (
        <HugeiconsIcon
          icon={MessageCircleQuestionMarkIcon}
          data-icon="message-circle-question-mark"
          size={14}
          strokeWidth={1.75}
          className="text-text-3"
        />
      ),
    };

    return (
      <TreeRowBase
        node={node}
        depth={0}
        isSelected={isSelected}
        onClick={onSelect}
        showIndentGuides={false}
      >
        <span className="ml-auto shrink-0 text-[11px] text-text-3">
          {count}
        </span>
      </TreeRowBase>
    );
  });
AggregateInteractionsRow.displayName = "AggregateInteractionsRow";
