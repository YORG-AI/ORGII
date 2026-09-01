import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CliAgentType } from "@src/api/types/keys";
import Dropdown from "@src/components/Dropdown";
import DropdownItem from "@src/components/Dropdown/DropdownItem";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import ModelIcon from "@src/components/ModelIcon";
import {
  type IconProvider,
  getIconProviderFromType,
} from "@src/components/ModelIcon/config";
import SelectGhostTrigger from "@src/components/Select/SelectGhostTrigger";
import type { AvailableCliAgent } from "@src/modules/MainApp/AgentOrgs/types";
import { openAgentConfigInWorkStation } from "@src/util/ui/openAgentConfigInWorkStation";

interface CliAgentHeaderSwitcherProps {
  activeAgentName: string;
  fallbackDisplayName: string;
  cliAgents: AvailableCliAgent[];
}

function matchesCliQuery(agent: AvailableCliAgent, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [agent.displayName, agent.name, agent.command]
    .filter(Boolean)
    .some((value) => value.toLowerCase().includes(normalizedQuery));
}

function sortCliAgents(agents: AvailableCliAgent[]): AvailableCliAgent[] {
  return [...agents].sort((agentA, agentB) => {
    if (agentA.installed !== agentB.installed) {
      return agentA.installed ? -1 : 1;
    }
    return agentA.displayName.localeCompare(agentB.displayName);
  });
}

function getCliAgentIconProvider(
  agent?: AvailableCliAgent
): IconProvider | undefined {
  if (!agent) return undefined;
  return getIconProviderFromType(agent.iconProvider);
}

export function CliAgentHeaderSwitcher({
  activeAgentName,
  fallbackDisplayName,
  cliAgents,
}: CliAgentHeaderSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const sortedAgents = useMemo(() => sortCliAgents(cliAgents), [cliAgents]);
  const filteredAgents = useMemo(
    () => sortedAgents.filter((agent) => matchesCliQuery(agent, searchQuery)),
    [searchQuery, sortedAgents]
  );
  const activeAgent = useMemo(
    () => sortedAgents.find((agent) => agent.name === activeAgentName),
    [activeAgentName, sortedAgents]
  );
  const activeDisplayName = activeAgent?.displayName ?? fallbackDisplayName;
  const activeIconType = activeAgent?.name ?? activeAgentName;
  const showSearch = sortedAgents.length > 8;

  const handleVisibleChange = useCallback((visible: boolean) => {
    setOpen(visible);
    if (!visible) setSearchQuery("");
  }, []);

  const handleSelectAgent = useCallback((agent: AvailableCliAgent) => {
    openAgentConfigInWorkStation({
      variant: "cli",
      entityId: agent.name,
      displayName: agent.displayName,
      cliAgentType: agent.name as CliAgentType,
    });
    setOpen(false);
    setSearchQuery("");
  }, []);

  const droplist = (
    <div
      className={`${DROPDOWN_CLASSES.panel} ${DROPDOWN_WIDTHS.fileTreeClass} max-w-[320px] overflow-hidden`}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {showSearch ? (
        <DropdownSearch
          type="search"
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t("common:common.searchPlaceholder")}
          ariaLabel={t("common:actions.search")}
        />
      ) : null}
      <div className={DROPDOWN_CLASSES.optionsContainerScrollbar}>
        {filteredAgents.map((agent) => (
          <DropdownItem
            key={agent.name}
            selected={agent.name === activeAgentName}
            selectedCheckPlacement="trailing"
            icon={
              <ModelIcon
                agentType={agent.name}
                provider={getCliAgentIconProvider(agent)}
                size={DROPDOWN_ITEM.iconSize}
              />
            }
            suffix={
              agent.installed ? null : (
                <span className="text-[11px] text-text-4">
                  {t("integrations:agentOrgs.cliAgentDetail.notInstalled")}
                </span>
              )
            }
            onClick={() => handleSelectAgent(agent)}
          >
            <span title={agent.displayName}>{agent.displayName}</span>
          </DropdownItem>
        ))}
        {filteredAgents.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {t("common:common.noResults")}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <Dropdown
      droplist={droplist}
      popupVisible={open}
      onVisibleChange={handleVisibleChange}
      trigger="click"
      position="bottom-start"
      getPopupContainer={() => document.body}
      avoidViewportOverflow
    >
      <SelectGhostTrigger
        open={open}
        disabled={sortedAgents.length === 0}
        className="w-auto max-w-[min(100%,22rem)] min-w-0"
        title={activeDisplayName}
        ariaLabel={activeDisplayName}
        value={
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <ModelIcon
              agentType={activeIconType}
              provider={getCliAgentIconProvider(activeAgent)}
              size={14}
              className="shrink-0"
            />
            <span className="truncate text-[12px] font-medium text-text-1">
              {activeDisplayName}
            </span>
          </span>
        }
      />
    </Dropdown>
  );
}
