# SettingsNavigation UI audit

| Line                                                           | Element                      | Verdict          | Reason                                                                                                                      | Suggested change |
| -------------------------------------------------------------- | ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/modules/MainApp/Settings/sections/GeneralSection.tsx:331` | Login section above Language | keep with reason | Login uses its own shared `SectionContainer`, preserving a clear section boundary while keeping it directly above Language. | None.            |
| `src/modules/MainApp/Settings/config.ts:65`                    | General tab pill metadata    | keep with reason | The navigation continues to use the shared `TabPill` component; Self-hosted is the only moved tab and remains last.         | None.            |
| `src/features/Org2Cloud/Org2CloudSection.tsx:46`               | ORG2 login rows              | keep with reason | The rows retain shared `SectionRow` and `Button` primitives while General supplies the surrounding container.               | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.
