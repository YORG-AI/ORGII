import { Outlet, createBrowserRouter } from "react-router-dom";

import { ViewModeSync } from "@src/components/System";
import { useOrg2CloudOrgs } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useOrg2CloudRosterReconcile } from "@src/features/Org2Cloud/org2CloudRosterReconcile";
import { useOrg2CloudRealtime } from "@src/features/Org2Cloud/useOrg2CloudRealtime";
import { useOrg2CloudSyncEngine } from "@src/features/Org2Cloud/useOrg2CloudSyncEngine";
import { useDeepLinkHandler } from "@src/hooks/platform/useDeepLinkHandler";
import AppShell from "@src/modules";
import ErrorPage from "@src/modules/shared/Error";
import {
  appStandaloneRouteGroup,
  mainAppRouteGroup,
  projectManagerRouteGroup,
  windowRouteGroup,
  workStationRouteGroup,
} from "@src/router/routes/routeGroups";
import { RouteDebugModal } from "@src/scaffold/ModalSystem/variants/RouteDebug";

import { AuthGuard, AuthRedirect } from "./guards";

// Root layout component that includes ViewModeSync and global modals
const RootLayout = () => {
  // Handle deep links (yorgai://) for OAuth callbacks in Tauri production
  useDeepLinkHandler();
  // Fetch the signed-in user's ORG2 Cloud orgs (clears on sign-out).
  useOrg2CloudOrgs();
  // Once per app start, after the first successful roster load: prune
  // persisted org2-cloud-v1 maps keyed by org ids no longer in the roster.
  useOrg2CloudRosterReconcile();
  // Managed-cloud session push (Phase 6): scope-matched local sessions.
  useOrg2CloudSyncEngine();
  // Inbound Realtime: roster / projects / work-items / comment-tasks
  // subscriptions replace 60s polling as the primary inbound trigger.
  useOrg2CloudRealtime();

  return (
    <>
      <ViewModeSync />
      <RouteDebugModal />
      {/* AuthGuard wraps Outlet - if not authenticated, redirects to login */}
      <AuthGuard>
        <Outlet />
      </AuthGuard>
    </>
  );
};

const router = createBrowserRouter(
  [
    {
      path: "/",
      errorElement: <ErrorPage />,
      element: <RootLayout />,
      children: [
        {
          index: true,
          element: <AuthRedirect />,
        },
        {
          path: "orgii",
          errorElement: <ErrorPage />,
          element: (
            <>
              <AppShell />
            </>
          ),
          children: [
            ...workStationRouteGroup,
            ...projectManagerRouteGroup,
            ...appStandaloneRouteGroup,
            mainAppRouteGroup,
            // Catch-all route for 404s
            {
              path: "*",
              element: <ErrorPage />,
            },
          ],
        },
        { ...windowRouteGroup, errorElement: <ErrorPage /> },
        {
          path: "*",
          element: <ErrorPage />,
        },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  }
);

export { router };
