import { readTextFile } from "@tauri-apps/plugin-fs";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CursorPluginInfo } from "@src/api/tauri/rpc/procedures/agentOrgs";
import { createLogger } from "@src/hooks/logger";
import { useCopyCheck } from "@src/hooks/ui";
import {
  ClipboardIcon,
  HugeiconsIcon,
  Layers01Icon,
  SquareArrowUpRightIcon,
  Tick01Icon,
  WorkflowCircle05Icon,
} from "@src/icons";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";
import { copyText } from "@src/util/data/clipboard";
import { extractSkillPreviewDescription } from "@src/util/skills/skillFrontmatter";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import {
  InlineCardBody,
  InlineCardColumnStack,
  InlineCardFooter,
  InlineCardShell,
  InlineCardSplit,
  InlineCardTabs,
} from "../KeyVault/shared/InlineCardPrimitives";
import { getMcpServerNames } from "./usePluginLogo";

const PLUGIN_INLINE_TAB = {
  MCP: "mcp",
  SKILLS: "skills",
  HOOKS: "hooks",
} as const;

type PluginInlineTab =
  (typeof PLUGIN_INLINE_TAB)[keyof typeof PLUGIN_INLINE_TAB];

const SKILLS_INITIAL_LIMIT = 5;
const logger = createLogger("CursorPluginInlineExpandedCard");

interface CursorPluginInlineExpandedCardProps {
  plugin: CursorPluginInfo;
}

const CursorPluginInlineExpandedCard: React.FC<
  CursorPluginInlineExpandedCardProps
