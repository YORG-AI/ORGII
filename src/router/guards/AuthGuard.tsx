/**
 * AuthGuard - Global authentication gate
 *
 * SIMPLE APPROACH: If not authenticated, immediately redirect to login.
 * No race conditions, no freeze issues - user must be logged in to use the app.
 *
 * Listens for session expiration events from API calls (401/403 responses).
 */
import { useAtom } from "jotai";
import React, { useCallback, useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { AUTH_ROUTES } from "@src/config/routes";
import { isAuthSkipped, isServiceAuthenticated } from "@src/config/serviceAuth";
import { useServiceAuth } from "@src/hooks/auth";
import {
  SESSION_EXPIRED_EVENT,
  sessionExpiredAtom,
} from "@src/store/ui/uiAtom";

/**
 * Check if current path should bypass auth check
 */
function isPublicPath(pathname: string): boolean {
  // Login page itself (now inside AppShell at /orgii/app/login)
  if (pathname === AUTH_ROUTES.login.path) return true;
  // OAuth callback routes (must process auth code first)
  if (pathname.includes("/marketplace/callback")) return true;
  // Root path (handled by AuthRedirect)
  if (pathname === "/") return true;
  return false;
}

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * AuthGuard Component
 *
 * Wraps children and blocks access when not authenticated.
 * Returns Navigate to redirect, or children if authenticated.
 */
export const AuthGuard: React.FC<AuthGuardProps> = ({ children }) => {
  const { isAuthenticated, logout, refresh } = useServiceAuth();
  const location = useLocation();
  const [sessionExpired, setSessionExpired] = useAtom(sessionExpiredAtom);

  // Handler for session expiration events from API calls
  const handleSessionExpired = useCallback(() => {
    setSessionExpired(true);
  }, [setSessionExpired]);

  // Listen for session expiration events
  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [handleSessionExpired]);

  // The bundled app and tauri:dev have different WebView origins. Re-read the
  // shared Tauri auth store once when this app regains focus.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  // Handle session expiration - clear auth state (no redirect, AuthGuard handles it)
  useEffect(() => {
    if (sessionExpired) {
      logout({ redirect: false });
      setSessionExpired(false);
    }
  }, [sessionExpired, logout, setSessionExpired]);

  // Skip auth check for public paths - render children directly
  if (isPublicPath(location.pathname)) {
    return <>{children}</>;
  }

  // Check auth status (both hook state and direct check for SSR/initial render).
  // `isAuthSkipped()` lets BYOK-only users use the app without a hosted
  // account — they explicitly clicked "Continue without signing in" on the
  // login page, and that choice persists until they sign in or sign out.
  const authenticated =
    isAuthenticated || isServiceAuthenticated() || isAuthSkipped();

  // If not authenticated, redirect to login IMMEDIATELY during render
  // This prevents any race conditions or user interaction with protected routes
  if (!authenticated) {
    return (
      <Navigate
        to={AUTH_ROUTES.login.path}
        replace
        state={{ from: location }}
      />
    );
  }

  // Authenticated - render children
  return <>{children}</>;
};
