import React, { Suspense } from "react";
import {
  Navigate,
  Outlet,
  type RouteObject,
  useLocation,
} from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import { HOSTED_LOGIN_ENABLED } from "@src/config/serviceAuth";
import MainAppShell from "@src/modules/shared/layouts/MainAppShell";
import { Placeholder } from "@src/modules/shared/layouts/blocks/Placeholder";
import {
  AgentStudioPage,
  AuthCallback,
  ConsumerWallet,
  DelegationHistoryPage,
  FlowAwarenessTestPage,
  LoginPage,
  Profile,
  ProviderBoost,
  ProviderEarnings,
  PublicProfilePage,
  SelectRepoPage,
  SetupWalkthrough,
} from "@src/router/lazy/pages";
import ComingSoonRoutePage from "@src/router/routes/ComingSoonRoutePage";
import OpenSourceMarketUnavailablePage from "@src/router/routes/OpenSourceMarketUnavailablePage";
import { WorkStationRoutePlaceholder } from "@src/router/routes/placeholders";

const Loading = () => <Placeholder variant="loading" />;

const HostedLoginRoute: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  if (!HOSTED_LOGIN_ENABLED) {
    return <Navigate to={ROUTES.workStation.base.path} replace />;
  }
  return <>{children}</>;
};

const lazy = (element: React.ReactNode, withLoader = true) => (
  <Suspense fallback={withLoader ? <Loading /> : null}>{element}</Suspense>
);

/**
 * Settings outlet — intentionally renders nothing. Every URL under
 * `/orgii/app/settings/*` is owned by `SettingsSlot`, which is mounted
 * by `AppShell` inside the chat-panel slot and dispatches to the right
 * inner surface based on the route root (`APP`, `AGENT_ORGS`,
 * `MY_ROLE`). The route entries are kept so refresh + deep links
 * resolve and so the URL drives the slot's body via `useLocation()`.
 */
const UnifiedSettingsPage: React.FC = () => null;

/**
 * Redirect legacy `/orgii/app/agent-orgs/<tab>[/<category>]` URLs to their
 * new `/orgii/app/settings/<tab>[/<category>]` equivalents so external
 * deep links, bookmarks, and persisted spotlight entries continue to work.
 *
 * `agent-orgs/integrations/<category>` collapses further into
 * `settings/<category>` because integrations no longer have a distinct URL
 * prefix inside the unified settings surface.
 */
const LegacyAgentOrgsRedirect: React.FC = () => {
  const { pathname, search, hash } = useLocation();
  const rewritten = pathname
    .replace("/agent-orgs/integrations", "/settings")
    .replace("/agent-orgs", "/settings");
  return <Navigate to={rewritten + (search ?? "") + (hash ?? "")} replace />;
};

/**
 * Redirect legacy `/settings/core-settings[/<id>]`,
 * `/settings/app-settings[/<section>]`, and `/settings/integrations[/<category>]`
 * URLs to their simplified `/settings[/<id>]` equivalents.
 */
const LegacyCoreSettingsRedirect: React.FC = () => {
  const { pathname, search, hash } = useLocation();
  const rewritten = pathname
    .replace("/settings/core-settings", "/settings")
    .replace("/settings/app-settings", "/settings")
    .replace("/settings/integrations", "/settings");
  return <Navigate to={rewritten + (search ?? "") + (hash ?? "")} replace />;
};
const WORK_STATION_PATHS = [
  "workstation",
  "workstation/code",
  "workstation/browser",
  "workstation/chat",
  "workstation/project",
] as const;

export const workStationRouteGroup: RouteObject[] = [
  ...WORK_STATION_PATHS.map((path) => ({
    path,
    element: <WorkStationRoutePlaceholder />,
  })),
];

export const projectManagerRouteGroup: RouteObject[] = [
  {
    path: "project-manager",
    element: <Navigate to={ROUTES.workStation.project.path} replace />,
  },
];

export const appStandaloneRouteGroup: RouteObject[] = [
  {
    path: "app/login",
    element: lazy(
      <HostedLoginRoute>
        <LoginPage />
      </HostedLoginRoute>,
      false
    ),
  },
  { path: "app/select-repo", element: lazy(<SelectRepoPage />, false) },
  {
    path: "app/walkthrough",
    element: lazy(<SetupWalkthrough />),
  },
  { path: "marketplace/callback", element: lazy(<AuthCallback />) },
];

export const workbenchAppRouteGroup: RouteObject[] = [
  // Unified Settings surface. Every `/settings/*` path is owned by
  // `SettingsSlot` (mounted by `AppShell` in the chat-panel slot);
  // these outlet entries just keep the URL deeplinkable. The slot
  // dispatches to APP / AGENT_ORGS / MY_ROLE bodies based on
  // `classifySettingsRouteRoot(pathname)`.
  //
  { path: "app/settings/*", element: <UnifiedSettingsPage /> },
  // Legacy Core URLs redirect to the simplified /settings[/<id>] shape.
  {
    path: "app/settings/core-settings",
    element: <LegacyCoreSettingsRedirect />,
  },
  {
    path: "app/settings/core-settings/:item",
    element: <LegacyCoreSettingsRedirect />,
  },
  {
    path: "app/settings/core-settings/:item/:tab",
    element: <LegacyCoreSettingsRedirect />,
  },
  // Legacy `/settings/app-settings` and `/settings/integrations` URLs
  // redirect to the unified Settings tab so old deep links keep working.
  {
    path: "app/settings/app-settings",
    element: <LegacyCoreSettingsRedirect />,
  },
  {
    path: "app/settings/app-settings/:section",
    element: <LegacyCoreSettingsRedirect />,
  },
  {
    path: "app/settings/integrations",
    element: <LegacyCoreSettingsRedirect />,
  },
  {
    path: "app/settings/integrations/:category",
    element: <LegacyCoreSettingsRedirect />,
  },
  // Legacy `/agent-orgs/*` URLs redirect to the unified settings surface.
  {
    path: "app/agent-orgs",
    element: <Navigate to={ROUTES.app.settings.path} replace />,
  },
  {
    path: "app/agent-orgs/:tab",
    element: <LegacyAgentOrgsRedirect />,
  },
  {
    path: "app/agent-orgs/:tab/:category",
    element: <LegacyAgentOrgsRedirect />,
  },
];

export const mainAppRouteGroup: RouteObject = {
  path: "app",
  element: <MainAppShell />,
  children: [
    {
      path: "dev-tools/flow-awareness-test",
      element: lazy(<FlowAwarenessTestPage />),
    },
    {
      path: "market",
      element: <Outlet />,
      children: [
        {
          index: true,
          element: <Navigate to={ROUTES.app.market.tokenMarket.path} replace />,
        },
        {
          path: "tokens",
          element: <OpenSourceMarketUnavailablePage />,
        },
        {
          path: "services",
          element: <OpenSourceMarketUnavailablePage />,
        },
        { path: "profile", element: <Profile /> },
        { path: "profile/:userId", element: <PublicProfilePage /> },
        { path: "wallet", element: <ConsumerWallet /> },
        { path: "earnings", element: <ProviderEarnings /> },
        { path: "boost", element: <ProviderBoost /> },
        {
          path: "agent-apps",
          element: <OpenSourceMarketUnavailablePage />,
        },
        {
          path: "agent-apps/:agentId",
          element: <OpenSourceMarketUnavailablePage />,
        },
        { path: "agent-studio", element: <AgentStudioPage /> },
        { path: "delegation-history", element: <DelegationHistoryPage /> },
      ],
    },
    { path: "ideas", element: <ComingSoonRoutePage /> },
  ],
};
