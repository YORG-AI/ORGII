import React from "react";

import ModelSelectorPill from "@src/components/ModelSelectorPill";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";

import { AgentControlSubmitButton } from "./AgentControlSubmitButton";

interface AgentControlInputTrailingProps {
  selection: LastModelSelection | null;
  /** Placeholder shown until a model is picked. Names the thing ("Model"),
   *  matching every other ModelSelectorPill and the hook's own fallback. */
  modelLabel: string;
  /** Accessible name. Names the action ("Select model"). */
  selectModelLabel: string;
  modelSelectorActive: boolean;
  onOpenModelSelector: () => void;
  submitDisabled: boolean;
  onSubmit: () => void;
}

export const AgentControlInputTrailing: React.FC<
  AgentControlInputTrailingProps
> = ({
  selection,
  modelLabel,
  selectModelLabel,
  modelSelectorActive,
  onOpenModelSelector,
  submitDisabled,
  onSubmit,
}) => {
  return (
    <div className="flex items-center gap-2">
      <ModelSelectorPill
        selection={selection}
        defaultLabel={modelLabel}
        active={modelSelectorActive}
        className="h-[28px] max-w-[180px] shrink-0 text-[13px]"
        dataTestId="agent-control-model-pill"
        ariaLabel={selectModelLabel}
        onClick={onOpenModelSelector}
      />
      <AgentControlSubmitButton disabled={submitDisabled} onSubmit={onSubmit} />
    </div>
  );
};
