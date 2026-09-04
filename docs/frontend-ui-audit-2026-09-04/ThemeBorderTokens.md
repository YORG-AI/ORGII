# Theme border tokens UI audit

| Line                                                  | Element                         | Verdict          | Reason                                                                                                                                         | Suggested change |
| ----------------------------------------------------- | ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `public/orgii_main.css:114`                           | ORGII light `border-1` token    | keep with reason | The lighter neutral remains theme-owned and less prominent than `border-2`, so all consumers receive the change without local color overrides. | None.            |
| `public/orgii_dark.css:114`                           | ORGII dark `border-1` token     | keep with reason | The brighter neutral is still below `border-2`, preserving the three-level border hierarchy on dark surfaces.                                  | None.            |
| `src/config/appearance/skins/deriveSkinTokens.ts:139` | Derived-skin `border-1` formula | keep with reason | Adjusting the shared derivation keeps selectable light and dark skins aligned with the lighter ORGII baseline treatment.                       | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.
