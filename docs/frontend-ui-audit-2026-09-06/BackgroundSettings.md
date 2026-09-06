# Background Settings UI Audit

Scope: the color-only Background settings refactor in `BackgroundSettings.tsx`
and `ColorSection.tsx`.

| Line                            | Element                                | Verdict          | Reason                                                                                                                                                                                                                                  | Suggested change |
| ------------------------------- | -------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BackgroundSettings.tsx:63-120` | Appearance and background setting rows | keep with reason | Uses the shared `SectionContainer`, `SectionRow`, `Select`, and `Slider` components and their shared control-width token. The image-source branch was removed without introducing a parallel layout pattern.                            | None             |
| `ColorSection.tsx:67-90`        | Preset and custom color swatches       | keep with reason | Native buttons are appropriate semantic color swatches; the shared `Button` component does not expose swatch fill behavior. Existing tokenized borders, focus-visible treatment, and selected state remain consistent across both sets. | None             |
| `ColorSection.tsx:91-109`       | Custom-color delete control            | keep with reason | Uses the shared `Button` component with the standard secondary/solid/mini/circle treatment and an icon-only accessible title.                                                                                                           | None             |
| `ColorSection.tsx:114-145`      | Native color picker trigger            | keep with reason | A label wrapping `input[type=color]` preserves native picker behavior and keyboard activation. It intentionally shares the swatch classes so the add control aligns with the palette.                                                   | None             |

Totals: 0 fix candidates, 4 keep-with-reason findings, 0 abstraction candidates.
