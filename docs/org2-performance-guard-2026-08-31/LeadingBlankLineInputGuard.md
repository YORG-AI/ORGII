# Leading blank line input guard

The user requested a shared input rule: a line break must not leave the first
line blank, including while editing a sent message. Native textareas previously
accepted browser line breaks unconditionally; the rich composer's
`useEditorOperations.insertNewline` also always inserted one. Edit initialization
passed historical leading blank lines directly into the composer.

The rule now runs before newline insertion. The text before the selection must
have content on its first line, so moving to the start of existing text or
selecting the first line cannot introduce a leading blank line. Later blank
lines, indentation, submit shortcuts, and composition remain supported. Edit
initialization strips leading blank lines from the editable copy. No stored
message or imported transcript is rewritten.

| Area               | Verdict | Evidence                                                                                                                        | Change or reason kept                                                                                                                             | Verification                                                                                                                                                 |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background work    | keep    | `installLeadingBlankLineGuard.ts` adds one delegated `beforeinput` listener; `src/index.tsx` owns installation and HMR disposal | No timer, polling, request, worker, or per-field listener added                                                                                   | Repeated installation shares one listener; dispose/reinstall and stale-disposer tests pass; fake-time visible/hidden idle produces no policy calls or timers |
| Memory             | keep    | One disposer is retained; textarea string slices and composer prefix fragments are temporary                                    | No per-session or per-field registry; the composer reads pill labels without serializing or base64-encoding stored context                        | Native listener lifecycle tests; real composer tests with a pill and repeated line breaks                                                                    |
| Scope/isolation    | keep    | Policy reads only the current event target/selection                                                                            | Native readonly/disabled fields and CodeMirror/Monaco/xterm inputs are excluded; no account, org, session, network, or storage state is consulted | Native-field exclusion and selection tests                                                                                                                   |
| Rendering/hot path | keep    | Ordinary input exits before reading the textarea value; composer checks run only for newline attempts                           | Blocked composer operations return before DOM mutation and do not notify the parent; native line breaks retain undo transactions                  | Composer tests cover Enter modes, selections, pills, IME, native `beforeinput`, noncancelable events, undo, and edit initialization                          |

| Lifecycle                                 | Expected behavior                                                               | Evidence                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| App start / repeated install              | One native-textarea listener per app document                                   | Idempotent installation test                                                                                            |
| Visible / hidden idle                     | No scheduled work                                                               | Two 60-second fake-time intervals; zero timers and policy calls                                                         |
| Active input                              | Evaluate only attempted line breaks; preserve submit and IME handling           | Native textarea and mounted ComposerInput tests                                                                         |
| HMR / shutdown                            | Dispose on HMR; document destruction releases app-lifetime listener             | Disposal/reinstallation tests; webpack runtime `dispose` API verified locally and declared in the existing ambient type |
| Composer close / reopen                   | Existing native-event effect owns listener teardown; no new listener kind added | Existing effect cleanup retained; mounted component tests unmount between cases                                         |
| Identity / network / provider transitions | Not applicable                                                                  | No identity, network, provider, or persistence operations added                                                         |

Verification performed:

```sh
pnpm exec vitest run src/hooks/keyboard/__tests__ src/components/ComposerInput/__tests__ src/engines/ChatPanel/InputArea/hooks/__tests__/useEditMode.test.ts src/engines/ChatPanel/hooks/useInputArea/__tests__ src/engines/ChatPanel/ChatItems/__tests__/normalizeUserMessageText.test.ts src/engines/ChatPanel/ChatHistory/hooks/__tests__/useEditUserMessage.test.ts src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/inputPreparation.test.ts src/store/ui/__tests__/messageQueueAtom.test.ts
pnpm exec eslint src/util/data/canInsertLineBreak.ts src/hooks/keyboard/installLeadingBlankLineGuard.ts src/hooks/keyboard/__tests__/installLeadingBlankLineGuard.test.ts src/components/ComposerInput/index.tsx src/components/ComposerInput/useEditorOperations.ts src/components/ComposerInput/composerInput.nativeEvents.ts src/components/ComposerInput/__tests__/ComposerInput.lineBreak.test.ts src/engines/ChatPanel/InputArea/hooks/useEditMode.ts src/engines/ChatPanel/InputArea/hooks/__tests__/useEditMode.test.ts src/index.tsx src/types/ambient/global.d.ts --max-warnings 0
pnpm run check:test-placement
git diff --check
```

The initial focused run passed all 254 tests in 30 files. Before PR publication,
validation was repeated in a clean worktree based on the latest `origin/develop`:
377 tests in 48 files, scoped ESLint, full `pnpm run typecheck`, test placement,
and diff checks all pass. The unrelated pending-workspace type errors are not
present in the isolated PR branch.

The behavioral tests use jsdom and do not establish actual WKWebView keyboard,
soft-keyboard, IME timing, caret rendering, CPU, or RSS behavior. Native desktop
verification was not run because Computer Use is explicit opt-in. Noncancelable
browser input is left to the browser rather than duplicated by a custom DOM
insertion. Paste and deletion are not intercepted by this newline-only rule;
the existing send-time normalization remains in place.

Performance verdict: blocked — automated lifecycle checks pass, but native
Tauri input/performance verification was not run. No runtime performance
improvement is claimed.
