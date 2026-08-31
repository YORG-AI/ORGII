/**
 * Session Rendering Infrastructure
 *
 * Event rendering system for displaying SessionEvent data across different contexts:
 * - Chat: Activity history in ChatPanel
 * - Simulator: Interactive event playback in Simulator
 *
 * Architecture:
 * - registry/: Event type registry and component loaders
 * - hooks.tsx: Unified rendering hooks (useUnifiedEventRenderer)
 * - props/: Props normalization and data extractors for events
 *
 * @see {@link src/session/index.ts} for public API exports
 */
export * from "./registry";
export * from "./hooks";
export {
  normalizeEventProps,
  useNormalizedEventProps,
  type RawEventInput,
} from "./props/propsNormalizer";
