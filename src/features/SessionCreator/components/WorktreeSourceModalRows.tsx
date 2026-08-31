import type { ReactNode } from "react";

import { getListItemClasses } from "@src/components/ListPanel";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";

const SOURCE_LIST_CLASS =
  "min-h-0 max-h-72 w-full flex-1 overflow-y-auto overscroll-contain p-0 scrollbar-hide";

export function WorktreeSourceList({ children }: { children: ReactNode }) {
  return <div className={SOURCE_LIST_CLASS}>{children}</div>;
}

export function WorktreeSourceRow({
  icon,
  title,
  detail,
  meta,
  selected,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  meta?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${getListItemClasses(selected)} min-h-8 w-full min-w-0 !rounded-md !px-2 !py-1 text-left`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-3">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium leading-5 text-text-1">
          {title}
        </span>
        {detail && (
          <span className="block truncate text-xs font-normal leading-4 text-text-3">
            {detail}
          </span>
        )}
      </span>
      {meta && (
        <span className="shrink-0 text-xs font-normal tabular-nums leading-4 text-text-3">
          {meta}
        </span>
      )}
      {selected && (
        <HugeiconsIcon
          icon={Tick01Icon}
          data-icon="check"
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-primary-6"
        />
      )}
    </button>
  );
}
