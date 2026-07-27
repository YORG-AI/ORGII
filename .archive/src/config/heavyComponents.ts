/**
 * Heavy Components - Dynamic imports for large dependencies
 *
 * These components are loaded lazily to reduce initial bundle size.
 */
import { type ComponentType, type LazyExoticComponent, lazy } from "react";

/**
 * Recharts - Charting library (~500KB)
 * Used in analytics and statistics
 */
export const RechartsProvider = lazy(() =>
  import(/* webpackChunkName: "recharts" */ "recharts").then(() => ({
    default: () => null, // Placeholder, actual charts imported separately
  }))
);

/**
 * Markdown Renderer - Markdown to React (~300KB with dependencies)
 * Used in documentation and README rendering
 */
export const ReactMarkdown = lazy(
  () => import(/* webpackChunkName: "react-markdown" */ "react-markdown")
);

/**
 * Syntax Highlighter - Code syntax highlighting (~400KB)
 * Used in code display features
 */
export const SyntaxHighlighter: LazyExoticComponent<
  ComponentType<Record<string, never>>
> = lazy(() =>
  import(
    /* webpackChunkName: "syntax-highlighter" */ "react-syntax-highlighter"
  ).then((mod) => ({
    default: mod.Prism as unknown as ComponentType<Record<string, never>>,
  }))
);

/**
 * Usage Examples:
 *
 * // Markdown rendering
 * import { ReactMarkdown } from "@src/config/heavyComponents";
 * import { Suspense } from "react";
 *
 * const MyComponent = () => (
 *   <Suspense fallback={<LoadingSpinner />}>
 *     <ReactMarkdown>content</ReactMarkdown>
 *   </Suspense>
 * );
 *
 */
