import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

const SELECTED_ROW_CLASS = "settings-table-row-selected";

export function selectedRowClassName<T>(
  getKey: (row: T) => string,
  selectedId: string | undefined | null
): ((row: T, index: number) => string) | undefined {
  if (!selectedId) return undefined;
  return (row: T) => (getKey(row) === selectedId ? SELECTED_ROW_CLASS : "");
}

export { default as StatusDot } from "@src/components/StatusDot";
export type { StatusDotProps } from "@src/components/StatusDot";

export function RowChevron({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="ml-auto rounded p-1 text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
    >
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        data-icon="chevron-right"
        size={14}
      />
    </button>
  );
}

export function OverviewContent({
  description,
  items,
  footer,
}: {
  description: string;
  items: { label: string; text: string }[];
  footer?: string;
}) {
  return (
    <div className="rounded-lg bg-fill-2 p-5 text-[13px] leading-relaxed text-text-2">
      <p className="mb-4">{description}</p>
      <div className="space-y-2">
        {items.map((item) => (
          <p key={item.label}>
            <span className="font-medium text-text-1">{item.label}</span>
            {" — "}
            {item.text}
          </p>
        ))}
      </div>
      {footer && (
        <p className="mt-4 border-t border-border-2 pt-3 text-text-3">
          {footer}
        </p>
      )}
    </div>
  );
}
