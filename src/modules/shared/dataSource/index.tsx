import { useAtomValue } from "jotai";
import { useAtomCallback } from "jotai/utils";
import React, {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import OrganizationScopeHeader from "@src/components/OrganizationScopeHeader";
import OrganizationTabSwitch from "@src/components/OrganizationTabSwitch";
import { Placeholder } from "@src/components/Placeholder";
import type { SelectOption } from "@src/components/Select";
import type { TabPillItem } from "@src/components/TabPill";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
  parseCloudOrgSelectorValue,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { buildOrgSelectorEntries } from "@src/features/Organizations/orgSelectorEntries";
import { CloudIcon, HugeiconsIcon, LaptopIcon } from "@src/icons";
import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { DEFAULT_SESSION_ORG_ID } from "@src/store/session";
import {
  type RuntimeOrganizationView,
  type RuntimePersonalView,
  runtimeNavigationIntentAtom,
} from "@src/store/ui/runtimeNavigationAtom";

// The section unions live with the navigation intent so a deep-link target and
// the tab it selects cannot drift apart.
type PersonalRuntimeSection = RuntimePersonalView;
type OrganizationRuntimeSection = RuntimeOrganizationView;
type RuntimeSection = PersonalRuntimeSection | OrganizationRuntimeSection;

const SessionUsagePanel = lazy(() => import("./SessionUsagePanel"));
const TeamRuntimePanel = lazy(() => import("./TeamRuntimePanel"));
// Same tab as org management → Sync; both mount the one wired component so
// the two surfaces cannot drift.
const CloudOrgSyncTab = lazy(
  () =>
    import("@src/engines/ChatPanel/panels/CloudOrgPanelView/CloudOrgSyncTab")
);
const BuilderProfilePanel = lazy(() => import("./BuilderProfilePanel"));
const RuntimeScanningPanel = lazy(() => import("./RuntimeScanningPanel"));
const SessionProvenanceHooksPanel = lazy(
  () => import("./SessionProvenanceHooksPanel")
);
const StartPageQuotaGrid = lazy(() =>
  import("@src/engines/ChatPanel/StartPageQuotaGrid").then((module) => ({
    default: module.StartPageQuotaGrid,
  }))
);
const WorkspaceDashboardPanelView = lazy(
  () => import("@src/engines/ChatPanel/panels/WorkspaceDashboardPanelView")
);

/**
 * Sections that lay themselves out inside the full pane height instead of
 * flowing through the shared padded wrapper. That wrapper ends in a `pb-[50vh]`
 * scroll affordance, which is right for long content but leaves a
 * placeholder-only section unable to fill — and centred in the top half.
 */
const SELF_MANAGED = new Set<RuntimeSection>(["assets", "profile"]);

interface RuntimeSectionTabsProps {
  activeView: RuntimeSection;
  onChange: (view: RuntimeSection) => void;
  organizationScope: boolean;
}

const RuntimeSectionTabs: React.FC<RuntimeSectionTabsProps> = memo(
  ({ activeView, onChange, organizationScope }) => {
    const { t } = useTranslation("sessions", {
      keyPrefix: "kanban.dataSource",
    });
    const { t: tTeamRuntime } = useTranslation("teamRuntime");
    const personalTabs = useMemo<TabPillItem[]>(() => {
      return [
        {
          key: "usage",
          label: t("views.usage"),
          dataTestId: "data-source-view-usage",
        },
        {
          key: "profile",
          label: t("views.profile"),
          dataTestId: "data-source-view-profile",
        },
        {
          key: "quota",
          label: t("views.quota"),
          dataTestId: "data-source-view-quota",
        },
        {
          key: "scanning",
          label: t("views.scanning"),
          dataTestId: "data-source-view-scanning",
        },
        {
          key: "hooks",
          label: t("views.hooks"),
          dataTestId: "data-source-view-hooks",
        },
        {
          key: "assets",
          label: t("views.assets"),
          dataTestId: "data-source-view-assets",
        },
      ];
    }, [t]);
    const organizationTabs = useMemo<TabPillItem[]>(
      () => [
        {
          key: "today",
          label: tTeamRuntime("overview.today"),
          dataTestId: "data-source-view-org-today",
        },
        {
          key: "members",
          label: tTeamRuntime("overview.members"),
          dataTestId: "data-source-view-org-members",
        },
        {
          key: "sync",
          label: tTeamRuntime("overview.sync"),
          dataTestId: "data-source-view-org-sync",
        },
      ],
      [tTeamRuntime]
    );

    return (
      <div
        data-guide-target={
          organizationScope ? GUIDE_TARGETS.TEAM_RUNTIME_TABS : undefined
        }
      >
        <OrganizationTabSwitch
          activeTab={activeView}
          tabs={organizationScope ? organizationTabs : personalTabs}
          onChange={(key) => onChange(key as RuntimeSection)}
          size="large"
        />
      </div>
    );
  }
);

RuntimeSectionTabs.displayName = "RuntimeSectionTabs";

function RuntimeSectionContent({
  activeView,
  orgId,
}: {
  activeView: RuntimeSection;
  orgId: string | null;
}): React.ReactElement | null {
  switch (activeView) {
    case "usage":
      return <SessionUsagePanel />;
    case "profile":
      return <BuilderProfilePanel />;
    case "quota":
      return <StartPageQuotaGrid />;
    case "scanning":
      return <RuntimeScanningPanel />;
    case "hooks":
      return <SessionProvenanceHooksPanel showTitle={false} />;
    case "assets":
      return <WorkspaceDashboardPanelView />;
    case "today":
      return <TeamRuntimePanel orgId={orgId ?? undefined} view="today" />;
    case "members":
      return <TeamRuntimePanel orgId={orgId ?? undefined} view="members" />;
    case "sync":
      // Only reachable under a cloud-org scope, which is exactly when orgId is
      // non-null; the personal scope has no sync tab to fall back to.
      return orgId === null ? null : <CloudOrgSyncTab orgId={orgId} />;
  }
}

const RuntimeDataSourcePanel: React.FC = () => {
  const { t: tProjects } = useTranslation("projects");
  const auth = useAtomValue(org2CloudAuthAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const cloudOrgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const sidebarCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const runtimeNavigationIntent = useAtomValue(runtimeNavigationIntentAtom);
  const consumeRuntimeNavigationIntent = useAtomCallback(
    useCallback((get, set, requestId: number) => {
      const current = get(runtimeNavigationIntentAtom);
      if (current?.requestId !== requestId) return null;
      set(runtimeNavigationIntentAtom, null);
      return current;
    }, [])
  );
  const [scopeValue, setScopeValue] = useState(() =>
    sidebarCloudOrgId
      ? buildCloudOrgSelectorValue(sidebarCloudOrgId)
      : DEFAULT_SESSION_ORG_ID
  );
  const [personalView, setPersonalView] =
    useState<PersonalRuntimeSection>("usage");
  const [organizationView, setOrganizationView] =
    useState<OrganizationRuntimeSection>("today");

  useEffect(() => {
    const intent = runtimeNavigationIntent;
    if (!intent) return;
    // A personal intent carries no organization, so it must not wait on — or
    // be dropped by — the cloud-organization gate.
    if (intent.scope === "organization" && !cloudOrgsLoaded) return;

    let cancelled = false;
    const requestId = intent.requestId;
    const requestedOrgId =
      intent.scope === "organization" ? intent.orgId : null;
    const requestedOrgExists =
      requestedOrgId === null ||
      cloudOrgs.some((org) => org.orgId === requestedOrgId);
    queueMicrotask(() => {
      if (cancelled) return;
      const consumedIntent = consumeRuntimeNavigationIntent(requestId);
      if (!consumedIntent) return;
      if (consumedIntent.scope === "personal") {
        setScopeValue(DEFAULT_SESSION_ORG_ID);
        setPersonalView(consumedIntent.view);
        return;
      }
      if (auth === null || !requestedOrgExists) return;
      setScopeValue(buildCloudOrgSelectorValue(consumedIntent.orgId));
      setOrganizationView(consumedIntent.view);
    });

    return () => {
      cancelled = true;
    };
  }, [
    auth,
    cloudOrgs,
    cloudOrgsLoaded,
    consumeRuntimeNavigationIntent,
    runtimeNavigationIntent,
  ]);

  const requestedCloudOrgId = parseCloudOrgSelectorValue(scopeValue);
  const requestedOrgExists =
    requestedCloudOrgId === null ||
    cloudOrgs.some((org) => org.orgId === requestedCloudOrgId);
  const cloudScopeIsValid =
    requestedCloudOrgId === null ||
    (auth !== null && (!cloudOrgsLoaded || requestedOrgExists));
  const effectiveScopeValue = cloudScopeIsValid
    ? scopeValue
    : DEFAULT_SESSION_ORG_ID;
  const selectedCloudOrgId = parseCloudOrgSelectorValue(effectiveScopeValue);
  const organizationScope = selectedCloudOrgId !== null;
  const panelView: RuntimeSection = organizationScope
    ? organizationView
    : personalView;

  const scopeOptions = useMemo<SelectOption[]>(() => {
    const entries = buildOrgSelectorEntries({
      personalOrgId: DEFAULT_SESSION_ORG_ID,
      personalLabel: tProjects("orgs.personalOrg"),
      localOrgs: [],
      cloudOrgs,
      localSuffix: "",
    });
    return entries.map((entry) => ({
      value: entry.value,
      label: entry.label,
      icon:
        entry.kind === "cloud" ? (
          <HugeiconsIcon
            icon={CloudIcon}
            data-icon="cloud"
            size={13}
            strokeWidth={2}
          />
        ) : (
          <HugeiconsIcon
            icon={LaptopIcon}
            data-icon="laptop"
            size={13}
            strokeWidth={2}
          />
        ),
      dataTestId: `runtime-scope-${entry.kind}-${entry.value}`,
    }));
  }, [cloudOrgs, tProjects]);

  const handleViewChange = (view: RuntimeSection) => {
    if (organizationScope) {
      setOrganizationView(view as OrganizationRuntimeSection);
    } else {
      setPersonalView(view as PersonalRuntimeSection);
    }
  };
  const handleScopeChange = (nextScopeValue: string) => {
    if (parseCloudOrgSelectorValue(nextScopeValue) !== null) {
      setOrganizationView("today");
    }
    setScopeValue(nextScopeValue);
  };

  const loadingFallback = (
    <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
  );

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden">
      <OrganizationScopeHeader
        value={effectiveScopeValue}
        options={scopeOptions}
        onChange={handleScopeChange}
        dataTestId="runtime-scope-header"
        selectorDataTestId="runtime-scope-picker"
        tabControl={
          <RuntimeSectionTabs
            activeView={panelView}
            onChange={handleViewChange}
            organizationScope={organizationScope}
          />
        }
      />

      <ScrollPreservation
        data-testid="data-source-scroll-region"
        className={
          SELF_MANAGED.has(panelView)
            ? "min-h-0 flex-1 overflow-hidden scrollbar-hide"
            : "min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide @container"
        }
      >
        {SELF_MANAGED.has(panelView) ? (
          <Suspense key={effectiveScopeValue} fallback={loadingFallback}>
            <RuntimeSectionContent
              activeView={panelView}
              orgId={selectedCloudOrgId}
            />
          </Suspense>
        ) : (
          <div
            className={`${DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop} ${SECTION_GAP_CLASSES}`}
          >
            <Suspense key={effectiveScopeValue} fallback={loadingFallback}>
              <RuntimeSectionContent
                activeView={panelView}
                orgId={selectedCloudOrgId}
              />
            </Suspense>
          </div>
        )}
      </ScrollPreservation>
    </div>
  );
};

export default RuntimeDataSourcePanel;
