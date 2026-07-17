# AppUpdater

**Location:** `src/scaffold/AppUpdater/`
**Last updated:** July 13, 2026

## Overview

`AppUpdater` is the headless Tauri update service mounted by
`AppDeferredServices`. It uses one coordinator for check, download, and install
state, and one scheduler for automatic triggers.

Automatic updates are controlled by `general.autoUpdateEnabled` in
`~/.orgii/settings.jsonc`. The setting defaults to `true` and can be disabled in
Settings → General.

## Automatic behavior

- **Startup:** after a 10-second delay, check for a fresh release. If one is
  available, download it and ask before installing or relaunching ORGII.
- **While running:** check every two hours, when the app returns to the
  foreground, and when network connectivity returns.
- **Foreground event deduplication:** focus and visibility events share one
  750 ms debounce path; checks also have a five-minute throttle.
- **Silent preparation:** download an available package in the background
  without showing progress toasts or forcing a restart, then show one
  confirmation dialog. Installation only starts after the user confirms.
- **Dialog actions:** users can skip the detected version, postpone the
  decision while keeping the package ready, or install and restart. Skipped
  versions remain suppressed across app launches.
- **Disabled:** no startup, interval, foreground, or online checks are
  registered. Manual checks and installs remain available.
- **Enabled during an active session:** starts with a silent foreground check
  and uses the same confirmation-gated install path as every other trigger.

Installing is never automatic because the Tauri updater installer can
terminate the running process on Windows. Users can postpone installation and
save ongoing work before confirming the restart.

## Public API

```ts
checkForAppUpdates({ notify?: boolean, force?: boolean }): Promise<Update | null>
checkForUpdatesManually(): Promise<Update | null>
installAvailableAppUpdate(): Promise<void>
useAvailableAppUpdate(): Update | null
useIsAppUpdateInstalling(): boolean
```

- `notify` shows toast feedback for the caller.
- `force` bypasses the five-minute result throttle, but never starts a second
  concurrent check.
- Manual check failures clear a stale available-update result. Silent failures
  preserve the last successful result while marking the coordinator failed.
- Download requests prepare the package and open the install confirmation.
- Concurrent confirmed install requests share one install; only the owning
  request may continue to relaunch.

## State model

```text
idle → checking → up-to-date | available | failed
available → downloading → downloaded
available | downloaded → installing → relaunching
```

`appUpdaterCoordinator.ts` owns this lifecycle. Jotai atoms in `index.tsx` are
read-only UI projections and are not independent sources of truth.

## Entry points

- Automatic scheduling: `AppDeferredServices` → `AppUpdater`
- Manual check: Settings, Global Spotlight, ActionSystem
- Manual install: sidebar update button and ChatPanel update action

## Dependencies

- `@tauri-apps/api/app` for the current version
- `@tauri-apps/plugin-updater` for check/download/install
- `@tauri-apps/plugin-process` for relaunch
- central settings registry and `settings.jsonc` persistence
