# Quick setup acceptance cases

## Outcome and ownership

- First-run outcome: choose language and appearance, then enter the product
  without completing an account, organization, workspace, or tutorial wizard.
- The canonical language and appearance settings atoms own each preference;
  quick setup does not create a draft or duplicate source of truth.
- The presentation selector is component-local preview state. It defaults to
  the App-native version on every mount and never writes a product setting.
- Settings owns the terminal `open | completed | dismissed` outcome and the
  secret-free setup progress compatibility object.
- Tools, credentials, workspaces, organizations, team visibility, work items,
  and tutorials remain owned by their existing product surfaces.

## State machine

| State   | User event                     | Visible result                                                              | Persisted effect                                                                        | Next state  |
| ------- | ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------- |
| Editing | Change language                | The hero, settings section, labels, and actions update locale immediately   | Canonical language setting is queued for disk                                           | Editing     |
| Editing | Change appearance/theme/accent | The ambient scene and canonical settings controls preview the selection     | Canonical appearance setting is queued for disk                                         | Editing     |
| Editing | Switch presentation            | App-native, cinematic, and classic forms swap in place with the same values | None; this is local preview state                                                       | Editing     |
| Editing | Get Started                    | Both actions remain visible; the primary action enters loading              | Outcome and compatibility progress persist in one batch after earlier preference writes | Workstation |
| Editing | Skip Setup                     | Both terminal actions remain visible and disabled while the save completes  | Dismissed outcome and unchanged compatibility progress persist in one batch             | Workstation |
| Closing | Repeated finish/skip           | No second operation starts                                                  | No duplicate completion write                                                           | Closing     |
| Closing | Save fails                     | Inline app message reports failure; chosen preferences remain visible       | Outcome is not published as completed/dismissed                                         | Editing     |

## Behavioral matrix

| Case                                         | Expected result                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New install                                  | Quick setup opens automatically with valid defaults; there is no step count, progress bar, or staged navigation.                                                                                       |
| Existing install opens Quick setup           | Current language, theme, and primary color hydrate from canonical Settings values.                                                                                                                     |
| Change language                              | The whole surface updates locale immediately and the preference survives restart.                                                                                                                      |
| Change appearance mode                       | The canonical theme transition runs; the matching theme preset and default accent update consistently.                                                                                                 |
| Change theme preset                          | Theme CSS loads before the canonical theme/accent batch is published.                                                                                                                                  |
| Change primary color                         | The existing primary-color atom applies and persists the selection immediately.                                                                                                                        |
| Switch to cinematic                          | The historical immersive card renders with the same language, appearance, theme, and color bindings.                                                                                                   |
| Switch to classic                            | The branded vertical panel renders full-width controls with the same language, appearance, theme, color, and terminal actions.                                                                         |
| Switch back to App native                    | The canonical Settings form returns without resetting a preference or terminal state.                                                                                                                  |
| Reopen after selecting cinematic             | The selector returns to App native; only actual preference values hydrate from Settings.                                                                                                               |
| Finish immediately after a preference change | The settings write queue orders preference writes before the atomic completion batch.                                                                                                                  |
| Finish twice                                 | The closing ref prevents duplicate completion writes and navigation.                                                                                                                                   |
| Completion write fails                       | The user stays on quick setup and can retry; the terminal outcome does not diverge from progress.                                                                                                      |
| Skip                                         | No preference is reset; the dismissed outcome closes automatic first-run setup.                                                                                                                        |
| Reopen from Settings                         | The localized “Quick setup” menu item opens the same surface with current preferences.                                                                                                                 |
| Hidden test shortcut                         | `⌘⌥O` / `Ctrl+Alt+O` atomically resets setup-owned outcome/progress and opens quick setup without changing product data.                                                                               |
| Optional setup                               | Tools, workspaces, organizations, team visibility, and tutorials remain available later from their existing app surfaces.                                                                              |
| Responsive layout                            | Wide desktop uses the cinematic hero + canonical settings section; constrained widths hide the decorative hero and preserve a compact ORGII brand header above the form.                               |
| UI consistency                               | App native uses unmodified Settings/Wizard components and shared tokens. Cinematic is isolated historical styling; classic composes vertical `SectionRow`s. All share controls, state, and completion. |
| Reduced motion                               | The mascot float animation is disabled when the OS requests reduced motion.                                                                                                                            |
| Accessibility                                | Every select trigger has a localized accessible name; the decorative mascot/planet are hidden from assistive technology and terminal actions retain native buttons.                                    |
| Supported locale                             | Quick-setup copy and the Settings navigation entry exist in all 13 supported locales with matching key/interpolation shape.                                                                            |
| Legacy progress                              | Completing quick setup retains existing optional setup fields and adds the idempotent `preferences` completion marker.                                                                                 |

## Verification

- Unit: `__tests__/preferenceSetup.test.ts`, `__tests__/testShortcut.test.ts`,
  `__tests__/i18n.test.ts`, `SetupWalkthroughSidebar.test.ts`, setup
  navigation/settings tests, and `settingsAtom.atomic.test.ts`.
- Visual: desktop app opened through the hidden shortcut in dark and light
  themes; verify all three dropdown-selectable presentations, shared values, four
  preference rows, constrained-width fallback, no step UI, and stable loading state.
- Static gates: TypeScript typecheck, formatting, focused Vitest coverage, and
  `git diff --check`.
