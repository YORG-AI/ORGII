# Test Cases: GlobalPreferencesPanel

## Preconditions

- The application shell and global shortcuts are mounted.
- No other control owns `Cmd/Ctrl+0`.

## Happy Path

| #   | Steps                                        | Expected Result                                                                                        |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Press `Cmd+0` on macOS or `Ctrl+0` elsewhere | The global preferences panel opens above the current route.                                            |
| 2   | Change Preview layout                        | The setup preview updates immediately when mounted, and the choice survives route changes and reloads. |
| 3   | Press the shortcut again                     | The panel closes.                                                                                      |
| 4   | Press `Alt+Cmd+0` or `Ctrl+Alt+0`            | UI zoom resets without opening the panel.                                                              |

## Edge Cases

| #   | Scenario                            | Steps                               | Expected Result                                                |
| --- | ----------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| 1   | Unsupported persisted preview value | Reload with an invalid stored value | Compact preview is selected.                                   |
| 2   | Rapid repeated interaction          | Press the panel shortcut repeatedly | Open state toggles deterministically without duplicate panels. |
| 3   | Route change                        | Open the panel, then navigate       | The single global panel remains owned by the app shell.        |
| 4   | Combined modifiers                  | Press `Alt+Shift+Cmd/Ctrl+0`        | No zero-chord action runs.                                     |

## Error / Degraded States

| #   | Scenario                             | Steps                          | Expected Result                                     |
| --- | ------------------------------------ | ------------------------------ | --------------------------------------------------- |
| 1   | Stored value is missing or malformed | Clear or corrupt local storage | The panel remains usable and falls back to Compact. |

## Accessibility

- [ ] Keyboard-navigable with Tab and Enter.
- [ ] Escape closes the panel and restores prior focus.
- [ ] The selector has a localized accessible name.
- [ ] Focus remains trapped while the panel is open.

## Acceptance Criteria

- [ ] Setup no longer renders the Preview layout field.
- [ ] The Basic preferences heading uses a background-free line icon.
- [ ] `Cmd/Ctrl+0` toggles one route-independent panel.
- [ ] Preview layout has one shared state owner.
- [ ] Additional sections can be added through the panel section registry.
