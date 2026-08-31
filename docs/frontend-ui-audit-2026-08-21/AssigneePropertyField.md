# Human-only Work Item assignment

## Scope

Audited the shared Work Item assignee picker and both manual/AI creation write paths for design-system usage, identity semantics, accessibility, and duplicate assignment logic.

## Findings

| Line                                                                                                   | Element                              | Verdict          | Reason                                                                                                                                                                      | Suggested change                                                               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/AssigneePropertyField.tsx:25`      | Assignee picker contract             | fix              | The former contract accepted agent definitions and agent organizations alongside roster members, which overloaded assignment with execution targeting.                      | Keep the canonical picker input limited to `Person[]` roster members.          |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/AssigneePropertyField.tsx:273`     | Searchable assignment options        | fix              | The options now derive from the human roster only while retaining the established `PropertyDropdownField`, `Option`, and `Avatar` design-system components.                 | Keep agent and organization execution controls outside this picker.            |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/useWorkItemPropertyHandlers.ts:21` | Assignment update writer             | fix              | A selected roster member is now written with canonical `assigneeType: "human"`; clearing the selection clears the identity and type together.                               | Route future local assignment changes through `buildHumanAssigneeUpdate`.      |
| `src/modules/ProjectManager/WorkItems/humanAssignee.ts:13`                                             | Draft write invariant                | abstract         | Manual and AI creation share one boundary that accepts `human`/legacy `member`, canonicalizes to `human`, and rejects agent/org identities.                                 | Reuse this helper for any new draft-based Work Item creation path.             |
| `src/modules/ProjectManager/WorkItems/components/CreateWorkItemView/createWorkItemFromDraft.ts:95`     | Manual creation payload              | fix              | The persisted request can no longer copy an agent execution identity from draft assignment fields.                                                                          | Keep execution metadata in `orchestratorConfig`.                               |
| `src/engines/ChatPanel/hooks/useAiWorkItemCreator.ts:99`                                               | AI execution target resolver         | fix              | AI creation now resolves agents and agent organizations as execution targets independently from the human assignee.                                                         | Preserve the `executionTarget` terminology and separate payload fields.        |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/AssigneePropertyField.tsx:139`     | External GitHub assignees            | keep with reason | GitHub assignees are external human identities and may be multi-select; their provider-backed picker has distinct persistence behavior.                                     | Keep the external configuration branch unchanged.                              |
| `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/AssigneePropertyField.tsx:77`      | Historical non-human assignment icon | keep with reason | Existing persisted agent/org assignments remain visible rather than being silently hidden or destructively rewritten. They are no longer offered as new assignment options. | Handle any historical cleanup as a separately confirmed data-remediation task. |

## Summary

- Fix: 5
- Keep with reason: 2
- Abstract: 1
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the referenced user-global and workspace locations. This report follows the repository's documented audit table convention and covers the changed UI and producing write boundaries directly.
