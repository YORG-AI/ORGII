---
title: Native WebView Scale System
status: active
last_updated: 2026-08-25
---

# Native WebView Scale System

This document describes how ORGII scales the main React UI while keeping native inline WebViews aligned with the visible browser surface.

## Problem

ORGII renders most UI inside the main Tauri WebView, but embedded browser content is rendered as separate native child WebViews. The two surfaces do not automatically share one DOM coordinate system.

The old app-level CSS `zoom` approach made text selection, CodeMirror pointer handling, terminal mouse interactions, and drag coordinates drift at non-100% scale. A pure CSS `transform: scale()` approach fixed CodeMirror's transform detection, but it did not solve native child WebView composition cleanly. The final model uses native zoom for the main app WebView and a dedicated native-frame coordinate contract for child WebViews.

## Final model

### Main React UI scale

The app shell applies user UI scale by calling the Tauri command `set_main_webview_zoom` with `scaleFactor = uiScale / 100`.

Important invariants:

- Do not use `document.documentElement.style.zoom` for app scaling.
- Do not scale `#root` with CSS transforms for the active production path.
- Keep `--ui-scale` set to `1` so frontend pointer compensation paths do not double-apply scale.
- Set `--native-frame-scale` to the actual DOM-CSS-pixel to Tauri logical-pixel conversion factor so native frame conversion can compensate DOMRect coordinates. On Windows this is measured from the running window as `window.devicePixelRatio / appWindow.scaleFactor()` instead of assuming it always equals the configured UI scale. Non-Windows platforms keep using the configured UI scale until the measured ratio is verified against WKWebView/Linux child webview behavior.

### Main WebView zoom target

The Rust command must set zoom on the actual main WebView:

```rust
let webview = app.get_webview("main").ok_or("Main WebView not found")?;
webview.set_zoom(scale_factor)?;
```

Do not set zoom through `get_webview_window("main")` for this scale path. That can appear to work without child WebViews, but it does not behave reliably once inline child WebViews participate in native composition.

### Inline WebView frame contract

Frontend code converts a measured DOMRect into a native frame using explicit start/end corners:

- `x`: left corner
- `y`: top corner
- `a`: right corner
- `b`: bottom corner
- `width`: derived compatibility field
- `height`: derived compatibility field

Rust accepts optional `a` and `b` for `create_inline_webview`, `update_inline_webview_position`, and `reposition_and_show_webview`. When present, Rust derives size as:

```rust
width = (a - x).max(OFFSCREEN_MIN_SIZE)
height = (b - y).max(OFFSCREEN_MIN_SIZE)
```

This avoids width/height drift caused by separate rounding of position and size.

### No child WebView auto resize

Inline child WebViews must not use `.auto_resize()`.

ORGII already owns the child WebView rectangle through React anchor measurement and manual Tauri commands. Letting Wry auto-resize the child WebView fights that manual positioning path, especially when the main WebView is natively zoomed.

## Measurement flow

The browser surface uses a dedicated invisible anchor inside `BrowserCore`:

```text
BrowserCore .browser-content
└── .browser-webview-frame-anchor
```

The anchor is the source of truth for the desired native child WebView rectangle. `useWebviewLayout` intersects the anchor with the viewport and every overflow-clipping ancestor, converts the resulting visible rectangle with `toNativeFrame`, and sends it to Rust. A fully clipped or invalid rectangle fails closed by staging the native surface offscreen.

## Shared browser owner flow

The visible browser panel is not always the component that directly owns the native child WebView. ORGII uses a shared browser owner:

```text
Visible Browser panel
→ SharedBrowserHostSlot publishes rect
→ activeSharedBrowserHostAtom selects active rect
→ SharedBrowserApp positions a fixed hidden owner host
→ BrowserCore inside owner host manages BrowserSessionWebview
→ useInlineWebview creates/repositions native child WebView
```

This means layout changes must update both:

1. the visible host rect registry, and
2. the native child WebView position after the shared owner host moves.

`SharedBrowserHostSlot` must publish the clipped rectangle from the original visible panel. Clipping only inside the fixed shared owner is insufficient because the original panel's overflow ancestors no longer exist in that copied DOM path.

## Native surface visibility and overlays

Native child WebViews do not participate in DOM stacking contexts. CSS `z-index`, portal roots, and `overflow: hidden` cannot reliably place React UI above or clip a child WebView.

ORGII therefore separates surface visibility from overlay occlusion:

```text
overlay DOMRect registry
        ↓ intersect + native-frame scale
BrowserSession WebView-local holes
        ↓ latest-wins IPC
macOS CALayer mask + native input handoff
```

Important invariants:

- `isActive` controls page lifecycle; `isVisible` controls only the native surface. Opening an overlay must not destroy, reload, or navigate the page.
- On macOS, each overlay publishes its real viewport rectangle. Every visible browser session intersects those rectangles with its host and applies only the local holes to the WKWebView. The native page remains painted everywhere else; the app never sends the entire WebView behind the opaque main surface.
- Interactive overlays temporarily hand native pointer input back to React while they are open. Passive overlays such as tooltips can leave page input enabled.
- macOS input handoff routes hit testing directly from the covered child WKWebView to the main React WKWebView. Re-running the child container's parent hit test is not sufficient because the two WebViews can live under different native container views and produce a bare `nil`, which lets the click escape to another application. The fallback must fail closed inside the inline WebView, and it must not change an individual WKWebView's runtime class because AppKit may KVO-observe its frame.
- Overlapping rectangles are conservatively coalesced before the even-odd mask is built, and both frontend and Rust cap the path at 64 rectangles.
- Platforms without native region masking currently retain the offscreen compatibility fallback.
- Resize, scroll, scale, and delayed layout callbacks re-check the latest desired visibility before writing a frame. A stale callback cannot move an obscured surface back onscreen.
- Surface commands are serialized per WebView. The last requested visibility wins.
- Restoration uses `reposition_and_show_webview`, which sets position and size before calling `show()` in one native command.
- Frame de-duplication state is committed only after the native command succeeds, so failed IPC remains retryable.