> = ({ plugin }) => {
  const { t } = useTranslation("integrations");

  const hasMcp = !!plugin.mcpConfig;
  const hasSkills = plugin.skills.length > 0;
  const hasHooks = plugin.hooks.length > 0;

  const defaultTab = hasMcp
    ? PLUGIN_INLINE_TAB.MCP
    : hasSkills
      ? PLUGIN_INLINE_TAB.SKILLS
      : PLUGIN_INLINE_TAB.HOOKS;

  const [activeTab, setActiveTab] = useState<PluginInlineTab>(defaultTab);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [parsedSkillDescriptions, setParsedSkillDescriptions] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    let cancelled = false;

    async function loadSkillDescriptions() {
      const entries = await Promise.all(
        plugin.skills.map(async (skill) => {
          const content = await readTextFile(skill.skillPath);
          const description = extractSkillPreviewDescription(content);
          return [skill.slug, description] as const;
        })
      );

      if (cancelled) return;

      setParsedSkillDescriptions(
        entries.reduce<Record<string, string>>((acc, [slug, description]) => {
          if (description) acc[slug] = description;
          return acc;
        }, {})
      );
    }

    loadSkillDescriptions().catch((error: unknown) => {
      if (cancelled) return;
      logger.warn("failed to parse plugin skill descriptions", error);
      setParsedSkillDescriptions({});
    });

    return () => {
      cancelled = true;
    };
  }, [plugin.skills]);

  const tabs = [
    {
      key: PLUGIN_INLINE_TAB.MCP,
      label: "MCP",
      disabled: !hasMcp,
    },
    {
      key: PLUGIN_INLINE_TAB.SKILLS,
      label: t("cursorPlugins.skillCount", { count: plugin.skills.length }),
      disabled: !hasSkills,
    },
    {
      key: PLUGIN_INLINE_TAB.HOOKS,
      label: t("cursorPlugins.hooksCount", { count: plugin.hooks.length }),
      disabled: !hasHooks,
    },
  ];

  const mcpServerNames = getMcpServerNames(
    plugin.mcpConfig as Record<string, unknown> | null
  );

  const onCopyMcp = useCallback(async () => {
    if (!plugin.mcpConfig) return;
    await copyText(JSON.stringify(plugin.mcpConfig, null, 2));
  }, [plugin.mcpConfig]);
  const { copied: mcpCopied, handleCopy: handleCopyMcp } =
    useCopyCheck(onCopyMcp);

  const visibleSkills = skillsExpanded
    ? plugin.skills
    : plugin.skills.slice(0, SKILLS_INITIAL_LIMIT);
  const hiddenCount = plugin.skills.length - SKILLS_INITIAL_LIMIT;

  const mcpContent = (
    <InlineCardSplit
      equalColumns
      left={
        <InlineCardColumnStack>
          {mcpServerNames.length > 0 ? (
            mcpServerNames.map((serverName) => (
              <InfoRow key={serverName} label="Server">
                <span className="font-mono text-[11px] text-text-2">
                  {serverName}
                </span>
              </InfoRow>
            ))
          ) : (
            <InfoRow label="Config">
              <span className="text-[12px] text-text-3">
                {t("cursorPlugins.mcpConfigured")}
              </span>
            </InfoRow>
          )}
        </InlineCardColumnStack>
      }
      right={<InlineCardColumnStack>{null}</InlineCardColumnStack>}
    />
  );

  const skillsContent = (
    <div className="flex flex-col overflow-hidden">
      {visibleSkills.map((skill) => (
        <button
          key={skill.slug}
          type="button"
          onClick={() =>
            openFileInWorkStation(skill.skillPath, { defaultPreviewMode: true })
          }
          className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left hover:bg-fill-1"
        >
          <HugeiconsIcon
            icon={Layers01Icon}
            data-icon="layers"
            size={12}
            className="shrink-0 text-text-3"
          />
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-medium text-text-1">
                {skill.name}
              </span>
              <HugeiconsIcon
                icon={SquareArrowUpRightIcon}
                data-icon="square-arrow-out-up-right"
                size={11}
                className="shrink-0 text-text-3"
              />
            </div>
            {(parsedSkillDescriptions[skill.slug] || skill.description) && (
              <span className="block truncate text-[11px] text-text-3">
                {parsedSkillDescriptions[skill.slug] || skill.description}
              </span>
            )}
          </div>
        </button>
      ))}
      {!skillsExpanded && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setSkillsExpanded(true)}
          className="px-3 py-1.5 text-left text-[12px] text-text-3 hover:text-text-1"
        >
          {t("cursorPlugins.viewMore", { count: hiddenCount })}
        </button>
      )}
    </div>
  );

  const hooksContent = (
    <div className="flex flex-col overflow-hidden">
      {plugin.hooks.map((hook) => (
        <button
          key={hook.eventType}
          type="button"
          onClick={() =>
            openFileInWorkStation(hook.hookPath, { defaultPreviewMode: true })
          }
          className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left hover:bg-fill-1"
        >
          <HugeiconsIcon
            icon={WorkflowCircle05Icon}
            data-icon="git-branch"
            size={12}
            className="shrink-0 text-text-3"
          />
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-medium text-text-1">
                {hook.label}
              </span>
              <HugeiconsIcon
                icon={SquareArrowUpRightIcon}
                data-icon="square-arrow-out-up-right"
                size={11}
                className="shrink-0 text-text-3"
              />
            </div>
            <span className="block truncate font-mono text-[11px] text-text-3">
              {hook.eventType}
            </span>
          </div>
        </button>
      ))}
    </div>
  );

  const tabContent = (() => {
    switch (activeTab) {
      case PLUGIN_INLINE_TAB.SKILLS:
        return skillsContent;
      case PLUGIN_INLINE_TAB.HOOKS:
        return hooksContent;
      case PLUGIN_INLINE_TAB.MCP:
      default:
        return mcpContent;
    }
  })();

  return (
    <div className="w-0 min-w-full overflow-hidden">
      <InlineCardShell>
        <InlineCardTabs
          tabs={tabs}
          activeTab={activeTab}
          onChange={setActiveTab}
        />
        <InlineCardBody>{tabContent}</InlineCardBody>
        {activeTab === PLUGIN_INLINE_TAB.MCP && hasMcp && (
          <InlineCardFooter>
            <button
              onClick={handleCopyMcp}
              className="inline-flex items-center gap-1.5 rounded border border-border-2 px-3 py-1.5 text-[12px] text-text-2 transition-colors hover:bg-fill-3 hover:text-text-1"
            >
              {mcpCopied ? (
                <HugeiconsIcon icon={Tick01Icon} data-icon="check" size={12} />
              ) : (
                <HugeiconsIcon
                  icon={ClipboardIcon}
                  data-icon="clipboard"
                  size={12}
                />
              )}
              {mcpCopied
                ? t("common:status.copied")
                : t("cursorPlugins.copyMcpConfig")}
            </button>
          </InlineCardFooter>
        )}
      </InlineCardShell>
    </div>
  );
};

export default CursorPluginInlineExpandedCard;
