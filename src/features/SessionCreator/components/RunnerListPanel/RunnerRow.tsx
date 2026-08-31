/**
 * One runner row: harness pill, model+effort pill, remove.
 *
 * Anatomy mirrors the Agent Team member row (`SessionCreatorOrgMembersPanel`)
 * — the same two pills opening the same two palettes — because a runner and a
 * team member ask the user the identical pair of questions.
 *
 * The row **wraps** rather than shrinking. Truncating "GPT 5.6 Sol · Extra
 * High" down to "GPT…" loses exactly the information the row exists to show,
 * so when the two pills cannot sit side by side the model group drops to its
 * own line intact.
 *
 * A blocked row says so through the pill that owns the problem — danger
 * styling plus the reason on hover — and never through a separate warning
 * line. The line duplicated the pill it sat under ("Pick a harness" twice),
 * and on a narrow panel it had no width left and rendered as a bare triangle.
 */
import React, { memo } from "react";

import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import { PILL_SM_ICON_SIZE } from "@src/components/CompoundPill/config";
import ModelIcon from "@src/components/ModelIcon";
import ModelSelectorPill from "@src/components/ModelSelectorPill";
import SelectorPill from "@src/components/SelectorPill";
import { resolveAgentIcon } from "@src/config/agentIcons";
import {
  RUNNER_BLOCKER,
  type RunnerBlocker,
} from "@src/features/SessionCreator/multiRunner/contract";
import { Infinity01Icon, Cancel01Icon, HugeiconsIcon } from "@src/icons";

import type { AdvancedConfig } from "../../types";
import type { RunnerAgentDisplay } from "./resolveRunnerAgent";

export interface RunnerRowProps {
  /** Position in the launcher, 1-based. Not rendered — the rows are a set, not
   *  a sequence — but kept as a test/e2e hook and to key the run-group entry. */
  ordinal: number;
  agentDisplay: RunnerAgentDisplay;
  /** Global creator config with this runner's override already folded in. */
  modelSelection: AdvancedConfig;
  modelLabel: string;
  /**
   * False until a harness is chosen. The model pill is withheld rather than
   * disabled: the harness scopes the model list, so before one is picked there
   * is no list to open and nothing truthful to display in the pill.
   */
  canPickModel: boolean;
  /**
   * Human-readable reason this row cannot launch; `null` when it can. Shown as
   * the harness pill's hover title rather than as its own line.
   */
  blockerNote: string | null;
  blocker: RunnerBlocker | null;
  isAgentPickerOpen: boolean;
  isModelPickerOpen: boolean;
  agentPickerLabel: string;
  modelPickerLabel: string;
  removeLabel: string;
  canRemove: boolean;
  onOpenAgentPicker: () => void;
  onOpenModelPicker: () => void;
  onVariantApply: (nextModelId: string) => void;
  onRemove: () => void;
}

const RunnerRow: React.FC<RunnerRowProps> = memo(
  ({
    ordinal,
    agentDisplay,
    modelSelection,
    modelLabel,
    canPickModel,
    blockerNote,
    blocker,
    isAgentPickerOpen,
    isModelPickerOpen,
    agentPickerLabel,
    modelPickerLabel,
    removeLabel,
    canRemove,
    onOpenAgentPicker,
    onOpenModelPicker,
    onVariantApply,
    onRemove,
  }) => {
    // A missing model is the model pill's problem — it already renders itself
    // danger — so only harness-side blockers colour the harness pill.
    const harnessBlocked =
      blocker !== null && blocker !== RUNNER_BLOCKER.NO_MODEL;
    // `resolveAgentIcon` returns glyph data for slug ids but a brand
    // COMPONENT for provider ids (claude, codex, …), so the row must render
    // through `AnyIcon`, which dispatches on the runtime shape.
    //
    // `block` is load-bearing: an inline SVG sits on the text baseline and its
    // line box reserves descender space, so the pill's hover icon→chevron swap
    // nudges it a sub-pixel and the icon visibly shakes.
    //
    // An unpicked row still gets an icon. Leaving the slot empty made the row
    // jump sideways the moment a harness was chosen; the placeholder holds the
    // width and reads as "anything could go here".
    const agentPillIcon = agentDisplay.iconId ? (
      <AnyIcon
        icon={resolveAgentIcon(agentDisplay.iconId)}
        size={PILL_SM_ICON_SIZE}
        className="block text-text-1"
      />
    ) : agentDisplay.cliAgentType ? (
      <ModelIcon
        agentType={agentDisplay.cliAgentType}
        size={PILL_SM_ICON_SIZE}
        className="block"
      />
    ) : (
      <HugeiconsIcon
        icon={Infinity01Icon}
        size={PILL_SM_ICON_SIZE}
        className="block"
      />
    );

    return (
      <li
        className="rounded-md px-2 py-1.5"
        data-testid="session-creator-runner-row"
        data-runner-ordinal={ordinal}
        data-runner-blocker={blocker ?? undefined}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <SelectorPill
            icon={agentPillIcon}
            label={agentDisplay.label}
            title={
              harnessBlocked
                ? (blockerNote ?? agentDisplay.label)
                : agentDisplay.label
            }
            active={isAgentPickerOpen}
            danger={harnessBlocked}
            className="h-[28px] max-w-[220px] shrink-0 text-[12px]"
            ariaLabel={agentPickerLabel}
            dataTestId="session-creator-runner-agent-pill"
            onClick={onOpenAgentPicker}
          />

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {canPickModel && (
              <ModelSelectorPill
                selection={modelSelection}
                defaultLabel={modelLabel}
                active={isModelPickerOpen}
                className="max-w-[260px] shrink-0"
                onClick={onOpenModelPicker}
                onVariantApply={onVariantApply}
                ariaLabel={modelPickerLabel}
                dataTestId="session-creator-runner-model-pill"
                effortDataTestId="session-creator-runner-effort-pill"
              />
            )}

            <Button
              variant="tertiary"
              size="small"
              shape="round"
              icon={
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  data-icon="x"
                  size={14}
                  strokeWidth={1.85}
                  className="block"
                />
              }
              iconOnly
              title={removeLabel}
              aria-label={removeLabel}
              disabled={!canRemove}
              onClick={onRemove}
              className="shrink-0"
              data-testid="session-creator-runner-remove"
            />
          </div>
        </div>
      </li>
    );
  }
);

RunnerRow.displayName = "RunnerRow";

export default RunnerRow;
