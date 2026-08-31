import type { ReactNode } from "react";

export interface DetailTabStripItem<Key extends string = string> {
  key: Key;
  label: string;
  icon?: ReactNode;
  count?: number | string;
  /** Reserve the count badge while its value is being loaded. */
  countLoading?: boolean;
  disabled?: boolean;
  dataTestId?: string;
}

export interface DetailTabStripProps<Key extends string = string> {
  activeTab: Key;
  ariaLabel: string;
  idPrefix: string;
  onChange: (key: Key) => void;
  tabs: readonly DetailTabStripItem<Key>[];
  className?: string;
  trailing?: ReactNode;
  /** Full-width content row or compact tabs embedded in a 40px header. */
  variant?: "row" | "header";
}

/**
 * Shared bordered detail navigation used by dense entity surfaces such as
 * pull requests and projects. The active tab visually joins the content pane
 * below while inactive tabs retain a lightweight hover treatment.
 */
export default function DetailTabStrip<Key extends string>({
  activeTab,
  ariaLabel,
  idPrefix,
  onChange,
  tabs,
  className = "",
  trailing,
  variant = "row",
}: DetailTabStripProps<Key>) {
  const isHeaderVariant = variant === "header";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`flex shrink-0 items-end gap-px ${
        isHeaderVariant
          ? "h-10 min-w-0"
          : "border-b border-border-2 bg-bg-2 pl-3 pr-[7px]"
      } ${className}`.trim()}
    >
      {tabs.map((tab) => {
        const selected = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.key}`}
            aria-controls={`${idPrefix}-tabpanel-${tab.key}`}
            aria-selected={selected}
            aria-busy={tab.countLoading || undefined}
            disabled={tab.disabled}
            data-testid={tab.dataTestId}
            className={`relative -mb-px flex shrink-0 items-center gap-1.5 rounded-t-md border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? "z-10 border-border-2 border-b-bg-2 bg-bg-2 text-text-1 after:absolute after:-bottom-px after:left-0 after:right-0 after:h-px after:bg-bg-2"
                : "border-transparent text-text-2 hover:bg-fill-1 hover:text-text-1"
            }`}
            onClick={() => onChange(tab.key)}
          >
            {tab.icon ? (
              <span className="shrink-0" aria-hidden>
                {tab.icon}
              </span>
            ) : null}
            <span>{tab.label}</span>
            {tab.countLoading || tab.count !== undefined ? (
              <span
                aria-hidden={tab.countLoading || undefined}
                data-testid={
                  tab.countLoading ? "detail-tab-count-skeleton" : undefined
                }
                className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-fill-2 px-1.5 text-[10px] font-semibold tabular-nums text-text-2 ${tab.countLoading ? "animate-pulse motion-reduce:animate-none" : ""}`.trim()}
              >
                {tab.countLoading ? null : tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
      {trailing ? (
        <div className="ml-auto flex shrink-0 items-center self-center pl-3">
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
