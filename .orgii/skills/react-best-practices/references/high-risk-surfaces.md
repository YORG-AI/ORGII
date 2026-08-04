# High-Risk ORGII React Surfaces

## High-Risk ORGII Surfaces

Do not make speculative performance refactors in these areas. Read owners/callers, preserve lifecycle semantics, and add focused verification:

- ChatPanel send, queue, Stop, Force Send, rewind, and turn lifecycle
- Composer, ComposerBar, contenteditable input, slash/context menus, and draft restoration
- CodeMirror editor state, extensions, listeners, measurements, and document synchronization
- xterm creation/disposal, addons, WebGL fallback, fit/resize, and stream subscriptions
- Virtuoso or TanStack Virtual row identity, measurement, scroll restoration, and follow-output behavior
- Tooltip/Menu/Dropdown portals, focus, positioning, and outside-click listeners
- WorkStation shell, replay, diff, and multi-repo state ownership
- Tauri IPC and event subscriptions
- KeyVault forms, validation, secrets, and parent-owned loading/error state

For these surfaces, a lower render count is not sufficient proof. Verify the user-visible lifecycle and authoritative state.
