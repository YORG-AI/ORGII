# Test Cases: DeveloperTestPanel

## Outcome and ownership

- Development builds expose a dedicated flask button beside the onboarding guide.
- The button opens a standalone developer test panel, not a section inside product guidance.
- `moduleRegistry.ts` is the single registration point for current and future test modules.
- Each module owns its runtime state and safety policy; the panel owns only open/close and module disclosure state.
- No test choice persists or mutates authoritative backend data.

## State matrix

| State                          | Visible UI                                                               | Allowed actions                                       | Exit / recovery                     | Persisted effect |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------- | ---------------- |
| Production                     | No flask trigger or test-panel hooks                                     | None                                                  | Start a development build           | None             |
| Development, closed            | Flask trigger beside the guide                                           | Open panel                                            | Click trigger                       | None             |
| Development, open              | Panel header and registered module sections                              | Expand/collapse modules, choose safe scenarios, close | Outside click, Escape, close button | None             |
| Onboarding live                | Real data selected                                                       | Inspect or select another scenario                    | Choose another scenario             | None             |
| Onboarding no organization     | Guide treats organization as missing                                     | Exercise connect/create route; restore real data      | Choose Real data or restart         | None             |
| Role scenario without real org | Member/Admin/Owner choices disabled with explanation                     | Live and no-organization choices only                 | Join/load a real cloud org          | None             |
| Member/Admin/Owner scenario    | Members presentation uses the selected role and shows a read-only notice | Inspect presentation only                             | Choose Real data or restart         | None             |

## Safety and regression cases

| Scenario              | Expected result                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Module registration   | Onboarding appears from `DEVELOPER_TEST_MODULES`; adding another descriptor creates another independent section. |
| Guide opened          | No developer section or scenario controls appear inside the guide.                                               |
| Scenario changed      | The independent test panel remains open; the runtime Atom updates immediately.                                   |
| Non-live scenario     | Trigger/header exposes a visible DEV indicator.                                                                  |
| Admin / Owner preview | Invite, leave, member role, sharing floor, removal, and revoke actions remain disabled at UI and handler level.  |
| Real data restored    | Authoritative organization role and guide completion return immediately.                                         |
| Restart               | Runtime Atom initializes to Real data.                                                                           |
| Locale                | Developer panel title and onboarding scenario labels exist in all navigation locales.                            |

## Verification

- Unit: `DeveloperTestPanel.test.ts`, `setupGuideDevScenarioAtom.test.ts`, `SidebarGuideButton.test.ts`.
- Safety: `CloudOrgPanelView.guide.test.ts`, `ManagementSections.test.ts`.
- Static: TypeScript, ESLint, locale-shape test, and `git diff --check`.
- Visual: open the flask trigger in the desktop development build, switch Real data → No organization → Admin → Real data, and verify the guide remains free of test controls.
