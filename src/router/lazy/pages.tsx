import React from "react";

// ============================================
// Lazy page components
// ============================================

export const SuggestionsPage = React.lazy(
  () =>
    import(/* webpackChunkName: "workspace" */ "@src/modules/MainApp/StartPage")
);

export const SelectRepoPage = React.lazy(
  () =>
    import(
      /* webpackChunkName: "workspace" */ "@src/modules/MainApp/SelectRepo"
    )
);

export const ChangelogPage = React.lazy(
  () =>
    import(/* webpackChunkName: "changelog" */ "@src/modules/MainApp/Changelog")
);

export const Settings = React.lazy(
  () =>
    import(/* webpackChunkName: "settings" */ "@/src/modules/MainApp/Settings")
);

export const AgentOrgsPage = React.lazy(
  () =>
    import(/* webpackChunkName: "mainapp" */ "@src/modules/MainApp/AgentOrgs")
);

export const MyRolePage = React.lazy(
  () => import(/* webpackChunkName: "mainapp" */ "@src/modules/MainApp/MyRole")
);

// Market routes (Consumer Wallet, Profile, Provider Earnings/Boost, Creator
// Studio, Delegation History) all resolve to the OSS unavailable-page
// placeholder. The real implementations live out-of-app on the ORGII
// website. We keep the named exports so the route tree (`routeGroups.tsx`)
// continues to compile; the placeholder points the user at the ORGII site.
const MarketUnavailable = React.lazy(
  () =>
    import(
      /* webpackChunkName: "market-unavailable" */ "@src/router/routes/OpenSourceMarketUnavailablePage"
    )
);

export const ConsumerWallet = MarketUnavailable;
export const Profile = MarketUnavailable;
export const PublicProfilePage = MarketUnavailable;
export const ProviderEarnings = MarketUnavailable;
export const ProviderBoost = MarketUnavailable;
export const AgentStudioPage = MarketUnavailable;
export const DelegationHistoryPage = MarketUnavailable;

// Supabase OAuth callback — NOT a market feature. Required for login to work
// in any build (OSS or hosted). Path stays "/orgii/marketplace/callback"
// so existing desktop deep-link routing remains stable.
export const AuthCallback = React.lazy(
  () =>
    import(
      /* webpackChunkName: "auth-callback" */ "@src/modules/AppLogin/AuthCallback"
    )
);

export const TabWindow = React.lazy(
  () => import(/* webpackChunkName: "windows" */ "@src/windows/TabWindow")
);

export const ModeSelectionWindow = React.lazy(
  () =>
    import(/* webpackChunkName: "windows" */ "@src/windows/ModeSelectionWindow")
);

export const LoginPage = React.lazy(
  () => import(/* webpackChunkName: "auth" */ "@/src/modules/AppLogin")
);

export const SetupWalkthrough = React.lazy(
  () => import(/* webpackChunkName: "auth" */ "@/src/modules/SetupWalkthrough")
);

export const FlowAwarenessTestPage = React.lazy(
  () =>
    import(
      /* webpackChunkName: "dev-tools" */ "@src/components/FlowAwarenessTest"
    )
);

// Route preloading functions live in ./preload.ts (cycle-free)
