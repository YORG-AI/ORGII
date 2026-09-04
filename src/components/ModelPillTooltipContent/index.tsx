/**
 * ModelPillTooltipContent
 *
 * Framed tooltip body for model pills: spotlight-style account › model
 * breadcrumb on the left, keyboard shortcut chip on the right.
 */
import React, { memo } from "react";

import type { ModelType } from "@src/api/tauri/rpc/schemas/validation";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import ModelSelectionBreadcrumb from "@src/components/ModelSelectionBreadcrumb";

interface ModelPillTooltipContentProps {
  accountName?: string;
  modelLabel: string;
  modelId?: string;
  modelType?: ModelType;
  variantInfo?: string;
  thinking?: boolean;
  rawValue?: string;
  shortcut: string;
}

export const ModelPillTooltipContent: React.FC<ModelPillTooltipContentProps> =
  memo(
    ({
      accountName,
      modelLabel,
      modelId,
      modelType,
      variantInfo,
      thinking,
      rawValue,
      shortcut,
    }) => (
      <KeyboardShortcutTooltipContent
        label={
          <ModelSelectionBreadcrumb
            accountName={accountName}
            modelLabel={modelLabel}
            modelId={modelId}
            modelType={modelType}
            variantInfo={variantInfo}
            thinking={thinking}
            rawValue={rawValue}
            wide
          />
        }
        shortcut={shortcut}
      />
    )
  );

ModelPillTooltipContent.displayName = "ModelPillTooltipContent";

export default ModelPillTooltipContent;
