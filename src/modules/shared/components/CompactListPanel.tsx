import React, { type ReactNode, useCallback, useMemo, useRef } from "react";

import { LIST_PANEL_SECTIONS, ListPanelItem } from "@src/components/ListPanel";
import {
  ListPanelScrollArea,
  LoadingBar,
} from "@src/modules/shared/layouts/blocks";

export interface CompactListPanelEntry {
  key: string;
  title: string;
  titlePrefix?: string;
  time?: string;
  preview?: string;
  metadata?: ReactNode;
  leading: ReactNode;
  leadingClassName?: string;
  unread?: boolean;
  ariaLabel: string;
  dataAttributes?: Record<
    `data-${string}`,
    boolean | number | string | undefined
  >;
  onSelect: () => void;
}

export interface CompactListPanelProps {
  ariaLabel: string;
  entries: readonly CompactListPanelEntry[];
  selectedEntryKey: string | null;
  loading?: boolean;
  emptyContent?: ReactNode;
  footer?: ReactNode;
  testId?: string;
}

/**
 * Inbox-format navigation list for the left side of a two-pane surface.
 * Domain adapters provide row content while this component owns layout and
 * keyboard navigation.
 */
const CompactListPanel: React.FC<CompactListPanelProps> = ({
  ariaLabel,
  entries,
  selectedEntryKey,
  loading = false,
  emptyContent,
  footer,
  testId = "compact-list-panel",
}) => {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedIndex = useMemo(
    () => entries.findIndex((entry) => entry.key === selectedEntryKey),
    [entries, selectedEntryKey]
  );
  const focusableEntryKey =
    selectedIndex >= 0 ? selectedEntryKey : (entries[0]?.key ?? null);
  const selectAt = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return;
      entry.onSelect();
      rowRefs.current.get(entry.key)?.focus();
    },
    [entries]
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (entries.length === 0) return;
      const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
      let nextIndex: number | null = null;
      switch (event.key) {
        case "ArrowDown":
          nextIndex = Math.min(currentIndex + 1, entries.length - 1);
          break;
        case "ArrowUp":
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = entries.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      selectAt(nextIndex);
    },
    [entries.length, selectAt, selectedIndex]
  );

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {loading ? <LoadingBar /> : null}
      <ListPanelScrollArea listPaddingTop="none">
        {entries.length > 0 ? (
          <div
            className={LIST_PANEL_SECTIONS.sectionGroupItems}
            role="listbox"
            aria-label={ariaLabel}
            onKeyDown={handleKeyDown}
          >
            {entries.map((entry) => {
              const selected = entry.key === selectedEntryKey;
              return (
                <ListPanelItem
                  key={entry.key}
                  ref={(node) => {
                    if (node) rowRefs.current.set(entry.key, node);
                    else rowRefs.current.delete(entry.key);
                  }}
                  id={entry.key}
                  selected={selected}
                  role="option"
                  tabIndex={entry.key === focusableEntryKey ? 0 : -1}
                  ariaCurrent={selected ? "true" : undefined}
                  ariaLabel={entry.ariaLabel}
                  title={entry.title}
                  titlePrefix={entry.titlePrefix}
                  time={entry.time}
                  preview={entry.preview}
                  metadata={entry.metadata}
                  leading={entry.leading}
                  leadingClassName={entry.leadingClassName}
                  unread={entry.unread}
                  dataAttributes={entry.dataAttributes}
                  onClick={entry.onSelect}
                />
              );
            })}
          </div>
        ) : (
          emptyContent
        )}
      </ListPanelScrollArea>
      {footer}
    </section>
  );
};

export default CompactListPanel;
