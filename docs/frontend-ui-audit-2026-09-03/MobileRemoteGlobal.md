# Mobile Remote global UI audit

Date: 2026-09-03. Scope: all `*.tsx` under `src/modules/MobileRemote/` (34 files), compared with Desktop patterns in MainApp Settings, ChatPanel, and shared layout primitives. Source inspection only; no application code changed.

## Executive summary

| Category                | Estimate | Notes                                                                                                                                                                                                                          |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fully reused**        | ~82%     | DS `Button`, `IconButton`, `Textarea`, `BottomSheet`, `Placeholder`, `InlineAlert`/`InlineBanner`, `SectionContainer`/`SectionRow`, composer stack, chat bubbles, `TurnNavigationToolbar`, dropdown tokens, session-row tokens |
| **Partially reused**    | ~12%     | Correct DS primitives with local layout overrides (`MobileTabBar` inline `style`, `StopConfirmModal` danger color override, `SessionsScreen` bespoke header)                                                                   |
| **Custom (justified)**  | ~6%      | Semantic native `<button>` rows using shared tokens (`SessionListItem`, `MobileToolCall`, `MobileModelListDropdown`); mobile-only shell/safe-area (`MobileShell`)                                                              |
| **Custom (should fix)** | 3 sites  | See fix candidates below                                                                                                                                                                                                       |

**Icon system:** 100% Hugeicons via `@src/icons`. Zero Lucide imports, zero inline `<svg>` in the module.

**IconButton specifically:** Both mobile icon-only toolbar actions use the shared `IconButton` primitive correctly. No custom icon-button wrappers were found. Desktop header clusters prefer `TabBarTrailingIconButton` (workstation chrome); Mobile Remote correctly uses the cross-surface `IconButton` in `MobileTopBar` — matching the component's documented intent (`ChatPanel`, `WorkStation`, shared surfaces).

Prior audits (`MobileRemoteSettingsAndDevices`, `MobileRemoteSessionList`, `MobileRemoteAuthentication`) remain accurate; this pass adds module-wide coverage and IconButton focus.

---

## IconButton deep-dive

