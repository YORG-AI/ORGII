/**
 * Jotai Store
 *
 * Creates a singleton Jotai store for the application.
 * Provides imperative access to the store for use outside of React components.
 */
import { createStore } from "jotai";

// Global reference to the store for imperative access
let globalStore: ReturnType<typeof createStore> | null = null;

/**
 * Get the global store (for use in ErrorBoundary, services, and other places)
 * This replaces getDefaultStore() from Jotai
 */
export function getInstrumentedStore() {
  if (!globalStore) {
    throw new Error(
      "Store not initialized. Call createInstrumentedStore() first."
    );
  }
  return globalStore;
}

/**
 * Check if the global store has been initialized
 */
export function isStoreInitialized(): boolean {
  return globalStore !== null;
}

/**
 * Drops the singleton so the next `createInstrumentedStore()` builds a fresh
 * one. Intended for tests.
 *
 * Atom values live in the store, not in the atom objects, so a new store is
 * already a clean slate for every atom. Without this, a suite that wants
 * per-case isolation has to reach for `vi.resetModules()` and re-import the
 * whole atom graph on every test -- which is what made the store suites the
 * slowest and flakiest files in the run.
 */
export function resetInstrumentedStore() {
  globalStore = null;
}

/**
 * Creates the singleton Jotai store for the application
 */
export function createInstrumentedStore() {
  // Return existing store if already created (singleton pattern)
  if (globalStore) {
    return globalStore;
  }

  globalStore = createStore();
  return globalStore;
}
