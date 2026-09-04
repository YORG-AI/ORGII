import { useAtomValue } from "jotai";
import React, { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
} from "react-router-dom";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  org2CloudOrgsAtom,
  useOrg2CloudOrgs,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useOrg2CloudRosterReconcile } from "@src/features/Org2Cloud/org2CloudRosterReconcile";

import { WebAuthCallbackPage } from "./features/auth/WebAuthCallbackPage";
import { WebLoginPage } from "./features/auth/WebLoginPage";
import { WebCloudRealtimeScope } from "./features/sessions/WebCloudRealtimeScope";
import { WebCloudSessionEventCacheLifecycle } from "./features/sessions/WebCloudSessionEventCacheLifecycle";
import { WebOrgRemoteSessionSubscriptions } from "./features/sessions/WebOrgRemoteSessionSubscriptions";
import { WebSessionsProvider } from "./features/sessions/WebSessionsContext";
import { WebSessionsPage } from "./features/sessions/WebSessionsPage";
import { WebShell } from "./shell/WebShell";

const WebSessionPage = lazy(() =>
  // The registry rides the session chunk: transcript rendering is its only
  // consumer, and lazy() suspends until BOTH resolve, so no tool block can
  // render against an unconfigured registry. Both imports are dynamic on
  // purpose — a static import here would pull the registry back into the
  // entry graph and re-gate /login on it.
  Promise.all([
    import("./features/sessions/WebSessionPage"),
    import("@src/engines/SessionCore/rendering/registry/initToolRegistry").then(
      (registry) => registry.initBundledToolRegistry()
    ),
  ]).then(([module]) => ({
    default: module.WebSessionPage,
  }))
);

function SessionRoute({ replayInitially = false }) {
  const { t } = useTranslation("navigation");
  return (
    <Suspense
      fallback={
        <div
          className="text-secondary flex min-h-0 flex-1 items-center justify-center text-sm"
          role="status"
        >
          {t("web.loadingSession")}
        </div>
      }
    >
      <WebSessionPage replayInitially={replayInitially} />
    </Suspense>
  );
}

function RequireCloudAuth() {
  const auth = useAtomValue(org2CloudAuthAtom);
  return auth ? <Outlet /> : <Navigate to="/login" replace />;
}

function WebCloudRuntime() {
  useOrg2CloudOrgs();
  useOrg2CloudRosterReconcile();
  const auth = useAtomValue(org2CloudAuthAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  return (
    <WebSessionsProvider
      key={auth ? org2CloudAuthIdentityKey(auth) : "signed-out"}
    >
      <WebCloudRealtimeScope />
      <WebOrgRemoteSessionSubscriptions orgIds={orgs.map((org) => org.orgId)} />
      <Outlet />
    </WebSessionsProvider>
  );
}

const router = createBrowserRouter([
  { path: "/login", element: <WebLoginPage /> },
  { path: "/auth/callback", element: <WebAuthCallbackPage /> },
  {
    element: <RequireCloudAuth />,
    children: [
      {
        element: <WebCloudRuntime />,
        children: [
          {
            element: <WebShell />,
            children: [
              { index: true, element: <Navigate to="/sessions" replace /> },
              { path: "/sessions", element: <WebSessionsPage /> },
              {
                path: "/sessions/:orgId/:sessionId",
                element: <SessionRoute />,
              },
              {
                path: "/sessions/:orgId/:sessionId/replay",
                element: <SessionRoute replayInitially />,
              },
            ],
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/sessions" replace /> },
]);

export function WebApp() {
  return (
    <>
      <WebCloudSessionEventCacheLifecycle />
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </>
  );
}
