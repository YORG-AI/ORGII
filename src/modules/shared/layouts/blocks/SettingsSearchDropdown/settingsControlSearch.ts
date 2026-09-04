const SETTINGS_SURFACE_SELECTOR = "[data-settings-surface]";
const SETTINGS_ROW_SELECTOR = "[data-settings-search-row]";
const SETTINGS_LABEL_SELECTOR = "[data-settings-search-label]";
const SETTINGS_DESCRIPTION_SELECTOR = "[data-settings-search-description]";
const SETTINGS_KEYS_ATTRIBUTE = "data-settings-search-keys";
const FOCUSABLE_CONTROL_SELECTOR = [
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "button:not([disabled])",
  '[role="switch"]:not([aria-disabled="true"])',
  '[role="combobox"]:not([aria-disabled="true"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface RenderedSettingsControl {
  readonly targetId: string;
  readonly searchKeys: readonly string[];
  readonly label: string;
  readonly description?: string;
}

export interface SettingsControlSearchTarget {
  readonly targetId?: string;
  readonly searchKey?: string;
  readonly label?: string;
}

function normalizeRenderedText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Snapshot the searchable rows from the live Settings page.
 *
 * SectionRow owns the markers, so newly added or relabelled rows become
 * searchable without a second catalog or registration effect. This only runs
 * while the user types; no observer or idle scan is retained in the app.
 */
export function collectRenderedSettingsControls(
  root: ParentNode = document
): RenderedSettingsControl[] {
  const controls: RenderedSettingsControl[] = [];
  const rows = root.querySelectorAll<HTMLElement>(
    `${SETTINGS_SURFACE_SELECTOR} ${SETTINGS_ROW_SELECTOR}`
  );

  for (const row of rows) {
    const targetId = row.id;
    const label = normalizeRenderedText(
      row.querySelector<HTMLElement>(SETTINGS_LABEL_SELECTOR)?.textContent
    ).replace(/\s*\*$/, "");
    if (!targetId || !label) continue;

    const description = normalizeRenderedText(
      row.querySelector<HTMLElement>(SETTINGS_DESCRIPTION_SELECTOR)?.textContent
    );
    controls.push({
      targetId,
      searchKeys:
        row
          .getAttribute(SETTINGS_KEYS_ATTRIBUTE)
          ?.split(/\s+/)
          .filter(Boolean) ?? [],
      label,
      description: description || undefined,
    });
  }

  return controls;
}

/** Scroll the selected row into view and move keyboard focus to its control. */
export function revealRenderedSettingsControl(
  target: string | SettingsControlSearchTarget,
  root: ParentNode = document
): boolean {
  const resolvedTarget: SettingsControlSearchTarget =
    typeof target === "string" ? { targetId: target } : target;
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>(
      `${SETTINGS_SURFACE_SELECTOR} ${SETTINGS_ROW_SELECTOR}`
    )
  );
  const matchedRow = rows.find((row) => {
    if (resolvedTarget.targetId && row.id === resolvedTarget.targetId) {
      return true;
    }
    if (resolvedTarget.searchKey) {
      const keys =
        row
          .getAttribute(SETTINGS_KEYS_ATTRIBUTE)
          ?.split(/\s+/)
          .filter(Boolean) ?? [];
      if (keys.includes(resolvedTarget.searchKey)) return true;
    }
    if (resolvedTarget.label) {
      const label = normalizeRenderedText(
        row.querySelector<HTMLElement>(SETTINGS_LABEL_SELECTOR)?.textContent
      ).replace(/\s*\*$/, "");
      return label === resolvedTarget.label;
    }
    return false;
  });

  if (!matchedRow) return false;

  matchedRow.scrollIntoView?.({ behavior: "smooth", block: "center" });
  matchedRow.querySelector<HTMLElement>(FOCUSABLE_CONTROL_SELECTOR)?.focus({
    preventScroll: true,
  });
  return true;
}

/**
 * Wait for a route change or lazy settings surface, then reveal the target.
 * The observer exists only after selecting a result and always self-cleans.
 */
export function revealSettingsControlWhenRendered(
  target: SettingsControlSearchTarget,
  root: ParentNode = document,
  timeoutMs = 2000
): () => void {
  if (revealRenderedSettingsControl(target, root)) return () => undefined;

  const observer = new MutationObserver(() => {
    if (revealRenderedSettingsControl(target, root)) cleanup();
  });
  const observableRoot = root instanceof Document ? root.documentElement : root;
  observer.observe(observableRoot, { childList: true, subtree: true });
  const timeoutId = window.setTimeout(cleanup, timeoutMs);

  function cleanup(): void {
    observer.disconnect();
    window.clearTimeout(timeoutId);
  }

  return cleanup;
}
