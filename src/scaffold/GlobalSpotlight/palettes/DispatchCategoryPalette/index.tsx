/**
 * DispatchCategoryPalette Component
 *
 * Unified agent palette that shows all dispatchable agents in one list:
 * - Rust-native agents (OS Agent, SDE Agent)
 * - Installed CLI agents (Cursor, Claude Code, Codex, etc.)
 * - User-defined custom agents
 *
 * Each agent row shows compatible credential badges on the right.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import { CliAgentTypeSchema } from "@src/api/tauri/rpc/schemas/validation";
import type { DispatchCategory } from "@src/api/tauri/session";
import { isApiKeyProvider } from "@src/assets/providers";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { getCliTransportLabel } from "@src/config/cliAgents";
import { type KeyVaultAccount, useKeyVault } from "@src/hooks/keyVault";
import {
  getCliCompatibleAccounts,
  getRustCompatibleAccounts,
  useAgentCompatibility,
} from "@src/hooks/models/useAgentCompatibility";
import { useFilteredItems } from "@src/hooks/search";
import { useEnsureAgentDefs } from "@src/modules/MainApp/AgentOrgs/hooks/useEnsureAgentDefs";
import {
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type { OrgMember } from "@src/modules/MainApp/AgentOrgs/types";
import { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import {
  CLI_LAUNCH_MODE,
  type CliLaunchMode,
  cliAgentVisibilityOverridesAtom,
  isCliAgentEnabled,
  recentAgentSelectionsAtom,
  recordRecentAgentSelectionAtom,
} from "@src/store/session";
import { agentRegistryAtom } from "@src/store/session/agentRegistryAtom";
import { SESSION_TARGET_KIND } from "@src/store/session/creatorStateAtom";
import { invokeTauri } from "@src/util/platform/tauri/init";

import { ManageAgentsFooterAction } from "../../components";
import { useAccountFooterForHovered } from "../../hooks";
import { PaletteBody, ShellFooterAction, SpotlightShell } from "../../shell";
import type { PathSegment, SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";
import { CliAgentListFilterSwitch } from "./CliAgentListFilterSwitch";
import { createHumanSessionOption } from "./humanSessionOption";
import type { AgentOption, DispatchCategoryPaletteProps } from "./types";

export type { AgentSelection, DispatchCategoryPaletteProps } from "./types";

// ============ HELPERS ============

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

// ============ COMPONENT ============

export const DispatchCategoryPalette: React.FC<
  DispatchCategoryPaletteProps
> = ({
  isOpen,
  onClose,
  onGoBackToParent,
  onSelect,
  currentCategory = "cli_agent",
  currentAgentDefinitionId,
  currentAgentOrgId,
  currentCliAgentType,
  hideOrgs = false,
  hideCliAgents = false,
  cliOnly = false,
  includeHumanSession = false,
  titleLabel,
  titleIcon,
  placeholderLabel,
}) => {
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");
  const [searchQuery, setSearchQuery] = useState("");
  const [cliAgentListFilterMode, setCliAgentListFilterMode] =
    useState<CliLaunchMode>(CLI_LAUNCH_MODE.GUI);
  const [allOrgs, setAllOrgs] = useState<OrgMember[]>([]);
  const { agents: cliAgentList } = useCliAgents({ enabled: isOpen });
  const cliVisibilityOverrides = useAtomValue(cliAgentVisibilityOverridesAtom);
  const { accounts } = useKeyVault({ autoLoad: true });
  const { registry } = useAgentCompatibility();
  const setAgentRegistry = useSetAtom(agentRegistryAtom);
  const recentAgentSelections = useAtomValue(recentAgentSelectionsAtom);
  const recordRecentAgentSelection = useSetAtom(recordRecentAgentSelectionAtom);

  const shouldShowCliOnly =
    cliOnly || cliAgentListFilterMode === CLI_LAUNCH_MODE.TUI;
  const shouldFilterCliToGuiSupport =
    cliAgentListFilterMode === CLI_LAUNCH_MODE.GUI;

  // Ensure agent definitions are loaded into global atoms (no-op if already loaded)
  useEnsureAgentDefs();
  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const customAgents = useAtomValue(customAgentsAtom);

  // Merge built-in primary agents and custom agents into a single dispatchable list
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
    () =>
      cliAgentList.filter(
        (agent) =>
          agent.installed &&
          isCliAgentEnabled(agent.name, agent.installed, cliVisibilityOverrides)
      ),
    [cliAgentList, cliVisibilityOverrides]
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

  // ============ AGENT OPTIONS (grouped) ============

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

  const humanOptions = useMemo(
    (): AgentOption[] =>
      includeHumanSession
        ? [createHumanSessionOption(t("creator.humanSession.name"))]
        : [],
    [includeHumanSession, t]
  );

  const cliOptions = useMemo((): AgentOption[] => {
    return installedCliAgents.flatMap((agent) => {
      if (shouldFilterCliToGuiSupport && agent.supportsGui !== true) return [];
      // `agent.name` is a wire-format string; reject any value that isn't
      // in the canonical CLI agent set rather than smuggling it through
      // a `as CliAgentType` cast (which used to crash downstream consumers
      // when a stale registry entry slipped in).
      const parsed = CliAgentTypeSchema.safeParse(agent.name);
      if (!parsed.success) return [];
      const agentType = parsed.data;
      // CLI agents only show plan (subscription) accounts in the badge —
      // API key accounts are not relevant for the session-launch decision.
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
  }, [installedCliAgents, shouldFilterCliToGuiSupport, accounts, registry]);

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

  // External IDE: drives a separate Cursor.app instance via CDP. No
  // key vault entry, no Rust agent, no CLI process — Cursor manages
  // its own auth + model. We surface it as a distinct group so users
  // don't conflate it with "Cursor CLI" (which IS a CLI agent and
  // does need a key).
  //
  // `cliAgentType: CLI_AGENT.CURSOR` here is purely for icon rendering
  // parity with the Cursor CLI row — the dispatch routing checks
  // `category === "cursor_ide"` (not `cliAgentType`), so this is
  // safe and avoids the `text-text-2`-dimmed brand-icon adapter.
  const externalIdeOptions = useMemo((): AgentOption[] => {
    return [
      // {
      //   id: "external-ide:cursor",
      //   name: t("creator.cursorIde.label"),
      //   desc: "",
      //   iconId: "cursor",
      //   category: "cursor_ide" as DispatchCategory,
      //   // Reuse CLI_AGENT target kind: like CLI agents, Cursor IDE is
      //   // an external thing we drive (vs. a Rust agent or org that
      //   // runs inside ORGII). Avoids polluting SessionTargetKind.
      //   targetKind: SESSION_TARGET_KIND.CLI_AGENT,
      //   cliAgentType: CLI_AGENT.CURSOR,
      //   isBuiltIn: true,
      //   isCli: false,
      //   isOrg: false,
      // },
    ];
  }, []);

  const allOptions = useMemo(
    () =>
      shouldShowCliOnly
        ? [...cliOptions]
        : [
            ...humanOptions,
            ...builtInRustOptions,
            ...(hideCliAgents ? [] : cliOptions),
            ...externalIdeOptions,
            ...customAgentOptions,
            ...(hideOrgs ? [] : orgOptions),
          ],
    [
      shouldShowCliOnly,
      humanOptions,
      builtInRustOptions,
      cliOptions,
      externalIdeOptions,
      customAgentOptions,
      orgOptions,
      hideOrgs,
      hideCliAgents,
    ]
  );

  const recentOptions = useMemo((): AgentOption[] => {
    return recentAgentSelections.flatMap((selection) => {
      const option = allOptions.find((candidate) => {
        if (selection.targetKind === SESSION_TARGET_KIND.AGENT_ORG) {
          return candidate.agentOrgId === selection.agentOrgId;
        }
        if (selection.category === "cli_agent") {
          return candidate.cliAgentType === selection.cliAgentType;
        }
        if (selection.category === "cursor_ide") {
          return candidate.category === "cursor_ide";
        }
        if (selection.category === "human_session") {
          return candidate.category === "human_session";
        }
        return candidate.agentDefinitionId === selection.agentDefinitionId;
      });
      return option ? [option] : [];
    });
  }, [allOptions, recentAgentSelections]);

  const { filteredItems: filteredOptions } = useFilteredItems({
    items: allOptions,
    searchQuery,
    getSearchText: (option) => `${option.name} ${option.desc}`,
  });

  // ============ BUILD ITEMS WITH GROUP HEADERS ============

  const isSearching = searchQuery.trim().length > 0;

  const optionToItem = useCallback(
    (option: AgentOption, itemIdPrefix?: string): SpotlightItem => {
      const isCurrent = option.isOrg
        ? currentCategory === "rust_agent" &&
          option.agentOrgId === currentAgentOrgId
        : option.isCli
          ? currentCategory === "cli_agent" &&
            option.cliAgentType === currentCliAgentType
          : option.category === "cursor_ide" ||
              option.category === "human_session"
            ? currentCategory === option.category
            : currentCategory === "rust_agent" &&
              option.agentDefinitionId === currentAgentDefinitionId;

      // Render through ModelIcon (raw brand SVG) whenever we have a
      // `cliAgentType` — both CLI agent rows and the Cursor IDE row
      // (which carries `cursor_cli` purely for icon parity). Other
      // rows fall back to the icon adapter via `resolveAgentIcon`.
      const icon = option.cliAgentType
        ? (iconProps: Record<string, unknown>) => (
            <ModelIcon
              agentType={option.cliAgentType!}
              size={(iconProps as { size?: number }).size || 16}
            />
          )
        : resolveAgentIcon(option.iconId);

      return {
        id: itemIdPrefix ? `${itemIdPrefix}:${option.id}` : option.id,
        label: option.name,
        desc: option.desc,
        icon,
        type: "action" as const,
        data: {
          isSelector: true,
          optionId: option.id,
          isCurrentSelection: isCurrent,
          // Execution transport for managed GUI runs (ACP vs shell-out).
          // CLI agent rows only — Rust agents, orgs, and the Cursor IDE row
          // (which carries `cliAgentType` purely for icon parity) never get it.
          inlineTag:
            option.isCli && option.cliAgentType
              ? getCliTransportLabel(option.cliAgentType)
              : undefined,
          rightContent: option.rightContent,
          testId: option.isOrg
            ? `session-creator-agent-option-org-${option.agentOrgId}`
            : option.category === "human_session"
              ? "session-creator-option-human-session"
              : option.agentDefinitionId
                ? `session-creator-agent-option-def-${option.agentDefinitionId}`
                : option.cliAgentType
                  ? `session-creator-agent-option-cli-${option.cliAgentType}`
                  : undefined,
        },
        action: () => {
          recordRecentAgentSelection({
            category: option.category,
            targetKind: option.targetKind,
            agentDefinitionId: option.agentDefinitionId,
            agentOrgId: option.agentOrgId,
            cliAgentType: option.cliAgentType,
          });
          onSelect({
            category: option.category,
            targetKind: option.targetKind,
            agentDefinitionId: option.agentDefinitionId,
            agentOrgId: option.agentOrgId,
            cliAgentType: option.cliAgentType,
            cliLaunchMode: option.isCli ? cliAgentListFilterMode : undefined,
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
      cliAgentListFilterMode,
      recordRecentAgentSelection,
      onSelect,
      onClose,
    ]
  );

  const items = useMemo((): SpotlightItem[] => {
    if (isSearching) {
      return filteredOptions.map((option) => optionToItem(option));
    }

    const result: SpotlightItem[] = [];

    const pushGroup = (
      headerId: string,
      headerLabel: string,
      options: AgentOption[]
    ) => {
      if (options.length === 0) return;
      result.push({
        id: headerId,
        label: headerLabel,
        desc: "",
        icon: "",
        type: "option" as const,
        data: { isHeader: true },
        action: () => {},
      });
      for (const option of options) {
        result.push(optionToItem(option, headerId));
      }
    };

    pushGroup(
      "__header_recent__",
      tCommon("selectors.labels.recent"),
      recentOptions
    );
    if (!shouldShowCliOnly) {
      pushGroup("__header_builtin__", t("creator.builtIns"), [
        ...humanOptions,
        ...builtInRustOptions,
      ]);
    }
    if (!hideCliAgents) {
      pushGroup("__header_cli__", t("creator.cliAgents"), cliOptions);
    }
    if (!shouldShowCliOnly) {
      pushGroup(
        "__header_external_ide__",
        t("creator.externalIdes"),
        externalIdeOptions
      );
      pushGroup(
        "__header_custom__",
        t("creator.customAgents"),
        customAgentOptions
      );
      if (!hideOrgs) {
        pushGroup("__header_orgs__", t("creator.agentOrgs"), orgOptions);
      }
    }

    return result;
  }, [
    isSearching,
    shouldShowCliOnly,
    filteredOptions,
    recentOptions,
    humanOptions,
    builtInRustOptions,
    cliOptions,
    hideCliAgents,
    externalIdeOptions,
    customAgentOptions,
    orgOptions,
    hideOrgs,
    optionToItem,
    t,
    tCommon,
  ]);

  // ============ KERNEL ============

  const isItemSelectable = useCallback((item: SpotlightItem) => {
    const data = item.data as Record<string, unknown> | undefined;
    return !data?.isHeader;
  }, []);

  const handleExternalKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLInputElement>,
      internalHandleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
    ) => {
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        searchQuery === "" &&
        onGoBackToParent
      ) {
        event.preventDefault();
        onGoBackToParent();
        return;
      }
      internalHandleKeyDown(event);
    },
    [searchQuery, onGoBackToParent]
  );

  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items,
    isItemSelectable,
    externalSearchQuery: searchQuery,
    externalSetSearchQuery: setSearchQuery,
    onReset: () => setSearchQuery(""),
    externalHandleKeyDown: onGoBackToParent ? handleExternalKeyDown : undefined,
  });

  const containerHeight = Math.min(88 + items.length * 40, 400);

  // ============ FOOTER: show compatible accounts for hovered agent ============
  const hoveredItem = items[kernel.selectedIndex];
  const afterListSlot = useAccountFooterForHovered({
    hoveredItem,
    resolve: useCallback(
      (item) => {
        const itemData = item.data as Record<string, unknown> | undefined;
        const optionId = (itemData?.optionId as string | undefined) ?? item.id;
        const option = allOptions.find((opt) => opt.id === optionId);
        if (!option) return null;
        // Cursor IDE manages its own auth — no ORGII-side accounts
        // are relevant. Returning null keeps the footer empty.
        if (
          option.category === "cursor_ide" ||
          option.category === "human_session"
        )
          return null;
        if (option.isCli && option.cliAgentType) {
          return {
            mode: "cli",
            agentType: option.cliAgentType,
            accounts,
          };
        }
        return {
          mode: "api",
          accounts: rustCompatibleAccounts,
          showIncompatible: true,
          incompatibleAccounts: rustIncompatibleAccounts,
        };
      },
      [allOptions, accounts, rustCompatibleAccounts, rustIncompatibleAccounts]
    ),
  });

  const footerAction = <ManageAgentsFooterAction onClose={onClose} />;
  const inputLeadingSlot = (
    <CliAgentListFilterSwitch
      mode={cliAgentListFilterMode}
      onModeChange={setCliAgentListFilterMode}
    />
  );

  // When the caller pre-selects a target (e.g. an org member row), surface
  const path = useMemo<PathSegment[]>(() => {
    const label =
      titleLabel ?? tCommon("filters.searchAgentOrOrg", "Select Agent");
    return [
      {
        type: "action",
        id: "dispatch-category-title",
        label,
        icon: titleIcon ?? "",
        color: "primary",
      },
    ];
  }, [titleLabel, titleIcon, tCommon]);

  return (
    <SpotlightShell isOpen={isOpen} onClose={onClose}>
      <PaletteBody
        kernel={kernel}
        items={items}
        placeholder={placeholderLabel ?? tCommon("filters.searchAgentOrOrg")}
        path={inputLeadingSlot ? [] : path}
        onRemoveSegment={
          inputLeadingSlot ? undefined : (onGoBackToParent ?? onClose)
        }
        inputLeadingSlot={inputLeadingSlot}
        containerHeight={containerHeight}
        afterListSlot={afterListSlot}
      />
      <ShellFooterAction>{footerAction}</ShellFooterAction>
    </SpotlightShell>
  );
};
