# SettingsSidebar UI audit

Scope: retain the highlighted Settings return button and show the shared login/account control in the Settings footer. The proposed Home icon and translations were removed following the user's correction.

| Line                                                              | Element          | Verdict          | Reason                                                                                                                                                             | Suggested change |
| ----------------------------------------------------------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `src/scaffold/NavigationSidebar/variants/SettingsSidebar.tsx:110` | Account dropdown | keep with reason | Reuses `SidebarSettingsMenuButton`, including its existing menu, keyboard behavior, and signed-out login action.                                                   | None.            |
| `src/scaffold/NavigationSidebar/variants/SettingsSidebar.tsx:113` | Account trigger  | keep with reason | Reuses `SidebarAccountButton` for shared sizing, theme tokens, focus ring, accessible labels, avatar, and truncated identity. No new raw HTML or arbitrary styles. | None.            |
| `src/scaffold/NavigationSidebar/variants/SettingsSidebar.tsx:211` | Footer layout    | keep with reason | Uses `SidebarBottomBar.leftContent`; the highlighted Settings button and its existing return handler remain unchanged on the right.                                | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.

## Lifecycle review

| Area               | Verdict | Evidence                                                                                                                                                                                                                 | Change or reason kept                                                                                    | Verification                                                                                                                          |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Background work    | keep    | The account component only reads `org2CloudAuthAtom`; login starts through the existing `useOrg2CloudSignIn` click handler. Dropdown listeners and observers are installed only while open and removed on close/unmount. | No new polling, retry loop, or resource owner. `SidebarSelector` mounts only the active route's sidebar. | Source review of `SidebarSelector`, `useDropdownEngine`, and the auth storage subscription; existing sign-in and loopback tests pass. |
| Memory             | keep    | No new cache, collection, timer, or retained history. The shared login receiver replaces prior pending receivers and has a bounded expiry.                                                                               | Preserve existing ownership.                                                                             | Five loopback tests cover replacement, cancellation, and expiry.                                                                      |
| Scope/isolation    | keep    | Identity and avatar come directly from the current shared auth atom. Sign-out renders the login trigger; display name falls back to email/user ID as in the workstation sidebar.                                         | No copied auth state or new storage key.                                                                 | Existing auth and account-button tests pass; source review of the footer projection.                                                  |
| Rendering/hot path | keep    | Only `SettingsFooterAccountMenu` subscribes to auth changes; the Settings list does not gain an auth subscription.                                                                                                       | Keep the subscription in the small footer component.                                                     | Source review; no performance improvement claimed.                                                                                    |

Lifecycle coverage: closed/idle and hidden states add no periodic work; opening the menu uses existing event-driven positioning; leaving Settings unmounts the account menu; signed-out, signed-in, refresh, account, and endpoint changes read the existing auth store without a local cache. Network actions begin only when login is selected. Session/provider/sync behavior is unchanged.

## Verification

The isolated PR checkout passes all 48 targeted account/menu/auth/entitlement tests, full TypeScript compilation, lint on the five changed source files, formatting, and `git diff --check`. Exact commands and limits are recorded in [SidebarSettingsMenuButton.md](./SidebarSettingsMenuButton.md#verification). This replaces the earlier typecheck failure caused by unrelated, untracked tests in the original workspace.

The reused-component tests do not constitute a live Settings-page visual or OAuth check. Computer Use was not authorized, and no real account was logged out.

Performance verdict: pass for the scoped lifecycle invariants established by source review, targeted tests, and compilation; no runtime CPU/RAM improvement is claimed.
