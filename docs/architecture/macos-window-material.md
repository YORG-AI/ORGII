# macOS window material

ORG2 uses AppKit's `NSVisualEffectView` with the `Menu` material and
`BehindWindow` blending beneath its transparent WKWebView. This is the native
material configured by Codex's normal macOS window. Existing ORG2 sidebar,
page-opacity, wallpaper, and theme settings still control the web surfaces above
it; this change does not copy Codex's CSS or its size-based opaque-window policy.

## Compatibility

The material uses the same implementation across supported macOS versions.
`NSVisualEffectView` is available from macOS 10.10 and `Menu` from 10.11, before
ORG2's 10.15 deployment minimum. Apple Silicon starts at macOS 11. No macOS 26
class lookup, private material variant, or undocumented native corner-radius
selector is used. AppKit owns the decorated window's outer clipping.

| macOS | Native implementation | Validation scope |
| --- | --- | --- |
| 10.15 Catalina (Intel) | Public menu vibrancy | SDK API availability |
| 11 Big Sur / 12 Monterey | Public menu vibrancy | SDK API availability, Intel and Apple Silicon |
| 13 Ventura / 14 Sonoma / 15 Sequoia | Public menu vibrancy | SDK API availability, Intel and Apple Silicon |
| 26 Tahoe | Public menu vibrancy | SDK API availability, Intel and Apple Silicon; development host is 26.3 arm64 |

An SDK availability check proves the selected APIs are declared for those
deployment targets, not that the application was run on each OS. The material's
colors and blur can vary with macOS, light/dark appearance, focus, and system
accessibility settings. Allow AppKit to manage them instead of reproducing the
material in CSS or forcing a private variant.

The transparent WKWebView still relies on the existing `macOSPrivateApi`
configuration and background-drawing helpers. Removing the Liquid Glass plugin
does not remove that separate requirement or raise the deployment minimum.

## Ownership and lifecycle

`app_window::macos_material` performs each lookup and mutation synchronously on
AppKit's main thread. A native window pointer never crosses the dispatch
boundary. The window's content view retains its material subview, identified by
`org2.window.menu-vibrancy`.

- Enable creates one view if absent; repeated enable leaves the same view in
  place. No global registry or per-window retained handle is needed.
- Disable removes only the identified view; repeated disable does nothing.
- The material resizes with its parent and follows the window's active state
  through native AppKit properties. No polling or app-owned observers are added.
- Destroying the content view releases the material with the rest of its native
  subviews.

Initial main-window setup, main-window recovery, and detached session windows
continue to call the same apply helper. The startup opaque cover remains until
the frontend is ready. The external-page navigation command still removes the
material and supplies its opaque color/image cover, then restores the material
on return. Its IPC arguments and result type are unchanged.

## Dependency choice

The implementation uses the workspace's existing `objc2`, `objc2-app-kit`,
`objc2-foundation`, and `dispatch2` dependencies directly. No dependency is added
or upgraded. Removing `tauri-plugin-liquid-glass` also removes its otherwise
unused `cocoa`, `cocoa-foundation`, `block`, `objc`, `dispatch`, and `malloc_buf`
dependency chain.

The pinned Tauri 2.10.3 `set_effects(None)` path does not clear macOS effects.
Its apply path can create additional native views on repeated calls. Direct
native ownership avoids that issue. The existing window-vibrancy 0.6 helper also
calls an undocumented `NSVisualEffectView.setCornerRadius:` selector even when
no radius is supplied; it is not used for this macOS implementation. Windows
continues to use its existing window-vibrancy helper unchanged.

## Release verification

The final PR records commands actually run. Native visual and lifecycle checks
remain necessary on representative older and current macOS releases:

- Light and dark themes, bright/dark desktop backgrounds, and Reduce
  Transparency enabled/disabled.
- Cold startup and frontend-ready transition, main-window recovery, detached
  session creation/close, and external-page navigation/return.
- Repeated enable/disable, proving the content view has zero or one owned
  material view and unrelated subviews remain intact.
- Focus changes, minimize/restore, resize/fullscreen, and Retina/external-display
  changes.
- Visible/hidden idle and active CPU/GPU behavior; source shape alone is not
  performance evidence.

Rollback is a revert of the material implementation and manifest/lockfile
removals. No persisted settings, schemas, or user data require migration.
