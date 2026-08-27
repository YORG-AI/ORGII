/**
 * `useCallbackRefEffect` — run an effect when a DOM element is
 * attached, and tear it down when the element is detached.
 *
 * ## Problem this solves
 *
 * The canonical "attach a side effect to an element" pattern in React is:
 *
 *   ```tsx
 *   const ref = useRef<HTMLDivElement | null>(null);
 *   useEffect(() => {
 *     const el = ref.current;
 *     if (!el) return;
 *     el.addEventListener("scroll", onScroll);
 *     return () => el.removeEventListener("scroll", onScroll);
 *   }, [onScroll]);
 *   return <div ref={ref}>…</div>;
 *   ```
 *
 * This works **only if the ref'd element is in the JSX tree on the
 * first effect run**. The instant the element is conditional —
 * `isCollapsed ? null : <div ref={ref}>…</div>` is the most common
 * shape — the pattern silently breaks:
 *
 *   1. First render: `isCollapsed = true`, the `<div>` isn't rendered,
 *      so `ref.current` is `null`.
 *   2. The effect runs, sees `null`, bails out.
 *   3. User toggles → `<div>` mounts and `ref.current` is populated.
 *   4. **The effect never re-runs**, because `ref.current` isn't in
 *      the dependency array (and even if it were, refs don't trigger
 *      re-renders).
 *   5. The listener is never attached. The bug is invisible until a
 *      user reports "scrolling doesn't auto-hide the scrollbar after
 *      I expand this block".
 *
 * `useCallbackRefEffect` fixes this by using React's callback-ref
 * idiom under the hood. The "ref" you attach to your JSX is a
 * function, not a mutable ref object. React calls it with the
 * element when it mounts, and with `null` when it unmounts (or when
 * the element identity changes). We turn those callbacks into a
 * deterministic "setup / teardown" pair that runs at exactly the
 * right time, regardless of when the element actually appears in
 * the tree.
 *
 * ## Returned value
 *
 * The hook returns a stable ref-callback. Use it as `ref={...}` on
 * the JSX element you care about. You may apply the same callback
 * to multiple sibling elements; the setup runs once per `attach`
 * call, and tearing down for an element that wasn't attached is a
 * no-op.
 *
 * The callback identity is stable across renders, so passing it to
 * `ref={...}` will not trigger an "attach → detach → attach" cycle
 * on every render. (Inline `ref={(el) => …}` does that and is the
 * other half of why people avoid callback refs.)
 *
 * ## Effect lifecycle
 *
 * The `setup(element)` function may return a cleanup function. The
 * cleanup runs:
 *   - When the element unmounts (React calls the ref-callback with
 *     `null`).
 *   - When the hook is unmounted while the element is still attached.
 *   - When `deps` change (re-running setup/cleanup, same as
 *     `useEffect`).
 *
 * `setup` is called with the *current* element; it is never called
 * with `null`. If the element is never attached, `setup` is never
 * called and cleanup is therefore never needed.
 *
 * ## Comparison to common alternatives
 *
 *   - `useEffect` + `useRef`: works only if the element is in the
 *     initial render.
 *   - `useLayoutEffect` + `useRef`: same limitation, just earlier
 *     in the commit phase.
 *   - Inline callback ref `ref={el => { … }}`: identity changes
 *     every render → attach/detach storm.
 *   - `useMemo(() => (el: T | null) => { … }, [deps])`: no way to
 *     express the cleanup half cleanly, and `deps`-driven re-runs
 *     fight against the ref-callback lifecycle.
 *
 * `useCallbackRefEffect` packages the correct interaction once.
 *
 * @example Scroll listener on a conditional element
 * ```tsx
 * const refCb = useCallbackRefEffect<HTMLDivElement>(
 *   (el) => {
 *     const onScroll = () => setIsScrolling(true);
 *     el.addEventListener("scroll", onScroll, { capture: true });
 *     return () => el.removeEventListener("scroll", onScroll, { capture: true });
 *   },
 *   []
 * );
 *
 * return isCollapsed ? null : <div ref={refCb}>…</div>;
 * ```
 *
 * @example Animation loop scoped to element presence
 * ```tsx
 * const refCb = useCallbackRefEffect<HTMLDivElement>(
 *   (el) => {
 *     const id = setInterval(() => runAnimation(el), 2200);
 *     return () => clearInterval(id);
 *   },
 *   [enabled]
 * );
 * ```
 */
import { type DependencyList, useCallback, useEffect, useRef } from "react";

export type CallbackRefEffectCleanup = (() => void) | void;
export type CallbackRefEffectSetup<T extends Element> = (
  element: T
) => CallbackRefEffectCleanup;
export type CallbackRefEffectHandle<T extends Element> = (
  element: T | null
) => void;

