# Test Cases: Drag-File-to-Chat-Input Fix (Issue #250)

## Preconditions

- The chat panel is visible with a session active
- The input composer is mounted and ready
- A file is available for drag-and-drop from the OS (Finder, Explorer, etc.)

## Happy Path

| #   | Steps                                                                  | Expected Result                                                                                                                |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Drag a `.ts` file from Finder onto the chat input area and release     | A file pill (`@filename.ts`) is inserted into the composer. No conversation round is created.                                  |
| 2   | Drag a `.txt` file onto the input, then type a message and press Enter | The file pill appears in the input; after Enter, a new round is created containing both the file reference and the typed text. |
| 3   | Drag multiple files onto the input sequentially                        | Each file gets its own pill inserted. No empty round is created between drops.                                                 |

## Edge Cases

| #   | Scenario                                 | Steps                                                                | Expected Result                                                                           |
| --- | ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Drop on empty input                      | Drag file to input with no existing text                             | Pill inserted, `isInputEmpty()` reflects the pill, no submit triggered                    |
| 2   | Drop on input with existing text         | Type "Hello", then drag a file                                       | Pill appended after existing text; no submit triggered                                    |
| 3   | Drop image file                          | Drag a `.png` file onto the input                                    | Image attachment preview appears; no round created                                        |
| 4   | Drop then press Enter                    | Drag file, then immediately press Enter (with `sendOnEnter` enabled) | New round created containing only the file pill (as expected user action, not accidental) |
| 5   | Drop reference drag (internal file-tree) | Drag a file from the file tree panel onto the input                  | File pill inserted via `useDragDrop.handleDrop` (internal path); no extra text inserted   |
| 6   | Drop on unfocused input                  | Drag file when cursor is not in input                                | Pill is still inserted; no round created                                                  |
| 7   | Rapid file drops                         | Drop 3 files quickly in succession                                   | 3 pills inserted; 0 empty rounds created                                                  |

## Error / Degraded States

| #   | Scenario                         | Steps                               | Expected Result                                                      |
| --- | -------------------------------- | ----------------------------------- | -------------------------------------------------------------------- | --- | --------------------------------------------------------- |
| 1   | composerInputRef not yet mounted | Drop fires before editor is ready   | Drop retried via `setTimeout` in `useDroppedFilesConsumer`; no crash |
| 2   | File path invalid                | Tauri drop event with empty `paths` | `if (!paths                                                          |     | paths.length === 0) return;` guard fires; no action taken |

## Accessibility

- [ ] File drop does not steal keyboard focus (no unintended `focus()` call)
- [ ] Screen reader: no spurious empty message announced after drop

## Acceptance Criteria

- [ ] Dragging an OS file to the chat input inserts a file pill without creating a new empty conversation round
- [ ] `event.preventDefault()` is always called in `handleDropEvent` on the contenteditable host
- [ ] `event.preventDefault()` + `event.stopPropagation()` are always called in `handleContainerDrop`
- [ ] Internal file-tree drags still work (pill inserted via `handleDrop`)
- [ ] Reference drags still work (pill inserted via `createDropHandler`)
- [ ] `pnpm test` passes with no new failures
- [ ] No TypeScript errors