| Line                                                                    | Element                                 | Verdict          | Reason                                                                                                                                                                                                                                            | Suggested change                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/modules/MobileRemote/components/MobileTopBar.tsx:25`               | Back control                            | keep with reason | Uses DS `IconButton` (`size="sm"`, `variant="default"`) with Hugeicons `ArrowLeft01Icon`, `aria-label`, and semantic `<header>` parent. This is the canonical mobile top-bar icon action.                                                         | None.                                                                             |
| `src/modules/MobileRemote/screens/SessionChatScreen.tsx:151`            | Stop-session trailing action            | keep with reason | Uses DS `IconButton` (`variant="danger"`) slotted into `MobileTopBar.trailing`. Disabled state respects connection/write capability. Matches Desktop destructive icon-button semantics without pulling in workstation `TabBarTrailingIconButton`. | None.                                                                             |
| `src/components/TurnNavigationToolbar/TurnNavigationToolbar.tsx:164`    | Round prev/next/latest (mobile variant) | keep with reason | Shared DS toolbar used by `RoundNavigator`; compact controls are DS `Button` ghost icons, not `IconButton`. Same implementation serves Desktop ChatHistory — not a Mobile-only divergence.                                                        | None unless a future toolbar pass unifies compact nav onto `IconButton` app-wide. |
| `src/modules/MobileRemote/components/MobileTabBar.tsx:54`               | Bottom tab items                        | keep with reason | Tab navigation correctly uses DS `Button` (tertiary/ghost) with Hugeicons — not icon-only controls. `IconButton` would be the wrong primitive for labeled tab items.                                                                              | None.                                                                             |
| `src/modules/MobileRemote/components/transcript/MobileToolCall.tsx:416` | Tool-call detail trigger                | keep with reason | Full-width semantic `<button>` wrapping an `EventBlockHeader` row — dialog trigger pattern, not an icon button. Reuses Desktop chat block primitives and `SESSION_UI_TOKENS`.                                                                     | None.                                                                             |
| `src/modules/MobileRemote/components/transcript/MobileToolCall.tsx:584` | File-target row selector                | keep with reason | Native `<button>` for selectable list row inside a custom card layout; adjacent open action uses DS `Button`. Keyboard semantics (`aria-pressed`) are correct.                                                                                    | None.                                                                             |
| `src/modules/MobileRemote/components/SessionListItem.tsx:25`            | Session list row                        | keep with reason | Native `<button>` with `SESSION_ROW_PRESENTATION` tokens and `SessionRowLeadingIcon` — same seam as Desktop `NavigationMenuRow`. Not an icon-button concern.                                                                                      | None.                                                                             |

**IconButton verdict subtotal:** **0 fix**, **7 keep with reason**, **0 abstract**.

---

## D1 — Raw HTML vs design system

| Line                                                                     | Element                  | Verdict          | Reason                                                                                                                                                                                                                         | Suggested change                                                                                     |
| ------------------------------------------------------------------------ | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `src/modules/MobileRemote/components/MobileTabBar.tsx:54`                | Bottom tab bar           | keep with reason | DS `Button` + Hugeicons; safe-area padding on `<nav>`. Touch-first labeled tabs, not duplicated Desktop tab chrome.                                                                                                            | None.                                                                                                |
| `src/modules/MobileRemote/components/composer/MobileComposer.tsx:4`      | Composer dock            | keep with reason | Full composer stack reuse: `ComposerShell`, `ComposerBarLayout`, `ComposerSubmitButton`, `Textarea`, `VoiceInputButton`, shared gutter tokens.                                                                                 | None.                                                                                                |
| `src/modules/MobileRemote/components/composer/MobileModelPicker.tsx:153` | Model selector           | keep with reason | Reuses `ModelSelectorPill`, `SelectorPill`, `ModelIcon`; mobile-only `MobileModelListDropdown` for touch overlay positioning.                                                                                                  | None.                                                                                                |
| `src/modules/MobileRemote/components/transcript/RoundNavigator.tsx:77`   | Round navigation         | keep with reason | Reuses shared `TurnNavigationToolbar` (`variant="mobile"`) and `BottomSheet` + `TurnNavigationRoundList`. Desktop parity by design.                                                                                            | None.                                                                                                |
| `src/modules/MobileRemote/screens/settings/SettingsTab.tsx:113`          | Settings sections        | keep with reason | `SectionContainer`, `SectionRow`, DS `Button` action rows — matches MainApp Settings row contract (`MobileRemoteSettingsSection` on Desktop).                                                                                  | None.                                                                                                |
| `src/modules/MobileRemote/screens/devices/DevicesTab.tsx:78`             | Devices sections         | keep with reason | Same `SectionContainer`/`SectionRow`/`StatusDot` pattern as Settings; empty state on DS `Placeholder`.                                                                                                                         | None.                                                                                                |
| `src/modules/MobileRemote/screens/SessionsScreen.tsx:21`                 | Sessions tab header      | fix candidate    | Reimplements `MobileTopBar` geometry (`h-12`, `border-b`, `px-3`) as a raw `<header>` instead of composing `MobileTopBar` with `leading={<DesktopPresenceLabel />}`. Devices/Settings/Chat screens already use `MobileTopBar`. | Replace bespoke header with `MobileTopBar leading={…}` for one chrome owner.                         |
| `src/modules/MobileRemote/screens/QRScanScreen.tsx:55`                   | Pairing validation error | fix candidate    | Raw `<p role="alert" className="text-danger-6">` while `MobileAuthScreen` uses DS `InlineAlert` for the same alert semantics.                                                                                                  | Use `InlineAlert type="danger"` for validation errors.                                               |
| `src/modules/MobileRemote/components/modals/StopConfirmModal.tsx:47`     | Destructive confirm CTA  | fix candidate    | DS `Button` with `className="!bg-danger-6 hover:!bg-danger-5"` override. `Button` already exposes `variant="danger"`.                                                                                                          | Use `variant="danger"` (and `appearance="solid"` if needed) instead of `!important` color overrides. |
| `src/modules/MobileRemote/auth/MobileAuthScreen.tsx:39`                  | Brand mark               | watch            | Literal `●` character for ORG2 branding instead of a shared logo/mark component. One-off gate screen; not yet a repeated pattern.                                                                                              | Confirm with design whether a shared brand primitive exists before changing.                         |

## D2 — Arbitrary Tailwind value vs token

| Line                                                                           | Element                    | Verdict          | Reason                                                                                                                                                                   | Suggested change                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/modules/MobileRemote/components/MobileShell.tsx:13`                       | Safe-area / viewport shell | keep with reason | `pt-[env(safe-area-inset-top)]`, `max-w-[393px]` are documented mobile PWA baseline constraints; cannot be expressed as static theme tokens.                             | None.                                                                                            |
| `src/modules/MobileRemote/components/MobileTabBar.tsx:48`                      | Tab bar safe-area          | keep with reason | `pb-[max(8px,env(safe-area-inset-bottom))]` is standard iOS home-indicator adaptation.                                                                                   | None.                                                                                            |
| `src/modules/MobileRemote/components/MobileComposer.tsx:123`                   | Composer bottom inset      | keep with reason | Combines shared `COMPOSER_*` tokens with `env(safe-area-inset-bottom)` — bridge-layer pattern.                                                                           | None.                                                                                            |
| `src/modules/MobileRemote/components/MobileTabBar.tsx:62`                      | Tab button sizing          | fix candidate    | Inline `style={{ height: "auto", minHeight: 49, padding: "6px 4px" }}` on DS `Button` bypasses `BUTTON_SIZE` tokens; `min-h-[49px]` is already in `className`.           | Drop redundant inline `style`; consolidate touch target height into one token/class on `Button`. |
| `src/modules/MobileRemote/components/composer/MobileModelListDropdown.tsx:189` | Dropdown item typography   | watch            | `text-[13px]` / `text-[12px]` alongside `DROPDOWN_CLASSES` — matches Desktop dropdown item sizing but uses literals instead of `DROPDOWN_ITEM` text tokens if available. | Align with `DROPDOWN_ITEM` typography tokens in a dropdown sweep, not Mobile-only.               |
| `src/modules/MobileRemote/components/modals/StopConfirmModal.tsx:59`           | Modal body copy            | watch            | `text-[13px]` on body text inside `BottomSheet`. Single site; low priority.                                                                                              | Use shared small-body token if one exists for sheet content.                                     |

