/**
 * SubAgentsEditor — reusable sub-agent configuration panel.
 *
 * Used in:
 * 1. AgentWizard (custom agent creation/editing)
 * 2. OS Agent settings
 * 3. SDE Agent settings
 * 4. CustomAgentDetailView (existing custom agents)
 *
 * Sourcing model
 * --------------
 * The editor is self-sourcing: it reads `customAgentsAtom` and
 * `builtInAgentsAtom` directly. Callers only pass `currentAgentId` (for
 * cycle detection and self-exclusion) — never an `availableAgents` list.
 *
 * This eliminates the prior class of duplication bugs where a parent
 * component passed an already-merged `[...custom, ...builtIn]` list and
 * the editor merged its own builtin list on top, surfacing each builtin
 * agent twice.
 *
 * Visibility rule:
 *   - delegationConfig.delegatable !== false  (background workers like
 *     `builtin:memory-extractor` opt out. Runtime's `agent` tool
 *     schema honors this flag.)
 *   - id !== currentAgentId  (an agent cannot be its own sub-agent)
 *   - no cycle would be created via the existing `subAgents` graph
 *
 * Tier is intentionally NOT filtered. Primary-tier agents (OS / SDE /
 * Wingman) can still be configured as sub-agents — `builtin:os` ships
 * with SDE in its allowlist by default, and the runtime's
 * `agent::execute()` doesn't check tier. The previous filter would
 * have removed legitimate specialist-as-sub-agent configurations
 * from the picker.
 */
import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { Plus, X } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import Button from "@src/components/Button";
import { DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import NumberInput from "@src/components/NumberInput";
import Switch from "@src/components/Switch";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import {
  type AgentDefinition,
  SUB_AGENT_ISOLATION,
  type SubAgentRef,
} from "@src/modules/MainApp/AgentOrgs/types";
import {
  dedupeAgentsById,
  isSubAgentCandidate,
} from "@src/modules/MainApp/AgentOrgs/utils/subAgentVisibility";
import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

interface AddOption {
  value: string;
  label: string;
}

interface AddSubAgentButtonProps {
  options: AddOption[];
  onAdd: (agentId: string) => void;
  t: TFunction;
}

const AddSubAgentButton: React.FC<AddSubAgentButtonProps> = ({
  options,
  onAdd,
  t,
}) => {
  const [search, setSearch] = useState("");
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
  } = useDropdownEngine<HTMLButtonElement>({
    gap: 4,
    placement: "bottom",
    align: "left",
  });

  const filtered = useMemo(() => {
    if (!search) return options;
    const query = search.toLowerCase();
    return options.filter((opt) => opt.label.toLowerCase().includes(query));
  }, [options, search]);

  const handleSelect = useCallback(
    (value: string) => {
      onAdd(value);
      close();
      setSearch("");
    },
    [onAdd, close]
  );

  return (
    <div>
      <Button
        ref={triggerRef}
        size="default"
        icon={<Plus size={DROPDOWN_ITEM.iconSize} />}
        data-testid="agent-orgs-subagents-add-button"
        onClick={toggle}
      >
        {t("agentOrgs.agentWizard.addSubAgent")}
      </Button>

      {isOpen &&
        isPositioned &&
        createPortal(
          <DropdownPanel
            ref={panelRef}
            animated={false}
            maxHeight="none"
            style={{
              position: "fixed",
              top: panelPosition.top,
              left: panelPosition.left,
              width: Math.max(panelPosition.width, 220),
            }}
          >
            <div className={DROPDOWN_CLASSES.searchContainer}>
              <input
                autoFocus
                value={search}
                onChange={(evt) => setSearch(evt.target.value)}
                className={DROPDOWN_CLASSES.searchInput}
                placeholder={t("common:actions.search")}
              />
            </div>
            <div className={`${DROPDOWN_CLASSES.optionsContainer} max-h-52`}>
              {filtered.length === 0 ? (
                <div className={DROPDOWN_CLASSES.listMessage}>
                  {t("common:placeholders.noMatchingResults")}
                </div>
              ) : (
                filtered.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    data-testid={`agent-orgs-subagents-add-option-${opt.value}`}
                    className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
                    onClick={() => handleSelect(opt.value)}
                  >
                    <span className="text-[13px] text-text-1">{opt.label}</span>
                  </button>
                ))
              )}
            </div>
          </DropdownPanel>,
          document.body
        )}
    </div>
  );
};

