# WizardSystem primitive acceptance cases

| Primitive              | Case                | Expected result                                                                                           |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `WizardStepNavigation` | Active step         | Exposes `aria-current="step"` without inserting selection markup that changes row geometry.               |
| `WizardStepNavigation` | Completed step      | Replaces the step glyph inside the existing fixed-size icon slot and preserves title alignment.           |
| `WizardStepNavigation` | Locked step         | Uses a native disabled button and does not call the owning flow.                                          |
| `WizardStepNavigation` | Owning flow is busy | Disables every step while preserving the active state.                                                    |
| `WizardStepContent`    | Intro content       | Delegates semantic title, description, icon, spacing, and accessible heading linkage to `SectionHeading`. |

## Verification

- Static render: `WizardStepNavigation.test.ts`, `WizardStepContent.test.ts`.
- Static gates: TypeScript typecheck and ESLint.
