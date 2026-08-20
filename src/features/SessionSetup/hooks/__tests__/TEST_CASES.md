# Test Cases: useOAuthCapture (generic hook)

Tests live in `useOAuthCapture.test.ts` and cover the three pure helper functions extracted from the hook.

---

## `isOAuthE2EMockEnabled(flag)`

| #   | Scenario                                                | Expected                             |
| --- | ------------------------------------------------------- | ------------------------------------ |
| 1   | `NODE_ENV === "production"`, flag is `true`             | `false` — production is never mocked |
| 2   | Non-production, flag is absent                          | `false`                              |
| 3   | Non-production, flag is `false`                         | `false`                              |
| 4   | Non-production, flag is `true`                          | `true`                               |
| 5   | Non-production, flag is a truthy non-boolean (e.g. `1`) | `false` — strict `=== true` check    |

---

## `shouldNavigateInWebview(url, allowedDomains)`

| #   | Scenario                                                                    | Expected                                  |
| --- | --------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | URL hostname exactly matches an allowed domain                              | `true`                                    |
| 2   | URL hostname is a subdomain of an allowed domain                            | `true`                                    |
| 3   | URL hostname is a prefix-match but not a subdomain (e.g. `evil-google.com`) | `false` — guards against prefix hijacking |
| 4   | URL hostname is completely unlisted                                         | `false`                                   |
| 5   | Malformed (non-parseable) URL                                               | `false`                                   |
| 6   | Empty string                                                                | `false`                                   |

---

## `parseOAuthCallback(currentUrl, callbackOrigin, callbackPath)`

| #   | Scenario                                           | Expected                                                         |
| --- | -------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `currentUrl` is an empty string                    | `null`                                                           |
| 2   | `currentUrl` is a malformed URL                    | `null`                                                           |
| 3   | Origin doesn't match                               | `null`                                                           |
| 4   | Pathname doesn't match                             | `null`                                                           |
| 5   | Successful callback: `code` + `state` present      | `{ code, state, oauthError: null, oauthErrorDescription: null }` |
| 6   | Error callback: `error` + `error_description`      | `{ code: null, state: null, oauthError, oauthErrorDescription }` |
| 7   | Partial callback: only `code`, no `state`          | `{ code, state: null, ... }`                                     |
| 8   | Port mismatch in origin                            | `null`                                                           |
| 9   | HTTPS origin (ClaudeCode style) with matching path | Full parsed result                                               |

---

## Integration scope (not in this file)

The following behaviour is covered by higher-level integration / E2E tests and is **not** duplicated here:

- Full React hook lifecycle (`startLogin` → webview open → URL change → code exchange → `onTokenCaptured` callback)
- Provider-specific wrappers (`useGeminiOAuthCapture`, `useCodexOAuthCapture`, `useClaudeCodeOAuthCapture`) forwarding the correct extra response fields (`projectId`, `idToken`, etc.)
- E2E mock mode setting auth URL without opening a real webview
- Cancellation guard (`cancelled` flag) when the effect re-runs before the exchange resolves
- `closeWebviewOnExchangeError` / `setSigningInBeforeExchange` timing flags
