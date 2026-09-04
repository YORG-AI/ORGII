import React from "react";

import GhostBar from "@src/components/Ghost";

import { LIST_ITEM } from "./tokens";

/**
 * Ghost rows mirror `ListPanelItem`'s two-line geometry so the panel keeps its
 * height and rhythm while rows load, and real rows land without the list
 * jumping. Widths cycle so a stack does not read as a grid.
 */
const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3"] as const;
const META_WIDTHS = ["w-1/3", "w-1/4", "w-2/5", "w-1/3"] as const;

interface ListPanelGhostItemProps {
  /** Position in the ghost stack; selects the width variant. */
  index?: number;
}

/** A single placeholder row shaped like a loaded `ListPanelItem`. */
const ListPanelGhostItem: React.FC<ListPanelGhostItemProps> = ({
  index = 0,
}) => (
  <div
    aria-hidden
    data-testid="list-panel-ghost-item"
    className={`${LIST_ITEM.paddingXClass} ${LIST_ITEM.borderRadiusClass} w-full min-w-0 py-1.5`}
  >
    <span className="flex h-4 min-w-0 items-center gap-2">
      <span className="flex h-4 w-5 shrink-0 items-center justify-center">
        <GhostBar className="size-3.5 rounded-full" />
      </span>
      <GhostBar
        className={`h-3 ${TITLE_WIDTHS[index % TITLE_WIDTHS.length]}`}
      />
      <GhostBar className="ml-auto h-3 w-5" />
    </span>
    <span className="mt-0.5 flex h-5 min-w-0 items-center pl-7">
      <GhostBar className={`h-3 ${META_WIDTHS[index % META_WIDTHS.length]}`} />
    </span>
  </div>
);

export interface ListPanelGhostListProps {
  /** Rows to render. The default fills a typical sidebar without scrolling. */
  count?: number;
}

/**
 * A stack of ghost rows. Hidden from assistive tech on purpose: the loading
 * state is already announced by the surface's own progress indicator, and a
 * second announcement for decorative shapes is noise.
 */
export const ListPanelGhostList: React.FC<ListPanelGhostListProps> = ({
  count = 7,
}) => (
  <div
    aria-hidden
    data-testid="list-panel-ghost-list"
    className="flex flex-col gap-0.5"
  >
    {Array.from({ length: count }, (_, index) => (
      <ListPanelGhostItem key={index} index={index} />
    ))}
  </div>
);
