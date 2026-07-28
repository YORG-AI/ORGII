/**
 * Minimal route path constants
 *
 * Zero-dependency path strings used by modules that cannot import from routes.ts
 * (e.g. windowScopedState which would create a circular dependency).
 *
 * Keep in sync with route definitions in routes.ts.
 */
export const ROUTE_PATHS = {
  startPage: "/orgii/app/start-page",
} as const;
