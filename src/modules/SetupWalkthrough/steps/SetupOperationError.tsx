import React from "react";

import InlineAlert from "@src/components/InlineAlert";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

import type { StepProps } from "./types";

export const SetupOperationError: React.FC<StepProps> = ({ controller }) =>
  controller.operationError ? (
    <div
      className={`${DETAIL_PANEL_TOKENS.contentWidth} ${DETAIL_PANEL_TOKENS.contentPaddingBottom}`}
    >
      <InlineAlert type="danger" role="alert">
        {controller.operationError}
      </InlineAlert>
    </div>
  ) : null;
