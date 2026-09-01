/**
 * ModelSelectionBreadcrumb
 *
 * Spotlight-style account › model breadcrumb used in model palette rows
 * and model-pill hover tooltips.
 */
import React, { memo } from "react";

import type { ModelType } from "@src/api/tauri/rpc/schemas/validation";
import ModelIcon from "@src/components/ModelIcon";
import { BrainIcon, HugeiconsIcon } from "@src/icons";

interface ModelSelectionBreadcrumbProps {
  /** Key vault account name or hosted listing label */
  accountName?: string;
  /** Resolved model display label (alias or formatted id) */
  modelLabel: string;
  /** Wire model id for the model icon */
  modelId?: string;
  /** Provider / agent type for the account icon when model id is absent */
  modelType?: ModelType;
  /** Smaller variant detail shown after the model label. */
  variantInfo?: string;
  /** Whether to show the Thinking icon after the model label. */
  thinking?: boolean;
  /** Raw wire model value shown as secondary breadcrumb detail. */
  rawValue?: string;
  /** Allow longer model ids to wrap instead of truncating (wide tooltips). */
  wide?: boolean;
  className?: string;
}

export const ModelSelectionBreadcrumb: React.FC<ModelSelectionBreadcrumbProps> =
  memo(
    ({
      accountName,
      modelLabel,
      modelId,
      modelType,
      variantInfo,
      thinking = false,
      rawValue,
      wide = false,
      className = "",
    }) => (
      <span
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 text-[13px] ${
          wide ? "flex-wrap whitespace-normal" : ""
        } ${className}`}
      >
        {accountName ? (
          <>
            <span
              className={
                wide ? "min-w-0 break-all text-text-2" : "shrink-0 text-text-2"
              }
            >
              {accountName}
            </span>
            <span className="mx-1 shrink-0 text-text-3">›</span>
          </>
        ) : null}
        {modelId || modelType ? (
          <ModelIcon
            modelName={modelId}
            agentType={modelType}
            size={14}
            className="shrink-0"
          />
        ) : null}
        <span
          className={`min-w-0 font-semibold text-text-1 ${
            wide ? "whitespace-normal break-all" : "truncate"
          }`}
        >
          {modelLabel}
        </span>
        {(thinking || variantInfo) && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-text-3">
            {thinking && (
              <HugeiconsIcon
                icon={BrainIcon}
                data-icon="brain"
                size={11}
                strokeWidth={1.8}
              />
            )}
            {variantInfo && <span>{variantInfo}</span>}
          </span>
        )}
        {rawValue && rawValue !== modelLabel ? (
          <span className="min-w-0 truncate text-[11px] text-text-3">
            {rawValue}
          </span>
        ) : null}
      </span>
    )
  );

ModelSelectionBreadcrumb.displayName = "ModelSelectionBreadcrumb";

export default ModelSelectionBreadcrumb;
