import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { compileYamlToQuestionnaire } from './yaml-to-questionnaire.js';
import { ComprehensiveLocalExtractor } from './local-extractor.js';

// SPEC-18 (docs/SPEC-18-PLANDEFINITION-AUTHORING-VIA-YAML-PIPELINE.md) §7 steps 1-3 — confirms the
// draft workflow-definition.yaml (samples/workflow-definition-v1.draft.yaml) actually compiles
// through the real, unmodified pipeline, AND extracts correctly end to end including the nested
// relatedAction group — not just "the individual paths exist in the graph in isolation."
const draftYaml = fs.readFileSync(
  path.join(process.cwd(), 'samples', 'workflow-definition-v1.draft.yaml'),
  'utf8'
);

describe('workflow-definition-v1.draft.yaml compiles through the real pipeline', () => {
  it('compiles with no errors', () => {
    const result = compileYamlToQuestionnaire(draftYaml);
    if (result.errors && result.errors.length) {
      console.error('Compilation errors:', result.errors);
    }
    expect(result.errors || []).toEqual([]);
  });

  it('produces a Questionnaire with the two top-level section groups (relatedAction now nests inside Rooms, not a sibling "Sequencing" table)', () => {
    const result = compileYamlToQuestionnaire(draftYaml);
    const groupTexts = result.questionnaire.item.map((i) => i.text);
    expect(groupTexts).toEqual(expect.arrayContaining(['Workflow Definition', 'Rooms']));
  });

  it('the Rooms group is repeatable, and its "Depends On" child is itself a nested repeatable group with a real definition', () => {
    const result = compileYamlToQuestionnaire(draftYaml);
    const rooms = result.questionnaire.item.find((i) => i.text === 'Rooms');
    expect(rooms.repeats).toBe(true);

    const dependsOn = rooms.item.find((i) => i.text === 'Depends On');
    expect(dependsOn).toMatchObject({
      type: 'group',
      repeats: true,
      definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.relatedAction',
    });
  });

  it('the Condition group (SPEC-18 §7 step 4) is a nested repeatable group whose type is Autocomplete-bound to the condition-types ValueSet, never free text', () => {
    const result = compileYamlToQuestionnaire(draftYaml);
    const rooms = result.questionnaire.item.find((i) => i.text === 'Rooms');
    const condition = rooms.item.find((i) => i.text === 'Condition');

    expect(condition).toMatchObject({
      type: 'group',
      repeats: true,
      definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.condition',
    });

    const kind = condition.item.find((i) => i.linkId === 'condition_kind');
    expect(kind.initial).toEqual([{ valueString: 'applicability' }]);

    const conditionType = condition.item.find((i) => i.linkId === 'condition_type');
    expect(conditionType.type).toBe('open-choice'); // Autocomplete -> open-choice, never a free string
    expect(conditionType.answerValueSet).toContain('/api/valuesets/plandefinition-condition-types');
  });

  it('extracts a realistic filled response correctly — the room with no dependency stays untouched, the dependent room gets its own nested relatedAction, no cross-room corruption', () => {
    const compiled = compileYamlToQuestionnaire(draftYaml);
    const response = {
      item: [
        {
          linkId: 'section_workflow_plan',
          item: [
            { linkId: 'plan_title', answer: [{ valueString: 'Clinic Visit Workflow' }] },
            { linkId: 'plan_status', answer: [{ valueString: 'draft' }] },
            { linkId: 'plan_type', answer: [{ valueString: 'workflow-definition' }] },
          ],
        },
        {
          linkId: 'section_workflow_action',
          item: [
            { linkId: 'action_id', answer: [{ valueString: 'facility_registration' }] },
            { linkId: 'action_title', answer: [{ valueString: 'Facility Registration' }] },
          ],
        },
        {
          linkId: 'section_workflow_action',
          item: [
            { linkId: 'action_id', answer: [{ valueString: 'provider_registration' }] },
            { linkId: 'action_title', answer: [{ valueString: 'Provider Registration' }] },
            {
              linkId: 'action_related',
              item: [
                { linkId: 'relation_target_action_id', answer: [{ valueString: 'facility_registration' }] },
                { linkId: 'relation_relationship', answer: [{ valueString: 'after-start' }] },
              ],
            },
          ],
        },
      ],
    };

    const result = ComprehensiveLocalExtractor.extract(compiled.questionnaire, response);
    const plan = result.find((r) => r.resourceType === 'PlanDefinition');

    expect(plan.title).toBe('Clinic Visit Workflow');
    expect(plan.action).toEqual([
      { id: 'facility_registration', title: 'Facility Registration' },
      {
        id: 'provider_registration',
        title: 'Provider Registration',
        relatedAction: [{ actionId: 'facility_registration', relationship: 'after-start' }],
      },
    ]);
    expect(result.warnings).toEqual([]);
  });
});
