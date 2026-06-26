/**
 * useDispatchCategoryOptions
 *
 * Centralizes data fetching, compatibility derivation, and SpotlightItem
 * adaptation for the agent picker. Consumed by both the Spotlight
 * (`DispatchCategoryPalette`) and the anchored dropdown
 * (`DispatchCategoryDropdown`) so they always show the same options.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import {
  // CLI_AGENT,
  type CliAgentType,
  CliAgentTypeSchema,
} from "@src/api/tauri/rpc/schemas/validation";
import type { DispatchCategory } from "@src/api/tauri/session";
import { isApiKeyProvider } from "@src/assets/providers";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { type KeyVaultAccount, useKeyVault } from "@src/hooks/keyVault";
import {
  getCliCompatibleAccounts,
  getRustCompatibleAccounts,
  useAgentCompatibility,
} from "@src/hooks/models/useAgentCompatibility";
import { useEnsureAgentDefs } from "@src/modules/MainApp/AgentOrgs/hooks/useEnsureAgentDefs";
import {
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type { OrgMember } from "@src/modules/MainApp/AgentOrgs/types";
import { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import { agentRegistryAtom } from "@src/store/session/agentRegistryAtom";
import { SESSION_TARGET_KIND } from "@src/store/session/creatorStateAtom";
import { invokeTauri } from "@src/util/platform/tauri/init";

import type { SpotlightItem } from "../../types";
import type { AgentSelection } from "./types";

export interface AgentOption {
  id: string;
  name: string;
  desc: string;
  iconId?: string;
  category: DispatchCategory;
  targetKind: AgentSelection["targetKind"];
  agentDefinitionId?: string;
  agentOrgId?: string;
  cliAgentType?: CliAgentType;
  isBuiltIn: boolean;
  isCli: boolean;
  isOrg: boolean;
  rightContent?: React.ReactNode;
}

export interface DispatchCategoryOptionGroup {
  headerId: string;
  headerLabel: string;
  options: AgentOption[];
}

export interface UseDispatchCategoryOptionsArgs {
  isOpen: boolean;
  hideOrgs: boolean;
  currentCategory: DispatchCategory;
  currentAgentDefinitionId?: string;
  currentAgentOrgId?: string;
  currentCliAgentType?: CliAgentType;
  onSelect: (selection: AgentSelection) => void;
  onClose: () => void;
}

export interface UseDispatchCategoryOptionsResult {
  allOptions: AgentOption[];
  groups: DispatchCategoryOptionGroup[];
  accounts: KeyVaultAccount[];
  rustCompatibleAccounts: KeyVaultAccount[];
  rustIncompatibleAccounts: KeyVaultAccount[];
  optionToItem: (option: AgentOption) => SpotlightItem;
}

function buildCredentialBadge(
  compatibleAccounts: KeyVaultAccount[]
): React.ReactNode {
  const totalCount = compatibleAccounts.length;
  const dotColor = totalCount > 0 ? "bg-success-6" : "bg-danger-6";
  const textColor = totalCount > 0 ? "text-text-2" : "text-text-3";

  const uniquePlanTypes = [
    ...new Set(
      compatibleAccounts
        .filter((acc) => !isApiKeyProvider(acc.modelType))
        .map((acc) => acc.modelType)
    ),
  ];
  const uniqueKeyTypes = [
    ...new Set(
      compatibleAccounts
        .filter((acc) => isApiKeyProvider(acc.modelType))
        .map((acc) => acc.modelType)
    ),
  ];

  return (
    <div className="flex items-center gap-1.5">
      {uniquePlanTypes.map((planType) => (
        <ModelIcon key={planType} agentType={planType} size={14} />
      ))}
      {uniqueKeyTypes.map((keyType) => (
        <ModelIcon key={keyType} agentType={keyType} size="small" />
      ))}
      {(uniquePlanTypes.length > 0 || uniqueKeyTypes.length > 0) && (
        <span className="text-[11px] text-text-4">&middot;</span>
      )}
      <span
        className={`whitespace-nowrap text-[11px] tabular-nums ${textColor}`}
      >
        {totalCount}
      </span>
      <span
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`}
      />
    </div>
  );
}

export function useDispatchCategoryOptions(
  args: UseDispatchCategoryOptionsArgs
): UseDispatchCategoryOptionsResult {
  const {
    isOpen,
    hideOrgs,
    currentCategory,
    currentAgentDefinitionId,
    currentAgentOrgId,
    currentCliAgentType,
    onSelect,
    onClose,
  } = args;

  const { t } = useTranslation("sessions");
  const [allOrgs, setAllOrgs] = useState<OrgMember[]>([]);
  const { agents: cliAgentList } = useCliAgents({ enabled: isOpen });
  const { accounts } = useKeyVault({ autoLoad: true });
  const { registry } = useAgentCompatibility();
  const setAgentRegistry = useSetAtom(agentRegistryAtom);

  useEnsureAgentDefs();
  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const customAgents = useAtomValue(customAgentsAtom);

  const allAgents = useMemo(
    () => [
      ...builtInAgents.filter((agent) => agent.tier === "primary"),
      ...customAgents,
    ],
    [builtInAgents, customAgents]
  );

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    if (!hideOrgs) {
      invokeTauri<OrgMember[]>("agent_orgs_list")
        .then((result) => {
          if (cancelled) return;
          setAllOrgs(result);
        })
        .catch(() => {});
    }

    rpc.validation
      .getAvailableApiProviders()
      .then((apiProviders) => {
        if (cancelled) return;
        setAgentRegistry((prev) => ({ ...prev, apiProviders }));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isOpen, hideOrgs, setAgentRegistry]);

  const installedCliAgents = useMemo(
    () => cliAgentList.filter((agent) => agent.installed),
    [cliAgentList]
  );

  useEffect(() => {
    if (cliAgentList.length > 0) {
      setAgentRegistry((prev) => ({ ...prev, agents: cliAgentList }));
    }
  }, [cliAgentList, setAgentRegistry]);

  const rustCompatibleAccounts = useMemo(
    () => getRustCompatibleAccounts(registry, accounts),
    [registry, accounts]
  );

  const rustIncompatibleAccounts = useMemo(() => {
    const compatibleSet = new Set(rustCompatibleAccounts.map((acc) => acc.id));
    return accounts.filter(
      (acc) =>
        acc.status === "ready" &&
        (acc.hasKey ?? true) &&
        !compatibleSet.has(acc.id)
    );
  }, [accounts, rustCompatibleAccounts]);

  const builtInRustOptions = useMemo((): AgentOption[] => {
    const rustBadge = buildCredentialBadge(rustCompatibleAccounts);
    return allAgents
      .filter((agent) => agent.builtIn)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        desc: "",
        iconId: agent.iconId ?? undefined,
        category: "rust_agent" as DispatchCategory,
        targetKind: SESSION_TARGET_KIND.AGENT,
        agentDefinitionId: agent.id,
        isBuiltIn: true,
        isCli: false,
        isOrg: false,
        rightContent: rustBadge,
      }));
  }, [allAgents, rustCompatibleAccounts]);

  const cliOptions = useMemo((): AgentOption[] => {
    return installedCliAgents.flatMap((agent) => {
      const parsed = CliAgentTypeSchema.safeParse(agent.name);
      if (!parsed.success) return [];
      const agentType = parsed.data;
      // CLI agents only show plan (subscription) accounts in the badge.
      const compatibleAccounts = getCliCompatibleAccounts(
        registry,
        agentType,
        accounts
      ).filter((acc) => !isApiKeyProvider(acc.modelType));
      return [
        {
          id: `cli:${agent.name}`,
          name: agent.displayName,
          desc: "",
          category: "cli_agent" as DispatchCategory,
          targetKind: SESSION_TARGET_KIND.CLI_AGENT,
          cliAgentType: agentType,
          isBuiltIn: true,
          isCli: true,
          isOrg: false,
          rightContent: buildCredentialBadge(compatibleAccounts),
        },
      ];
    });
  }, [installedCliAgents, accounts, registry]);

  const customAgentOptions = useMemo((): AgentOption[] => {
    const rustBadge = buildCredentialBadge(rustCompatibleAccounts);
    return allAgents
      .filter((agent) => !agent.builtIn)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        desc: agent.description || "",
        iconId: agent.iconId ?? undefined,
        category: "rust_agent" as DispatchCategory,
        targetKind: SESSION_TARGET_KIND.AGENT,
        agentDefinitionId: agent.id,
        isBuiltIn: false,
        isCli: false,
        isOrg: false,
        rightContent: rustBadge,
      }));
  }, [allAgents, rustCompatibleAccounts]);

  const orgOptions = useMemo((): AgentOption[] => {
    const rustBadge = buildCredentialBadge(rustCompatibleAccounts);
    return allOrgs.map((org) => ({
      id: `org:${org.id}`,
      name: org.name,
      desc: "",
      iconId: "network",
      category: "rust_agent" as DispatchCategory,
      targetKind: SESSION_TARGET_KIND.AGENT_ORG,
      agentOrgId: org.id,
      isBuiltIn: false,
      isCli: false,
      isOrg: true,
      rightContent: rustBadge,
    }));
  }, [allOrgs, rustCompatibleAccounts]);

  const externalIdeOptions = useMemo((): AgentOption[] => {
    return [
      // {
      //   id: "external-ide:cursor",
      //   name: t("creator.cursorIde.label"),
      //   desc: "",
      //   iconId: "cursor",
      //   category: "cursor_ide" as DispatchCategory,
      //   targetKind: SESSION_TARGET_KIND.CLI_AGENT,
      //   cliAgentType: CLI_AGENT.CURSOR,
      //   isBuiltIn: true,
      //   isCli: false,
      //   isOrg: false,
      // },
    ];
  }, []);

  const allOptions = useMemo(
    () => [
      ...builtInRustOptions,
      ...cliOptions,
      ...externalIdeOptions,
      ...customAgentOptions,
      ...(hideOrgs ? [] : orgOptions),
    ],
    [
      builtInRustOptions,
      cliOptions,
      externalIdeOptions,
      customAgentOptions,
      orgOptions,
      hideOrgs,
    ]
  );

  const groups = useMemo<DispatchCategoryOptionGroup[]>(() => {
    const result: DispatchCategoryOptionGroup[] = [];
    const push = (
      headerId: string,
      headerLabel: string,
      options: AgentOption[]
    ) => {
      if (options.length === 0) return;
      result.push({ headerId, headerLabel, options });
    };
    push("__header_builtin__", t("creator.builtInAgents"), builtInRustOptions);
    push("__header_cli__", t("creator.cliAgents"), cliOptions);
    push(
      "__header_external_ide__",
      t("creator.externalIdes"),
      externalIdeOptions
    );
    push("__header_custom__", t("creator.customAgents"), customAgentOptions);
    if (!hideOrgs) {
      push("__header_orgs__", t("creator.agentOrgs"), orgOptions);
    }
    return result;
  }, [
    builtInRustOptions,
    cliOptions,
    externalIdeOptions,
    customAgentOptions,
    orgOptions,
    hideOrgs,
    t,
  ]);

  const optionToItem = useCallback(
    (option: AgentOption): SpotlightItem => {
      const isCurrent = option.isOrg
        ? currentCategory === "rust_agent" &&
          option.agentOrgId === currentAgentOrgId
        : option.isCli
          ? currentCategory === "cli_agent" &&
            option.cliAgentType === currentCliAgentType
          : option.category === "cursor_ide"
            ? currentCategory === "cursor_ide"
            : currentCategory === "rust_agent" &&
              option.agentDefinitionId === currentAgentDefinitionId;

      const icon = option.cliAgentType
        ? (iconProps: Record<string, unknown>) => (
            <ModelIcon
              agentType={option.cliAgentType!}
              size={(iconProps as { size?: number }).size || 16}
            />
          )
        : resolveAgentIcon(option.iconId);

      return {
        id: option.id,
        label: option.name,
        desc: option.desc,
        icon,
        type: "action" as const,
        data: {
          isSelector: true,
          isCurrentSelection: isCurrent,
          rightContent: option.rightContent,
          testId: option.isOrg
            ? `session-creator-agent-option-org-${option.agentOrgId}`
            : option.agentDefinitionId
              ? `session-creator-agent-option-def-${option.agentDefinitionId}`
              : option.cliAgentType
                ? `session-creator-agent-option-cli-${option.cliAgentType}`
                : undefined,
        },
        action: () => {
          onSelect({
            category: option.category,
            targetKind: option.targetKind,
            agentDefinitionId: option.agentDefinitionId,
            agentOrgId: option.agentOrgId,
            cliAgentType: option.cliAgentType,
            agentName: option.name,
            agentIconId: option.iconId,
          });
          onClose();
        },
      };
    },
    [
      currentCategory,
      currentAgentDefinitionId,
      currentAgentOrgId,
      currentCliAgentType,
      onSelect,
      onClose,
    ]
  );

  return {
    allOptions,
    groups,
    accounts,
    rustCompatibleAccounts,
    rustIncompatibleAccounts,
    optionToItem,
  };
}
