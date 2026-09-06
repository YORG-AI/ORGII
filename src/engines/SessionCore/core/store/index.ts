/**
 * EventStore — barrel export.
 *
 * Re-exports the Rust-backed proxy, hooks, and legacy compatibility.
 */

// Rust-backed EventStore proxy (new primary API)
export { eventStoreProxy } from "./EventStoreProxy";
export type {
  DerivedSnapshot,
  StreamingSnapshot,
  EventStoreProxy,
} from "./EventStoreProxy";

export { eventStoreProxy as eventStore } from "./EventStoreProxy";

export { useEventStoreSelector } from "./hooks";

export { useEventStoreBridge } from "./useEventStoreBridge";

export { useSessionEvents } from "./useSessionEvents";
