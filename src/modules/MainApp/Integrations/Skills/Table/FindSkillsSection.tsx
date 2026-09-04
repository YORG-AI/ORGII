import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ChevronsDownUpIcon, HugeiconsIcon, UnfoldMoreIcon } from "@src/icons";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { FindSkillsResults } from "./FindSkillsSection/FindSkillsResults";
import { useFindSkills } from "./FindSkillsSection/hooks/useFindSkills";

interface FindSkillsSectionProps {
  onPreview?: (slug: string) => void;
}

const FindSkillsSection: React.FC<FindSkillsSectionProps> = ({ onPreview }) => {
  const { t } = useTranslation("integrations");
  const [expanded, setExpanded] = useState(false);
  const findSkills = useFindSkills({ onPreview });

  return (
    <SectionContainer>
      <SectionRow label={t("agentOrgs.findSkills.title")}>
        <Button
          variant="secondary"
          icon={
            expanded ? (
              <HugeiconsIcon
                icon={ChevronsDownUpIcon}
                data-icon="chevrons-down-up"
                size={14}
              />
            ) : (
              <HugeiconsIcon
                icon={UnfoldMoreIcon}
                data-icon="chevrons-up-down"
                size={14}
              />
            )
          }
          onClick={() => setExpanded((current) => !current)}
        >
          {t("common:actions.expand")}
        </Button>
      </SectionRow>

      {expanded && (
        <SectionRow showHeader={false} className="pt-0">
          <div className="flex w-full min-w-0 flex-col gap-3">
            {findSkills.error && (
              <div className="rounded border border-solid border-danger-3 bg-danger-1 px-3 py-2 text-[12px] text-danger-6">
                {findSkills.error}
              </div>
            )}
            <FindSkillsResults
              query={findSkills.query}
              results={findSkills.results}
              hasSearched={findSkills.hasSearched}
              searching={findSkills.searching}
              previewingSlug={findSkills.previewingSlug}
              canSearch={findSkills.canSearch}
              t={t}
              onQueryChange={findSkills.setQuery}
              onClear={findSkills.clearSearch}
              onSearch={findSkills.search}
              onPreview={findSkills.preview}
            />
          </div>
        </SectionRow>
      )}
    </SectionContainer>
  );
};

export default FindSkillsSection;