BrowserCore's loading and confirmed error panels also set `isVisible=false` while keeping `isActive=true`. The sensitive-host fallback is only a time-based hint and must not hide a successfully loaded native page. This preserves cookies, login state, history, and in-page memory while real blocking UI is shown.

Only opaque overlay surfaces are registered as holes. A translucent backdrop cannot be alpha-composited with a sibling native WKWebView; registering the backdrop itself would replace the live page with the opaque main app surface. Dialog content remains correctly visible and interactive, while the live page stays visible outside it.

## Layout-change event

Some layout changes move the browser anchor without changing its size. Examples:

- switching the chat panel from left to right,
- changing chat panel layout mode,
- toggling chat focus/maximize,
- sidebar state changes that affect content origin.

`ResizeObserver` does not fire when only `left/top` changes. For this case ORGII dispatches `orgii-webview-layout-changed` via `dispatchWebviewLayoutChanged()`.

Consumers:

- `AppLayout` dispatches after chat/sidebar layout inputs change.
- `SharedBrowserHostSlot` listens and republishes its DOMRect.
- `SharedBrowserApp` dispatches again after `activeRect` changes so native WebViews remeasure after the fixed owner host has moved.
- `useWebviewLayout` listens and performs forced multi-frame position updates.

The multi-frame update cadence catches CSS/flex layout settling without relying on width/height changes.

## Debugging checklist

When inline WebViews are misaligned under UI scale:

1. Confirm `set_main_webview_zoom` targets `app.get_webview("main")`.
2. Confirm child WebViews are not using `.auto_resize()`.
3. Confirm the measured anchor visually matches the intended browser rectangle.
4. Confirm `toNativeFrame` emits `x/y/a/b` and applies `--native-frame-scale`.
5. On Windows, confirm `--native-frame-scale` matches `window.devicePixelRatio / appWindow.scaleFactor()`. A mismatch here makes offsets grow with distance from the window origin, so right-side browser panes can look shifted even when the DOMRect measurement is correct.
6. Confirm Rust receives `a/b` and derives size from corners.
7. If the browser panel moves without resizing, confirm `orgii-webview-layout-changed` reaches `SharedBrowserHostSlot` and `useWebviewLayout`.
8. If using the shared browser owner, confirm `SharedBrowserApp` has moved its fixed host before the final native position update.
9. If a React overlay is covered, confirm its primitive calls `useOverlayLayer(active, elementRef)` and publishes a non-zero rectangle in `overlayOcclusionStateAtom`.
10. If a hidden WebView reappears during resize or scroll, confirm all native position writes pass through `useWebviewLayout`'s serialized visibility gate.
11. If the whole page becomes white when an overlay opens, confirm no caller invokes the removed `browser_webviews_set_layer_for_all` z-order command.

## Files of interest

- `src/app/root/useAppShellEffects.ts` — applies native app zoom and CSS scale variables.
- `src/util/platform/tauri/nativeFrame.ts` — converts DOMRect to `x/y/a/b` native frame payloads.
- `src/hooks/platform/useInlineWebview/useWebviewLayout.ts` — observes and repositions inline WebViews.
- `src/hooks/platform/useInlineWebview/visibleWebviewRect.ts` — intersects anchors with viewport and overflow clipping ancestors.
- `src/store/ui/overlayLayerAtom.ts` — owns the runtime overlay rectangle registry.
- `src/hooks/platform/useInlineWebview/nativeWebviewOcclusion.ts` — intersects/coalesces overlay holes in the WebView-local coordinate system.
- `src/hooks/platform/useInlineWebview/useInlineWebviewOcclusions.ts` — serializes latest-wins native mask projection per browser session.
- `src-tauri/crates/browser/src/occlusion.rs` — applies the macOS CALayer mask and input handoff.
- `src/hooks/platform/useInlineWebview/useWebviewCommands.ts` — creates inline WebViews with native frame payloads.
- `src/hooks/platform/useInlineWebview/webviewLayoutEvents.ts` — shared layout-change event helper.
- `src/engines/BrowserCore/index.tsx` — owns the browser frame anchor.
- `src/modules/WorkStation/Browser/shared/SharedBrowserHostSlot.tsx` — publishes visible browser host rects.
- `src/modules/WorkStation/Browser/shared/SharedBrowserApp.tsx` — positions the shared browser owner host.
- `src/modules/shared/layouts/AppLayout.tsx` — dispatches layout-change events for chat/sidebar layout shifts.
- `src-tauri/crates/app-window/src/commands.rs` — sets zoom on the main WebView.
- `src-tauri/crates/browser/src/inline.rs` — creates and repositions inline child WebViews.