## D3 — Hardcoded sizes / colors

| Line                                                                 | Element                     | Verdict       | Reason                                                                                                                                        | Suggested change                                                             |
| -------------------------------------------------------------------- | --------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/modules/MobileRemote/screens/devices/DevicesTab.tsx:42`         | Presence dot color resolver | watch         | `resolveDotColor` duplicated identically in `DesktopPresenceLabel.tsx:12`. Two sites — below abstract threshold but same logic.               | Extract shared `resolveDesktopPresenceDotColor` if a third consumer appears. |
| `src/modules/MobileRemote/components/modals/StopConfirmModal.tsx:52` | Danger button colors        | fix candidate | Hardcoded danger overrides via `!bg-danger-6` — counted again here because it bypasses `Button` variant theming and breaks hover token chain. | Same as D1: `variant="danger"`.                                              |

## D4 — Accessibility basics

| Line                                                                           | Element             | Verdict          | Reason                                                                                                           | Suggested change   |
| ------------------------------------------------------------------------------ | ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------ |
| `src/modules/MobileRemote/components/MobileTopBar.tsx:25`                      | Back `IconButton`   | keep with reason | `aria-label`, `type="button"`, focus ring via DS `IconButton`.                                                   | None.              |
| `src/modules/MobileRemote/components/transcript/MobileToolCall.tsx:416`        | Tool detail trigger | keep with reason | Native `<button>` with `aria-haspopup="dialog"`, `aria-expanded`, focus ring.                                    | None.              |
| `src/modules/MobileRemote/components/composer/MobileModelListDropdown.tsx:168` | Model option rows   | keep with reason | `role="option"` listbox items with keyboard hook props — correct ARIA for custom dropdown.                       | None.              |
| `src/modules/MobileRemote/screens/QRScanScreen.tsx:55`                         | Validation error    | fix candidate    | `role="alert"` on raw `<p>` works but lacks `InlineAlert` retry/action affordances and consistent danger chrome. | Use `InlineAlert`. |

## D5 — Repeated visual / structural patterns

| Line                                                                     | Element                 | Verdict          | Reason                                                                                                                                                        | Suggested change                                                                                   |
| ------------------------------------------------------------------------ | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/modules/MobileRemote/components/MobileTopBar.tsx:22`                | Top bar chrome          | abstract         | `MobileTopBar` is the shared mobile header shell (used by Chat, Settings, Devices, QR, SAS). `SessionsScreen` is the outlier still hand-rolling the same bar. | One sweep: route all tab roots through `MobileTopBar` with `title` / `leading` / `trailing` slots. |
| `src/modules/MobileRemote/components/badges/DesktopPresenceLabel.tsx:12` | Presence status mapping | watch            | Duplicated `resolveDotColor` + `StatusDot` wiring in Devices list. Two sites only.                                                                            | Extract if a third presence row appears.                                                           |
| `src/modules/MobileRemote/components/SessionListItem.tsx:24`             | Session rows            | keep with reason | Already unified with Desktop via `SESSION_ROW_PRESENTATION` (prior audit).                                                                                    | None.                                                                                              |