const MAX_SUB_AGENTS = 10;
const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10;
const MIN_TOOL_USE_CONCURRENCY = 1;
const MAX_TOOL_USE_CONCURRENCY = 30;

export interface SubAgentsEditorProps {
  subAgents: SubAgentRef[];
  onChange: (refs: SubAgentRef[]) => void;
  maxToolUseConcurrency?: number | null;
  onMaxToolUseConcurrencyChange?: (value: number) => void;
  /** The ID of the agent being edited (used for self-exclusion + cycle detection). */
  currentAgentId?: string;
  t: TFunction;
}

/**
 * Detects whether adding `candidateId` to `parentId`'s sub-agents would create
 * a circular delegation chain.
 *
 * Walks the sub-agent graph starting from `candidateId` and returns true if
 * `parentId` is reachable (i.e., adding it would create a cycle).
 *
 * Note: in the runtime today, sub-agents cannot spawn further sub-agents
 * (single-layer delegation), so cycles can never actually trigger at
 * runtime. The check is preserved to keep the configured graph clean
 * regardless of runtime depth caps.
 */
function wouldCreateCycle(
  parentId: string,
  candidateId: string,
  allAgents: AgentDefinition[]
): boolean {
  const agentMap = new Map(allAgents.map((agent) => [agent.id, agent]));
  const visited = new Set<string>();
  const queue = [candidateId];

  while (queue.length > 0) {
    const currentId = queue.pop()!;
    if (currentId === parentId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const agent = agentMap.get(currentId);
    if (agent?.subAgents) {
      for (const ref of agent.subAgents) {
        queue.push(ref.agentId);
      }
    }
  }
  return false;
}

const SubAgentsEditor: React.FC<SubAgentsEditorProps> = ({
  subAgents,
  onChange,
  maxToolUseConcurrency = DEFAULT_MAX_TOOL_USE_CONCURRENCY,
  onMaxToolUseConcurrencyChange,
  currentAgentId,
  t,
}) => {
  const customAgents = useAtomValue(customAgentsAtom);
  const builtInAgents = useAtomValue(builtInAgentsAtom);

  /**
   * Single dedupe-then-filter pipeline. Atoms are disjoint by
   * construction, but the explicit dedupe step keeps the picker
   * resilient to future store refactors.
   */
  const candidateAgents = useMemo(() => {
    const merged = dedupeAgentsById([...customAgents, ...builtInAgents]);
    return merged.filter(isSubAgentCandidate);
  }, [customAgents, builtInAgents]);

  /** Used only by `wouldCreateCycle` (needs the full graph, not just candidates). */
  const allAgents = useMemo(
    () => dedupeAgentsById([...customAgents, ...builtInAgents]),
    [customAgents, builtInAgents]
  );

  const addedIds = useMemo(
    () => new Set(subAgents.map((ref) => ref.agentId)),
    [subAgents]
  );

  const addOptions = useMemo(
    () =>
      candidateAgents
        .filter((agent) => {
          if (addedIds.has(agent.id)) return false;
          if (currentAgentId && agent.id === currentAgentId) return false;
          if (
            currentAgentId &&
            wouldCreateCycle(currentAgentId, agent.id, allAgents)
          )
            return false;
          return true;
        })
        .map((agent) => ({
          value: agent.id,
          label: agent.name,
        })),
    [candidateAgents, addedIds, currentAgentId, allAgents]
  );

  const handleAdd = useCallback(
    (agentId: string | number | (string | number)[]) => {
      const id = String(agentId);
      if (addedIds.has(id) || subAgents.length >= MAX_SUB_AGENTS) return;
      onChange([...subAgents, { agentId: id }]);
    },
    [subAgents, addedIds, onChange]
  );

  const handleRemove = useCallback(
    (agentId: string) => {
      onChange(subAgents.filter((ref) => ref.agentId !== agentId));
    },
    [subAgents, onChange]
  );

  const handleWorktreeIsolationChange = useCallback(
    (agentId: string, enabled: boolean) => {
      onChange(
        subAgents.map((ref) =>
          ref.agentId === agentId
            ? {
                ...ref,
                isolation: enabled ? SUB_AGENT_ISOLATION.WORKTREE : undefined,
              }
            : ref
        )
      );
    },
    [subAgents, onChange]
  );

  const handleMaxToolUseConcurrencyChange = useCallback(
    (value: number | undefined) => {
      onMaxToolUseConcurrencyChange?.(
        value ?? DEFAULT_MAX_TOOL_USE_CONCURRENCY
      );
    },
    [onMaxToolUseConcurrencyChange]
  );

  const resolveAgentName = useCallback(
    (agentId: string) =>
      allAgents.find((agent) => agent.id === agentId)?.name ?? agentId,
    [allAgents]
  );

  return (
    <div className={SECTION_GAP_CLASSES}>
      <SectionContainer>
        <SectionRow
          label={t("agentOrgs.agentWizard.maxToolUseConcurrencyLabel")}
          description={t("agentOrgs.agentWizard.maxToolUseConcurrencyDesc")}
        >
          <NumberInput
            value={maxToolUseConcurrency ?? DEFAULT_MAX_TOOL_USE_CONCURRENCY}
            min={MIN_TOOL_USE_CONCURRENCY}
            max={MAX_TOOL_USE_CONCURRENCY}
            step={1}
            onChange={handleMaxToolUseConcurrencyChange}
            style={SECTION_CONTROL_STYLE}
            dataTestId="agent-orgs-subagents-max-tool-use-concurrency-input"
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        {subAgents.length === 0 && (
          <div className="flex items-center justify-center py-6 text-sm text-text-4">
            {t("agentOrgs.agentWizard.noSubAgents")}
          </div>
        )}

        {subAgents.map((ref) => (
          <div
            key={ref.agentId}
            data-testid="subagent-row"
            data-subagent-id={ref.agentId}
          >
            <SectionRow label={resolveAgentName(ref.agentId)}>
              <Button
                icon={<X size={DROPDOWN_ITEM.iconSize} />}
                iconOnly
                appearance="ghost"
                variant="danger"
                size="small"
                data-testid={`agent-orgs-subagents-remove-${ref.agentId}`}
                onClick={() => handleRemove(ref.agentId)}
              />
            </SectionRow>
            <div data-testid="subagent-worktree-isolation-row">
              <SectionRow
                label={t(
                  "agentOrgs.agentWizard.subAgentWorktreeIsolationLabel"
                )}
                description={t(
                  "agentOrgs.agentWizard.subAgentWorktreeIsolationDesc"
                )}
                indent
              >
                <Switch
                  checked={ref.isolation === SUB_AGENT_ISOLATION.WORKTREE}
                  dataTestId={`agent-orgs-subagents-isolation-${ref.agentId}`}
                  onChange={(checked) =>
                    handleWorktreeIsolationChange(ref.agentId, checked)
                  }
                />
              </SectionRow>
            </div>
          </div>
        ))}
      </SectionContainer>

      {subAgents.length < MAX_SUB_AGENTS && addOptions.length > 0 && (
        <AddSubAgentButton options={addOptions} onAdd={handleAdd} t={t} />
      )}
    </div>
  );
};

export default SubAgentsEditor;
