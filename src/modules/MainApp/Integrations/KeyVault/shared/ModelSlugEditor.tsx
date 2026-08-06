import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ZENMUX_PROVIDER_SLUGS } from "@src/api/tauri/rpc/schemas/validation";
import Tooltip from "@src/components/Tooltip";

interface ModelSlugEditorProps {
  /** Base model id the slug pins (e.g. `deepseek/deepseek-v4-flash`). */
  model: string;
  /** Currently configured supplier slug (e.g. `deepseek`), if any. */
  slug?: string;
  /** Persist a new slug; pass an empty/whitespace string to clear it. */
  onChange: (slug: string) => void;
}

/**
 * Compact inline editor for a model's aggregator supplier slug.
 *
 * The slug is appended to the model id at launch time (`model:slug`, e.g.
 * `deepseek/deepseek-v4-flash:deepseek`) so ZenMux-style aggregators pin the
 * upstream supplier instead of free-routing. Debounced; commits on blur.
 */
const ModelSlugEditor: React.FC<ModelSlugEditorProps> = ({
  model,
  slug,
  onChange,
}) => {
  const { t } = useTranslation("integrations");
  const [draft, setDraft] = useState(slug ?? "");
  const [focused, setFocused] = useState(false);

  // Sync external updates (e.g. account refresh) unless the user is editing.
  useEffect(() => {
    if (!focused) setDraft(slug ?? "");
  }, [slug, focused]);

  const commit = () => {
    const next = draft.trim();
    if (next !== (slug ?? "").trim()) onChange(next);
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5 py-1">
      <label
        htmlFor={`model-slug-${model}`}
        className="shrink-0 text-[11px] font-medium leading-none text-text-3"
      >
        {t("modelsTable.supplierSlug")}
      </label>
      <select
        id={`model-slug-${model}`}
        data-testid="model-slug-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(slug ?? "");
            event.currentTarget.blur();
          }
        }}
        className="focus:border-accent-4 h-[24px] min-w-0 flex-1 rounded border border-border-2 bg-fill-1 px-1.5 text-[12px] leading-none text-text-1 outline-none"
      >
        <option value="">{t("modelsTable.supplierSlugPlaceholder")}</option>
        {ZENMUX_PROVIDER_SLUGS.map((providerSlug) => (
          <option key={providerSlug} value={providerSlug}>
            {providerSlug}
          </option>
        ))}
      </select>
      <Tooltip
        content={t("modelsTable.supplierSlugHint", {
          model: `${model}:${draft.trim() || "…"}`,
        })}
        position="top"
      >
        <span className="shrink-0 cursor-help text-[11px] leading-none text-text-4">
          ?
        </span>
      </Tooltip>
    </div>
  );
};

export default ModelSlugEditor;
