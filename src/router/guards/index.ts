/**
 * Route Guards
 *
 * Authentication and authorization guards for routes.
 * Note: RequireAuth was removed -- the global AuthGuard in RootLayout
 * already blocks all unauthenticated users at the router level.
 */

export { AuthGuard } from "./AuthGuard";
export { AuthRedirect } from "./AuthRedirect";