/**
 * Internal state machine driving the hook. Extracted as a named
 * class so the lifecycle can be unit-tested without spinning up a
 * React renderer (the host codebase doesn't ship `@testing-library`
 * or `jsdom`).
 *
 * The class encapsulates three transitions:
 *   - `attach(el | null)` — mirror of the JSX ref-callback.
 *   - `rerunOnDepChange()` — what `useEffect(_, deps)` triggers when
 *     `deps` change and there is a live element.
 *   - `dispose()` — mirror of the `useEffect` final cleanup at unmount.
 *
 * It's deliberately framework-agnostic: pass in a "warn" callback
 * for error reporting and you can drive it from anywhere.
 */
export class CallbackRefEffectLifecycle<T extends Element> {
  private element: T | null = null;
  private cleanup: CallbackRefEffectCleanup = undefined;
  private setup: CallbackRefEffectSetup<T>;
  private readonly warn: (msg: string, err: unknown) => void;

  constructor(
    setup: CallbackRefEffectSetup<T>,
    warn?: (msg: string, err: unknown) => void
  ) {
    this.setup = setup;
    this.warn = warn ?? defaultWarn;
  }

  /**
   * Update the captured setup closure. Always called on every render
   * so callers don't have to list captured props/state in `deps`.
   */
  updateSetup(setup: CallbackRefEffectSetup<T>): void {
    this.setup = setup;
  }

  /**
   * Currently-attached element, or `null` if none. Exposed for tests
   * and for callers that want to compose with their own refs.
   */
  getElement(): T | null {
    return this.element;
  }

  /**
   * Driven by React's ref-callback lifecycle. Idempotent if the
   * incoming element is the one we already track.
   */
  attach(element: T | null): void {
    if (element === this.element) return;
    if (this.element !== null) {
      this.runCleanup();
    }
    this.element = element;
    if (element !== null) {
      this.runSetup(element);
    }
  }

  /**
   * Re-run cleanup + setup against the current element. Caller
   * (typically `useEffect(_, deps)`) is responsible for invoking
   * this only when `deps` have changed AND an element is attached.
   * Cheap no-op if no element.
   */
  rerunOnDepChange(): void {
    if (this.element === null) return;
    this.runCleanup();
    this.runSetup(this.element);
  }

  /**
   * Final tear-down. Idempotent — safe to call multiple times.
   */
  dispose(): void {
    this.runCleanup();
    this.element = null;
  }

  private runSetup(element: T): void {
    try {
      this.cleanup = this.setup(element);
    } catch (err) {
      this.warn(
        "[useCallbackRefEffect] setup callback threw; no cleanup will run:",
        err
      );
      this.cleanup = undefined;
    }
  }

  private runCleanup(): void {
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    if (typeof cleanup === "function") {
      try {
        cleanup();
      } catch (err) {
        this.warn("[useCallbackRefEffect] cleanup callback threw:", err);
      }
    }
  }
}

function defaultWarn(msg: string, err: unknown): void {
  // Documented fallback when no warn handler is injected; this raw
  // console.warn is asserted by CallbackRefEffectLifecycle.test.ts.
  console.warn(msg, err);
}

/**
 * Run a side effect whenever a DOM element is attached, and tear it
 * down when the element is detached, *regardless* of whether the
 * element was present on first render.
 *
 * @param setup     Called with the freshly-attached element. May
 *                  return a cleanup function.
 * @param deps      Dependency list (same semantics as `useEffect`).
 *                  When any dep changes, the existing cleanup runs
 *                  and `setup(element)` is invoked again with the
 *                  *currently attached* element (if any).
 *
 * @returns A stable ref-callback to attach to a JSX element via
 *          `ref={...}`. Calling it with `null` triggers cleanup.
 */
export function useCallbackRefEffect<T extends Element>(
  setup: CallbackRefEffectSetup<T>,
  deps: DependencyList
): CallbackRefEffectHandle<T> {
  // Lazy-init the lifecycle on first render so the captured setup
  // is the one from the same render (no "first render uses second
  // render's setup" weirdness).
  const lifecycleRef = useRef<CallbackRefEffectLifecycle<T> | null>(null);
  if (lifecycleRef.current === null) {
    lifecycleRef.current = new CallbackRefEffectLifecycle<T>(setup);
  } else {
    lifecycleRef.current.updateSetup(setup);
  }

  const handle = useCallback<CallbackRefEffectHandle<T>>((element) => {
    lifecycleRef.current?.attach(element);
  }, []);

  useEffect(() => {
    lifecycleRef.current?.rerunOnDepChange();
    // We don't return a cleanup here; the cleanup is owned by the
    // ref-callback lifecycle (which fires on element detach and on
    // unmount). Doing both would double-run the user cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- this hook intentionally forwards the caller-supplied dependency list and refreshes setup through CallbackRefEffectLifecycle
  }, deps);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    return () => {
      lifecycle?.dispose();
    };
  }, []);

  return handle;
}

export default useCallbackRefEffect;
