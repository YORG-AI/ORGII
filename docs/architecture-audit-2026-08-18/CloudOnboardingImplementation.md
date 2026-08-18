# Cloud Onboarding Implementation Review

**Date:** 2026-08-18  
**Scope:** Desktop renderer Cloud onboarding and contextual signed-out boundary

## Outcome

`CloudOnboardingGate` is the single renderer owner for the first-run Cloud introduction and returning-user login Block. It is mounted only inside an actively visited Cloud surface; the app shell, local projects, terminal, and local Agent flows remain available without authentication.

The only durable value is the numeric acknowledgement at `orgii:org2-cloud-v1:onboarding-version`. Identity, endpoint, email, token, invite, share payload, and Sign-in Intent remain outside this preference.

## End-to-end data path

1. A signed-out Cloud surface renders `CloudOnboardingGate` with its own `onConnect` Sign-in Intent.
2. The gate reads the version through the shared `usePersistedState` owner and a narrow Boolean projection of the Broker flow.
3. Settings and Team Runtime show the full introduction when the version is old or absent. Create Org, invite, and share intents show the compact contextual Block first.
4. “Continue locally” records the version only after the full introduction was displayed. A contextual “Back to local” closes the intent without acknowledging an unseen introduction.
5. “Connect” records the version, prevents duplicate starts, calls the existing system-browser sign-in entry, and retains the caller's Sign-in Intent.
6. Browser-open failure stays in the compact Block with an alert and retry. A Broker flow keeps the action in a visible loading state until its public phase exits.
7. Same-tab subscribers and browser `storage` events converge other mounted gates to the acknowledged version.

## Renderer state machine

| State              | Entry condition                                | User actions                           | Durable effect                            | Exit                                   |
| ------------------ | ---------------------------------------------- | -------------------------------------- | ----------------------------------------- | -------------------------------------- |
| First introduction | Version absent/old, non-contextual Cloud entry | Continue locally, connect              | Current version on either explicit action | Compact Block or sign-in               |
| Contextual Block   | Signed out business intent                     | Back, learn more, login                | None on Back; version on login            | Caller closes, details, or sign-in     |
| Returning Block    | Current version acknowledged                   | Back when available, learn more, login | None                                      | Caller closes, details, or sign-in     |
| Details            | User explicitly expands the Block              | Continue locally, connect              | Current version                           | Compact Block/caller closes or sign-in |
| Opening browser    | Connect accepted                               | No duplicate connect                   | Version already written                   | Broker wait, compact Block, or failure |
| Failed             | Browser entry returns failure                  | Retry, local exit, learn more          | Version retained                          | Opening browser or local exit          |

## Edge-case matrix

| Case                                 | Invariant                                       | Coverage                                    |
| ------------------------------------ | ----------------------------------------------- | ------------------------------------------- |
| Merely render then close             | Does not acknowledge                            | Component test                              |
| Continue locally                     | No sign-in call; stores only integer version    | Component test                              |
| Current/newer version                | Skips full introduction                         | Preference + component tests                |
| Old/malformed version                | Replays introduction safely                     | Preference test                             |
| Contextual invite/share/create entry | Starts compact; Back does not acknowledge       | Component test + integration paths          |
| Rapid double click                   | Starts one browser flow                         | Component test                              |
| Browser-open failure                 | Alert remains and retry is possible             | Component test                              |
| Other window acknowledges            | Mounted gate converges through `storage` event  | Component test                              |
| Signed-in identity                   | Parent renders account/session UI, not the gate | Existing parent control flow + typecheck    |
| Version bump while signed in         | Does not alter session or sign out              | Preference boundary; no identity write path |

## Architecture audit

| Layer                    | Verdict        | Evidence                                                                            |
| ------------------------ | -------------- | ----------------------------------------------------------------------------------- |
| L1 compilation/contracts | Pass           | TypeScript typecheck, ESLint, i18n parity, targeted tests                           |
| L2 ownership/duplication | Pass           | One gate, one preference module, five reused production entries                     |
| L3 naming                | Pass           | Onboarding acknowledgement, Broker flow, and identity session remain distinct terms |
| L4 semantic overloading  | Pass           | A numeric preference cannot represent authentication or authorization               |
| L5 control flow          | Pass           | First, contextual, pending, and failed branches are explicit and tested             |
| L6 module boundaries     | Pass           | Non-sensitive renderer preference is isolated from Broker-owned credentials         |
| L7 readability           | Pass           | Value list, acknowledgement, connect lock, and local exit each have one owner       |
| L8 wire protocol         | Not applicable | No IPC, OAuth, API, or persistence-schema wire shape changed                        |
| L9 initialization parity | Pass           | Settings, Create Org, invite, share import, and Team Runtime use the same gate      |
| L10 resolver symmetry    | Not applicable | No resolver or discriminated data union changed                                     |

## Performance guard

| Area               | Verdict | Evidence                                                                                                | Change or reason kept                                                                      | Verification                                            |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Background work    | keep    | One existing global `storage` event listener; no timer, polling, retry loop, network request, or worker | Push-driven invalidation has zero periodic idle work                                       | Source trace + cross-window event test                  |
| Memory             | keep    | Subscriber Set is per key and removes the key when the last component unmounts                          | Retained count is bounded by mounted gates; one fixed app-lifetime DOM listener            | Source cleanup trace + component unmounts in every test |
| Scope/isolation    | keep    | Stored value is one global product-introduction version                                                 | Deliberately independent of account/endpoint; no credential or intent payload              | Preference tests + identity secret-boundary check       |
| Rendering/hot path | keep    | Gate subscribes to a derived ORG2-Cloud-flow Boolean and one storage key                                | Unrelated identity details do not rerender the gate; writes occur only on explicit actions | Targeted component tests                                |

Lifecycle verdict: app start/idle/hidden creates no recurring work; active mounts subscribe push-only; unmount removes per-component subscription; offline, account switch, endpoint switch, org removal, session deletion, and secondary instances do not retain identity-scoped data because the preference contains no identity data.

**Performance verdict: pass.**

## Remaining risks

- Production Broker OAuth remains operationally blocked while `/api/auth/desktop/config` returns `503 ORG2_DESKTOP_OAUTH_UNAVAILABLE`; this does not block local use or the onboarding UI.
- The compatibility login path has no Broker `awaiting_callback` snapshot, so its loading state covers browser opening rather than the entire browser round trip.
- Actual Tauri screenshots for light/dark theme, keyboard order, and the narrowest supported window remain manual acceptance items; the interaction sketch and DOM regression suite are complete.
