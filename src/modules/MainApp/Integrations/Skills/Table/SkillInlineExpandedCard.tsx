import { readTextFile } from "@tauri-apps/plugin-fs";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import type { CursorRepo } from "@src/hooks/policies";
import { InlineInfoCard } from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";
import { SKILL_SOURCE } from "@src/types/extensions";
import type { HubSkillDetail, InstalledSkill } from "@src/types/extensions";
import { parseSkillFrontmatter } from "@src/util/skills/skillFrontmatter";

import {
  InlineCardColumnStack,
  InlineCardSplit,
} from "../../KeyVault/shared/InlineCardPrimitives";
import { getSkillResolvedSourceLabel } from "../skillSourceLabel";

const logger = createLogger("SkillInlineExpandedCard");

interface SkillInlineExpandedCardProps {
  skill: InstalledSkill;
  hubDetail?: HubSkillDetail | null;
  cursorRepos?: CursorRepo[];
}

const SkillInlineExpandedCard: React.FC<SkillInlineExpandedCardProps> = ({
  skill,
  hubDetail,
  cursorRepos,
}) => {
  const { t } = useTranslation("integrations");
  const [parsedDescription, setParsedDescription] = useState<string | null>(
    null
  );
  const isEmbeddedBuiltin = skill.source === SKILL_SOURCE.EMBEDDED_BUILTIN;

  useEffect(() => {
    if (!skill.path || isEmbeddedBuiltin) {
      return;
    }
    let cancelled = false;
    readTextFile(skill.path)
      .then((content) => {
        if (cancelled) return;
        const parsed = parseSkillFrontmatter(content);
        const value = parsed?.frontmatter.description;
        setParsedDescription(typeof value === "string" ? value : null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logger.warn("failed to parse SKILL.md description", err);
        setParsedDescription(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isEmbeddedBuiltin, skill.path]);

  const effectiveParsedDescription =
    skill.path && !isEmbeddedBuiltin ? parsedDescription : null;
  const rawDescription =
    effectiveParsedDescription ?? hubDetail?.description ?? skill.description;
  const description = rawDescription?.trim() || undefined;

  const hasBinIssues = (skill.missingBins?.length ?? 0) > 0;
  const hasEnvIssues = (skill.missingEnv?.length ?? 0) > 0;
  const hasIssues = hasBinIssues || hasEnvIssues;

  const statusLabel = hasIssues
    ? t("skillPreview.issues")
    : skill.enabled
      ? t("status.enabled")
      : t("status.disabled");

  return (
    <InlineInfoCard>
      <div className="flex min-w-0 flex-col gap-3">
        {description && (
          <p className="text-xs leading-relaxed wrap-break-word whitespace-pre-wrap text-text-2">
            {description}
          </p>
        )}
        <InlineCardSplit
          equalColumns
          left={
            <InlineCardColumnStack>
              <InfoRow
                label={t("skillPreview.source")}
                value={getSkillResolvedSourceLabel(t, skill, cursorRepos)}
              />
              <InfoRow label={t("skillPreview.status")}>
                <span
                  className={`text-[12px] font-medium ${
                    hasIssues ? "text-warning-6" : "text-text-2"
                  }`}
                >
                  {statusLabel}
                </span>
              </InfoRow>
            </InlineCardColumnStack>
          }
          right={
            <InlineCardColumnStack>
              {skill.version && (
                <InfoRow
                  label={t("skillPreview.version")}
                  value={skill.version}
                />
              )}
              {(skill.requiredBins?.length ?? 0) > 0 && (
                <InfoRow label={t("skillPreview.binaries")}>
                  <div className="flex flex-wrap gap-1">
                    {skill.requiredBins.map((bin) => (
                      <span
                        key={bin}
                        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          skill.missingBins?.includes(bin)
                            ? "bg-warning-1 text-warning-6"
                            : "bg-fill-3 text-text-2"
                        }`}
                      >
                        {bin}
                      </span>
                    ))}
                  </div>
                </InfoRow>
              )}
              {(skill.requiredEnv?.length ?? 0) > 0 && (
                <InfoRow label={t("skillPreview.envVars")}>
                  <div className="flex flex-wrap gap-1">
                    {skill.requiredEnv.map((envVar) => (
                      <span
                        key={envVar}
                        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          skill.missingEnv?.includes(envVar)
                            ? "bg-warning-1 text-warning-6"
                            : "bg-fill-3 text-text-2"
                        }`}
                      >
                        {envVar}
                      </span>
                    ))}
                  </div>
                </InfoRow>
              )}
              {skill.path && (
                <InfoRow label={t("skillPreview.location")}>
                  <span className="text-[11px] break-all text-text-2">
                    {skill.path}
                  </span>
                </InfoRow>
              )}
            </InlineCardColumnStack>
          }
        />
      </div>
    </InlineInfoCard>
  );
};

export default SkillInlineExpandedCard;
