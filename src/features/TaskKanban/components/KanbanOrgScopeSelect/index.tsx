import { useAtom, useAtomValue } from "jotai";
import { Cloud, Laptop } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { type ProjectOrg, projectApi } from "@src/api/http/project";
import Select, { type SelectOption } from "@src/components/Select";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { buildOrgSelectorEntries } from "@src/features/Organizations/orgSelectorEntries";
import { sidebarSelectedOrgIdAtom } from "@src/features/Organizations/sidebarOrgScopeAtom";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import { DEFAULT_SESSION_ORG_ID } from "@src/store/session";

const logger = createLogger("KanbanOrgScopeSelect");

function orgPickerRowsEqual(
  previous: readonly ProjectOrg[],
  next: readonly ProjectOrg[]
): boolean {
  return (
    previous.length === next.length &&
    previous.every((org, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        org.id === candidate.id &&
        org.name === candidate.name &&
        org.external_org_id === candidate.external_org_id
      );
    })
  );
}

/** Compact organization scope switcher for the Work Management header. */
const KanbanOrgScopeSelect: React.FC = memo(() => {
  const { t } = useTranslation("navigation");
  const { t: tProjects } = useTranslation("projects");
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const [selectedOrgId, setSelectedOrgId] = useAtom(sidebarSelectedOrgIdAtom);
  const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
  const requestVersionRef = useRef(0);

  const loadProjectOrgs = useCallback(async (): Promise<
    ProjectOrg[] | null
  > => {
    try {
      return await projectApi.readOrgs();
    } catch (error) {
      logger.error("Failed to load Kanban organization options", error);
      return null;
    }
  }, []);

  const applyProjectOrgs = useCallback(
    (requestVersion: number, nextOrgs: ProjectOrg[]) => {
      if (requestVersion !== requestVersionRef.current) return;
      setProjectOrgs((previousOrgs) =>
        orgPickerRowsEqual(previousOrgs, nextOrgs) ? previousOrgs : nextOrgs
      );
    },
    []
  );

  const refreshProjectOrgs = useCallback(() => {
    const requestVersion = ++requestVersionRef.current;
    void loadProjectOrgs().then((nextOrgs) => {
      if (nextOrgs) applyProjectOrgs(requestVersion, nextOrgs);
    });
  }, [applyProjectOrgs, loadProjectOrgs]);

  useEffect(() => {
    const requestVersion = ++requestVersionRef.current;
    void loadProjectOrgs().then((nextOrgs) => {
      if (nextOrgs) applyProjectOrgs(requestVersion, nextOrgs);
    });
    return () => {
      requestVersionRef.current += 1;
    };
  }, [applyProjectOrgs, loadProjectOrgs]);

  useProjectDataChanged(refreshProjectOrgs);

  const options = useMemo<SelectOption[]>(
    () =>
      buildOrgSelectorEntries({
        personalOrgId: DEFAULT_SESSION_ORG_ID,
        personalLabel: tProjects("orgs.personalOrg"),
        localOrgs: projectOrgs,
        cloudOrgs,
        localSuffix: "local",
      }).map((entry) => ({
        value: entry.value,
        label: entry.label,
        icon:
          entry.kind === "cloud" ? (
            <Cloud size={13} strokeWidth={2} />
          ) : (
            <Laptop size={13} strokeWidth={2} />
          ),
        dataTestId: `kanban-org-option-${entry.kind}-${entry.value}`,
      })),
    [cloudOrgs, projectOrgs, tProjects]
  );

  const handleChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      setSelectedOrgId(String(value));
    },
    [setSelectedOrgId]
  );

  return (
    <Select
      value={selectedOrgId}
      options={options}
      onChange={handleChange}
      placeholder={t("collaboration.switchOrg")}
      showSearch={options.length > 8}
      size="small"
      appearance="ghost"
      radius="lg"
      dropdownMinWidth={168}
      dropdownWidthMode="auto"
      className="w-auto max-w-48 shrink-0"
      selectorClassName="!gap-2 !px-1 [&_.select-suffix]:!ml-1"
      dataTestId="kanban-org-scope-select"
    />
  );
});

KanbanOrgScopeSelect.displayName = "KanbanOrgScopeSelect";

export default KanbanOrgScopeSelect;