---

## Desktop comparison notes

| Surface             | Desktop pattern                          | Mobile Remote                                              | Assessment                                              |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Settings rows       | `SectionContainer` + `SectionRow`        | Same primitives in `SettingsTab`, `DevicesTab`             | Fully aligned                                           |
| Session list        | `SESSION_ROW_PRESENTATION` in sidebar    | `SessionListItem` consumes same tokens                     | Fully aligned                                           |
| Chat composer       | `ComposerShell` stack                    | `MobileComposer` reuses full stack + voice                 | Fully aligned                                           |
| Round navigation    | `TurnNavigationToolbar`                  | `RoundNavigator` passes `variant="mobile"`                 | Shared component                                        |
| Header icon actions | `TabBarTrailingIconButton` (workstation) | `IconButton` in `MobileTopBar`                             | Correct context split — both are DS                     |
| Tool call blocks    | `EventBlockHeader` primitives            | `MobileToolCall` reuses same primitives + `BottomSheet`    | Fully aligned                                           |
| Model picker        | `ModelSelectorPill` + dropdown           | `MobileModelPicker` reuses pill; touch-positioned dropdown | Partially aligned (dropdown overlay is mobile-specific) |
| Error states        | `InlineAlert` / `Placeholder`            | Auth + transcript use DS; QR scan validation does not      | Minor gap                                               |

---

## Recommended order of attack

1. **Sessions header unification** — compose `MobileTopBar` on `SessionsScreen` (1 file, removes duplicated chrome).
2. **Stop confirm danger button** — replace `!bg-danger-6` override with `variant="danger"` (trivial, 1 line).
3. **QR validation alert** — swap raw error `<p>` for `InlineAlert` (parity with auth flow).

Defer: `MobileTabBar` inline `style` cleanup and dropdown `text-[13px]` literals until a cross-surface dropdown/tab-bar sweep is scheduled.

---

## Verdict totals

| Verdict                 | Count                                                        |
| ----------------------- | ------------------------------------------------------------ |
| **fix / fix candidate** | **6** (3 unique sweeps; some counted in multiple dimensions) |
| **keep with reason**    | **18**                                                       |
| **abstract**            | **1** (`MobileTopBar` adoption sweep)                        |
| **watch**               | **5**                                                        |

**Unique fix candidates:** 3 (`SessionsScreen` header, `StopConfirmModal` danger variant, `QRScanScreen` `InlineAlert`).
