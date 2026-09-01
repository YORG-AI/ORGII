import React, { useEffect, useRef } from "react";

import SegmentedTextPill, {
  type SegmentedTextPillProps,
} from "@src/components/SegmentedTextPill";
import Tooltip from "@src/components/Tooltip";

export interface SpotlightTabsProps<
  T extends string,
> extends SegmentedTextPillProps<T> {
  /** Compact search-row pill, or raised tabs attached to the result divider. */
  format?: "pill" | "attached";
  /** Palettes with Tab section navigation can retain Ctrl+Tab for tabs. */
  shortcut?: "tab" | "ctrlTab";
}

/**
 * Shared picker tabs. Shortcuts are scoped to the closest Spotlight shell or
 * dialog; embedded pickers can mark their root with data-spotlight-tabs-scope.
 */
export function SpotlightTabs<T extends string>({
  format = "pill",
  shortcut = "tab",
  ...props
}: SpotlightTabsProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { options, value, onChange } = props;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.metaKey
      )
        return;
      const container = containerRef.current;
      const scope = container?.closest(
        "[data-spotlight-container], [data-spotlight-tabs-scope], [role='dialog']"
      );
      if (!(event.target instanceof Node) || !scope?.contains(event.target))
        return;
      const withinTabs = container?.contains(event.target);

      // Activate the focused control before any document-level row navigation.
      if (withinTabs && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.target instanceof HTMLButtonElement) event.target.click();
        return;
      }

      const switchWithTab =
        event.key === "Tab" && event.ctrlKey === (shortcut === "ctrlTab");
      const switchWithArrow =
        withinTabs &&
        !event.ctrlKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight");
      if (switchWithTab || switchWithArrow) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const enabled = options.filter((option) => !option.disabled);
        if (enabled.length === 0) return;
        const current = enabled.findIndex((option) => option.value === value);
        const forward = switchWithTab
          ? !event.shiftKey
          : event.key === "ArrowRight";
        const next =
          current < 0
            ? forward
              ? 0
              : enabled.length - 1
            : (current + (forward ? 1 : -1) + enabled.length) % enabled.length;
        onChange(enabled[next].value);
        const nextButton = container?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)"
        )[next];
        if (switchWithArrow) {
          nextButton?.focus();
        } else {
          if (format === "attached") {
            nextButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
          scope
            .querySelector<HTMLInputElement>(
              "input[data-spotlight-input], input[type='text']"
            )
            ?.focus();
        }
      } else if (withinTabs && event.key === "Tab") {
        // Ctrl+Tab palettes still permit native focus traversal through controls.
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [format, onChange, options, shortcut, value]);

  return (
    <div
      ref={containerRef}
      className={
        format === "attached" ? "mb-2 shrink-0 overflow-x-auto" : "contents"
      }
    >
      {format === "pill" ? (
        <SegmentedTextPill {...props} />
      ) : (
        <div
          role="tablist"
          aria-label={props.ariaLabel}
          data-testid={props.dataTestId}
          className={`flex min-w-max items-end gap-px border-b border-border-2 px-2 ${props.className ?? ""}`}
        >
          {options.map((option) => {
            const active = option.value === value;
            const tab = (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={option.ariaLabel}
                disabled={option.disabled}
                tabIndex={active ? 0 : -1}
                onClick={() => onChange(option.value)}
                className={`relative -mb-px flex shrink-0 items-center gap-1.5 rounded-t-md border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-6 ${
                  active
                    ? "border-border-2 border-b-bg-2 bg-bg-2 text-text-1"
                    : "border-transparent text-text-2 hover:bg-fill-1 hover:text-text-1"
                } ${option.disabled ? "cursor-not-allowed opacity-50" : ""}`}
              >
                {option.label}
              </button>
            );
            return option.tooltip ? (
              <Tooltip
                key={option.value}
                content={option.tooltip}
                position="top"
              >
                {tab}
              </Tooltip>
            ) : (
              tab
            );
          })}
        </div>
      )}
    </div>
  );
}
