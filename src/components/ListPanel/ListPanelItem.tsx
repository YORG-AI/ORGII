import { type AriaAttributes, type ReactNode, forwardRef } from "react";

import { getListItemClasses } from "./tokens";

type ListPanelItemDataAttributes = Record<
  `data-${string}`,
  boolean | number | string | undefined
>;

export interface ListPanelItemProps {
  id: string;
  selected: boolean;
  title: string;
  titlePrefix?: string;
  time?: string;
  preview?: string;
  metadata?: ReactNode;
  leading: ReactNode;
  leadingClassName?: string;
  unread?: boolean;
  ariaLabel: string;
  ariaCurrent?: AriaAttributes["aria-current"];
  role?: "option";
  tabIndex?: number;
  dataAttributes?: ListPanelItemDataAttributes;
  onClick: () => void;
}

/** Compact, borderless row shared by Inbox-style list/detail panels. */
const ListPanelItem = forwardRef<HTMLButtonElement, ListPanelItemProps>(
  (
    {
      id,
      selected,
      title,
      titlePrefix,
      time,
      preview,
      metadata,
      leading,
      leadingClassName = "text-text-2",
      unread = false,
      ariaLabel,
      ariaCurrent,
      role,
      tabIndex,
      dataAttributes,
      onClick,
    },
    ref
  ) => (
    <button
      {...dataAttributes}
      ref={ref}
      id={id}
      type="button"
      role={role}
      aria-label={ariaLabel}
      aria-selected={role === "option" ? selected : undefined}
      aria-current={ariaCurrent}
      tabIndex={tabIndex}
      data-list-panel-item
      className={`${getListItemClasses(selected)} block! w-full min-w-0 py-1.5! text-left`}
      onClick={onClick}
    >
      <span className="flex h-4 min-w-0 items-center gap-2">
        <span
          className={`flex h-4 w-5 shrink-0 items-center justify-center ${leadingClassName}`}
          aria-hidden
        >
          {leading}
        </span>
        {unread ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary-6"
            aria-hidden
          />
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {titlePrefix ? (
            <span className="shrink-0 text-xs font-semibold text-text-3">
              {titlePrefix}
            </span>
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate text-xs text-text-1 ${unread ? "font-semibold" : "font-medium"}`}
          >
            {title}
          </span>
        </span>
        {time ? (
          <span className="ml-auto shrink-0 text-xs font-normal text-text-3">
            {time}
          </span>
        ) : null}
      </span>
      {preview || metadata ? (
        <div className="mt-0.5 flex h-5 min-w-0 items-center gap-1.5 pl-7 text-xs leading-5 font-normal">
          {preview ? (
            <span
              className="min-w-0 flex-1 truncate text-text-1"
              title={preview}
            >
              {preview}
            </span>
          ) : null}
          {preview && metadata ? (
            <span className="shrink-0 text-text-3" aria-hidden>
              ·
            </span>
          ) : null}
          {metadata ? (
            <span
              className={`${preview ? "shrink" : "flex-1"} flex min-w-0 items-center gap-1.5 text-text-2`}
            >
              {metadata}
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  )
);

ListPanelItem.displayName = "ListPanelItem";

export default ListPanelItem;
