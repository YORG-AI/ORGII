/**
 * Route preloading — extracted from pages.tsx to avoid circular dependencies.
 *
 * This module uses only dynamic import() expressions (no static imports from
 * the app module graph), so it is safe to import from NavigationMenu, TabItem,
 * AppShell, etc. without creating cycles.
 */

type RouteLoader = () => Promise<unknown>;

const loadAgentOrgs: RouteLoader = () =>
  import("@src/modules/MainApp/AgentOrgs");
const loadMyRole: RouteLoader = () => import("@src/modules/MainApp/MyRole");
const loadSettingsSlot: RouteLoader = () =>
  import("@src/modules/MainApp/Settings/SettingsSlot");
const loadMarketPlaceholder: RouteLoader = () =>
  import("@src/router/routes/OpenSourceMarketUnavailablePage");

/**
 * Route segment → chunk loader(s). Keys are matched as prefixes of the
 * URL segment after `/app/`, in insertion order. A single key may map
 * to multiple loaders when one URL prefix can render multiple modules.
 *
 * Settings: every `/settings/*` URL is rendered by `SettingsSlot`,
 * which dispatches to `AgentOrgsPage` / `MyRolePage` / inline section
 * renderers at runtime. We warm the slot chunk plus its lazy children
 * so any settings landing is ready.
 */
const APP_ROUTE_LOADERS: Record<string, RouteLoader | RouteLoader[]> = {
  settings: [loadSettingsSlot, loadAgentOrgs, loadMyRole],
  "market/tokens": loadMarketPlaceholder,
  "market/services": loadMarketPlaceholder,
  "market/profile": loadMarketPlaceholder,
  "market/wallet": loadMarketPlaceholder,
  "market/earnings": loadMarketPlaceholder,
  "market/boost": loadMarketPlaceholder,
  "market/agent-apps": loadMarketPlaceholder,
  "market/agent-studio": loadMarketPlaceholder,
  "market/delegation-history": loadMarketPlaceholder,
};

function runLoaders(loader: RouteLoader | RouteLoader[]): void {
  const loaders = Array.isArray(loader) ? loader : [loader];
  for (const fn of loaders) fn().catch(() => {});
}

const _preloadedRoutes = new Set<string>();
/**
 * Preload a single route's chunk based on its full path (e.g. "/orgii/app/settings").
 * Deduplicates so each chunk is only fetched once.
 */
function preloadRouteSegment(
  namespace: string,
  segment: string,
  loadersByRoute: Record<string, RouteLoader | RouteLoader[]>
): void {
  const key = `${namespace}:${segment}`;
  if (_preloadedRoutes.has(key)) return;

  for (const [route, loader] of Object.entries(loadersByRoute)) {
    if (segment.startsWith(route)) {
      _preloadedRoutes.add(key);
      runLoaders(loader);
      return;
    }
  }
}

export function preloadRouteByPath(routePath: string): void {
  const appSegment = routePath.split("/app/")[1];
  if (appSegment) {
    preloadRouteSegment("app", appSegment, APP_ROUTE_LOADERS);
    return;
  }
}
