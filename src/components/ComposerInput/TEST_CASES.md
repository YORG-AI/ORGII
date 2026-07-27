# Test Cases: ComposerInput

## Preconditions

- The `ComposerInput` is mounted inside a React tree with Jotai provider and i18n context.
- The editor host is focusable and `editable` prop is `true`.
- At least one `ComposerPillAttrs` factory is available (file, terminal, skill, etc.).
- Clipboard API is accessible (or mocked).

## Happy Path

| #   | Steps                                                                        | Expected Result                                                                                          |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Focus editor. Type "hello world".                                            | Text appears at caret; `onChange` fires with serialized content.                                         |
| 2   | Call `insertPill({ kind: "file", path: "/src/foo.ts" })` via ref.            | A pill span appears at the caret with the file display name.                                             |
| 3   | Type text before and after a pill.                                           | Text and pill coexist; plain-text extraction includes pill display name inline.                          |
| 4   | Press Backspace immediately after a pill.                                    | Pill is removed in one keystroke.                                                                        |
| 5   | Press Delete immediately before a pill.                                      | Pill is removed in one keystroke.                                                                        |
| 6   | Select text + pill, press Cmd+X.                                             | Selection is removed; clipboard receives plain-text and `application/x-orgii-composer-fragment` payload. |
| 7   | Press Cmd+V after cut from step 6.                                           | Full content (text + pill with metadata) is restored at caret.                                           |
| 8   | Paste a standalone valid `http://` or `https://` URL.                        | A highlighted link pill is inserted; GitHub repo/issue/PR URLs retain their specialized pill style.      |
| 9   | Paste `application/x-orgii-file-reference` MIME.                             | A file-reference pill is inserted; plain-text paste is suppressed.                                       |
| 10  | Paste an image file.                                                         | `onImagePaste` callback is invoked; text paste is suppressed.                                            |
| 11  | Paste `application/x-orgii-composer-fragment` JSON.                          | Pills and text are re-inserted with original attributes.                                                 |
| 12  | Paste a skill path with matching frontmatter.                                | A skill pill is inserted.                                                                                |
| 13  | Paste from terminal clipboard (`__orgiiLastTerminalCopy` within age window). | A terminal pill is inserted.                                                                             |
| 14  | Call `clearAll()` via ref.                                                   | Editor content is cleared; `onChange` fires with empty state.                                            |
| 15  | Call `focus()` via ref.                                                      | Editor receives focus.                                                                                   |

## Edge Cases

| #   | Scenario                                         | Steps                                                                | Expected Result                                             |
| --- | ------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Empty editor cut                                 | No selection; press Cmd+X.                                           | No content removed; clipboard unchanged.                    |
| 2   | Paste plain text into non-empty editor           | Type "abc", paste "xyz".                                             | "abcxyz" at caret; no pill created.                         |
| 3   | Multiple pills selected                          | Select range spanning 2+ pills; press Cmd+X.                         | All pills removed; clipboard fragment contains all.         |
| 4   | Pill at selection boundary (start)               | Selection starts just before pill; extend right; cut.                | Pill and text after cut; preceding text preserved.          |
| 5   | Pill at selection boundary (end)                 | Selection ends just after pill; cut.                                 | Text before pill and pill are cut.                          |
| 6   | IME composition mid-paste                        | Begin CJK input; paste; complete composition.                        | Composition committed first; paste inserts at caret.        |
| 7   | Max-length pill text                             | Insert pill whose display name exceeds `capPillText` limit.          | Display name is capped; metadata unchanged.                 |
| 8   | Rapid keystroke sequence                         | Type, insert pill, type, backspace × 20 rapidly.                     | Editor state remains consistent; no orphaned DOM spans.     |
| 9   | Paste HTML from external app                     | Copy rich HTML from browser; paste.                                  | Only sanitized plain text inserted; no `<b>`, `<a>`, etc.   |
| 10  | Paste JSON string                                | Paste `{"key":"value"}`.                                             | Treated as plain text; no pill auto-created.                |
| 11  | Paste image via drag-and-drop                    | Drag an image file onto editor.                                      | `onImagePaste` called; text unchanged.                      |
| 12  | Paste PR reference via drag (WKWebView fallback) | Drag PR row onto editor; `dataTransfer` MIME stripped by WKWebView.  | Falls back to `window.__orgiiLastPrDrag`; PR pill inserted. |
| 13  | Terminal clipboard expired                       | `__orgiiLastTerminalCopy` older than `TERMINAL_COPY_MAX_AGE`; paste. | Falls through to plain-text paste; no terminal pill.        |
| 14  | Composer fragment malformed JSON                 | Manually set MIME to invalid JSON; paste.                            | Falls through to plain-text; no JS error.                   |
| 15  | `editable={false}`                               | Render with `editable={false}`; try Cmd+X, paste.                    | Browser blocks input; no state mutation.                    |
| 16  | Paste prose containing a URL                     | Paste `see https://example.com next`.                                | Entire payload stays plain text; no partial link pill.      |
| 17  | Paste unsupported or grammar-breaking URL        | Paste `ftp://…`, a credential URL, or a URL containing `[` / `]`.    | Payload stays plain text; no link pill is created.          |

## Error / Degraded States

| #   | Scenario                          | Steps                                                           | Expected Result                                       |
| --- | --------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | Clipboard API unavailable         | Block `ClipboardEvent.clipboardData` in dev tools. Press Cmd+X. | Handler exits silently; browser default; no JS error. |
| 2   | `onImagePaste` not provided       | Paste image without `onImagePaste` prop.                        | Image paste suppressed; no error thrown.              |
| 3   | `insertPill` called after unmount | Call `ref.insertPill(...)` after component unmounts.            | No crash; ref is cleared.                             |
| 4   | Very large paste payload          | Paste 100 KB of plain text.                                     | Inserted without UI freeze; `onChange` fires once.    |

## Accessibility

- [ ] Keyboard-navigable (Tab moves focus in/out; Enter/Backspace/Delete handled)
- [ ] Screen reader label present (`aria-label` or `aria-labelledby` on host)
- [ ] Focus trap not applicable (inline editor, not a modal)
- [ ] Pills have `aria-label` with display name for screen readers

## Acceptance Criteria

- [ ] Typing plain text updates editor content and fires `onChange`
- [ ] Inserting a pill places it at the caret and fires `onChange`
- [ ] Backspace/Delete removes the adjacent pill in one keystroke
- [ ] Cut (Cmd+X / Ctrl+X) removes selection and writes both plain-text and fragment MIME to clipboard
- [ ] Pasting a fragment restores pills with original metadata
- [ ] Pasting an image calls `onImagePaste`; plain paste is suppressed
- [ ] Pasting plain text sanitizes HTML artifacts
- [ ] `clearAll()` empties the editor and fires `onChange`
- [ ] `pnpm test` passes with no new failures
- [ ] No TypeScript errors (`pnpm typecheck`)
