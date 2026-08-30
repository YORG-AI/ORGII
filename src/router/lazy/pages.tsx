import React from "react";

// ============================================
// Lazy page components
// ============================================

export const SelectRepoPage = React.lazy(
  () =>
    import(
      /* webpackChunkName: "workspace" */ "@src/modules/MainApp/SelectRepo"
    )
);

export const AgentOrgsPage = React.lazy(
  () =>
    import(/* webpackChunkName: "mainapp" */ "@src/modules/MainApp/AgentOrgs")
);

export const MyRolePage = React.lazy(
  () => import(/* webpackChunkName: "mainapp" */ "@src/modules/MainApp/MyRole")
);

// Supabase OAuth callback — NOT a market feature. Required for login to work
// in any build (OSS or hosted). Path stays "/orgii/marketplace/callback"
// so existing desktop deep-link routing remains stable.
export const AuthCallback = React.lazy(
  () =>
    import(
      /* webpackChunkName: "auth-callback" */ "@src/modules/AppLogin/AuthCallback"
    )
);

export const LoginPage = React.lazy(
  () => import(/* webpackChunkName: "auth" */ "@/src/modules/AppLogin")
);

// Detached session window (label `app-window-session-<id>`): one session
// surface with no app shell. Opened by `open_session_window` (Rust).
export const SessionWindowPage = React.lazy(
  () => import(/* webpackChunkName: "workspace" */ "@src/modules/SessionWindow")
);

export const FlowAwarenessTestPage = React.lazy(
  () =>
    import(
      /* webpackChunkName: "dev-tools" */ "@src/components/FlowAwarenessTest"
    )
);

// Route preloading functions live in ./preload.ts (cycle-free)
