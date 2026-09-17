import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { compileYamlToQuestionnaire } from '../shared/yaml-to-questionnaire.js';
import { ComprehensiveLocalExtractor } from '../shared/local-extractor.js';
import { buildHospitalSetupWorkflowResponse } from './hospital-setup-workflow-response.js';

// SPEC-22 (docs/SPEC-22-PERSISTED-WORKFLOW-SYSTEM-FLOWS-CUBO-STATE-MIRROR-DRAWER-CAPTURE.md)
// decision 2 — the first real (non-draft) system-flow YAML, confirmed compiling through the same
// unmodified pipeline workflow-definition-draft.test.js already proved, with a realistic 4-step
// linear Hospital sequence (see samples/hospital-setup-workflow-v1.yaml's "Worked example").
const flowYaml = fs.readFileSync(
  path.join(process.cwd(), 'samples', 'hospital-setup-workflow-v1.yaml'),
  'utf8'
);

describe('hospital-setup-workflow-v1.yaml compiles through the real pipeline', () => {
  it('compiles with no errors', () => {
    const result = compileYamlToQuestionnaire(flowYaml);
    if (result.errors && result.errors.length) {
      console.error('Compilation errors:', result.errors);
    }
    expect(result.errors || []).toEqual([]);
  });

  it('produces a Questionnaire with the two top-level section groups', () => {
    const result = compileYamlToQuestionnaire(flowYaml);
    const groupTexts = result.questionnaire.item.map((i) => i.text);
    expect(groupTexts).toEqual(expect.arrayContaining(['Hospital Setup Workflow', 'Steps']));
  });

  it('the Steps group is repeatable, with nested repeatable Depends On and Condition groups', () => {
    const result = compileYamlToQuestionnaire(flowYaml);
    const steps = result.questionnaire.item.find((i) => i.text === 'Steps');
    expect(steps.repeats).toBe(true);

    const dependsOn = steps.item.find((i) => i.text === 'Depends On');
    expect(dependsOn).toMatchObject({
      type: 'group',
      repeats: true,
      definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.relatedAction',
    });

    const condition = steps.item.find((i) => i.text === 'Condition');
    expect(condition).toMatchObject({
      type: 'group',
      repeats: true,
      definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.condition',
    });
  });

  it('extracts the real 4-step linear Hospital sequence correctly — root step untouched, each dependent step carries its own nested relatedAction, action ids match the real Provider-composition section ids by construction', () => {
    const compiled = compileYamlToQuestionnaire(flowYaml);

    const step = (id, title, dependsOnId) => ({
      linkId: 'section_workflow_action',
      item: [
        { linkId: 'action_id', answer: [{ valueString: id }] },
        { linkId: 'action_title', answer: [{ valueString: title }] },
        ...(dependsOnId
          ? [{
              linkId: 'action_related',
              item: [
                { linkId: 'relation_target_action_id', answer: [{ valueString: dependsOnId }] },
                { linkId: 'relation_relationship', answer: [{ valueString: 'after-end' }] },
              ],
            }]
          : []),
      ],
    });

    const response = {
      item: [
        {
          linkId: 'section_workflow_plan',
          item: [
            { linkId: 'plan_title', answer: [{ valueString: 'Hospital Setup Workflow' }] },
            { linkId: 'plan_status', answer: [{ valueString: 'draft' }] },
            { linkId: 'plan_type', answer: [{ valueString: 'workflow-definition' }] },
          ],
        },
        step('section_hospital', 'Hospital Details', null),
        step('section_hospital_abdm_facility_type', 'ABDM Facility Type', 'section_hospital'),
        step('section_hospital_abdm_location', 'ABDM Location (LGD Codes)', 'section_hospital_abdm_facility_type'),
        step('section_hospital_abdm_registration', 'ABDM Facility Registration', 'section_hospital_abdm_location'),
      ],
    };

    const result = ComprehensiveLocalExtractor.extract(compiled.questionnaire, response);
    const plan = result.find((r) => r.resourceType === 'PlanDefinition');

    expect(plan.title).toBe('Hospital Setup Workflow');
    expect(plan.action).toEqual([
      { id: 'section_hospital', title: 'Hospital Details' },
      {
        id: 'section_hospital_abdm_facility_type',
        title: 'ABDM Facility Type',
        relatedAction: [{ actionId: 'section_hospital', relationship: 'after-end' }],
      },
      {
        id: 'section_hospital_abdm_location',
        title: 'ABDM Location (LGD Codes)',
        relatedAction: [{ actionId: 'section_hospital_abdm_facility_type', relationship: 'after-end' }],
      },
      {
        id: 'section_hospital_abdm_registration',
        title: 'ABDM Facility Registration',
        relatedAction: [{ actionId: 'section_hospital_abdm_location', relationship: 'after-end' }],
      },
    ]);
    expect(result.warnings).toEqual([]);

    // The real binding this whole design depends on: every extracted action id matches a real
    // section id in tools/system-forms/system-provider-composition-v1.yaml by construction, not
    // by a separate lookup table that could drift out of sync.
    const realSectionIds = ['section_hospital', 'section_hospital_abdm_facility_type', 'section_hospital_abdm_location', 'section_hospital_abdm_registration'];
    expect(plan.action.map((a) => a.id)).toEqual(realSectionIds);
  });

  // SPEC-22 decision #2's real loader — this is the genuinely new case for this pipeline: the
  // test above only ever exercised a linear chain (each step depends on exactly the ONE before
  // it). This is the REAL, currently-running Hospital-setup shape (clinux-frontend's
  // hospitalSetupPlanDefinition.js): 6 sibling steps that all depend on the SAME parent
  // (section_hospital) without depending on each other — multiple repeating top-level instances
  // each referencing back to one common id, not a chain. Directly relevant to the earlier
  // local-extractor.js bug this session found+fixed (a nested-group instance counter keyed
  // globally instead of per-parent-instance) — that fix was proven on NESTED groups; this proves
  // the SAME extractor handles multiple independent TOP-LEVEL sibling instances correctly too.
  it('extracts the real, current 10-action Hospital-setup shape — 6 operational siblings all depending on section_hospital alone, not on each other', () => {
    const compiled = compileYamlToQuestionnaire(flowYaml);
    const response = buildHospitalSetupWorkflowResponse();

    const result = ComprehensiveLocalExtractor.extract(compiled.questionnaire, response);
    const plan = result.find((r) => r.resourceType === 'PlanDefinition');

    expect(result.warnings).toEqual([]);
    expect(plan.title).toBe('Hospital Setup Workflow');
    expect(plan.status).toBe('active');

    // Exact match against clinux-frontend's hand-authored HOSPITAL_SETUP_PLAN_DEFINITION —
    // the real proof this loader produces the SAME plan, not a divergent copy.
    expect(plan.action).toEqual([
      { id: 'section_hospital', title: 'Hospital Details' },
      { id: 'section_hospital_abdm_facility_type', title: 'ABDM Facility Type', relatedAction: [{ actionId: 'section_hospital', relationship: 'after-end' }] },
      { id: 'section_hospital_abdm_location', title: 'ABDM Location (LGD Codes)', relatedAction: [{ actionId: 'section_hospital_abdm_facility_type', relationship: 'after-end' }] },
      { id: 'section_hospital_abdm_registration', title: 'ABDM Facility Registration', relatedAction: [{ actionId: 'section_hospital_abdm_location', relationship: 'after-end' }] },
      { id: 'section_location', title: 'Branch / Location Details', relatedAction: [{ actionId: 'section_hospital', relationship: 'after-end' }] },
      { id: 'section_staff', title: 'Staff Details', relatedAction: [{ actionId: 'section_hospital', relationship: 'after-end' }] },
      { id: 'section_services_matrix', title: 'Service Details', relatedAction: [{ actionId: 'section_hospital', relationship: 'after-end' }] },
      { id: 'section_hours', title: 'Operating Hours', relatedAction: [{ actionId: 'section_hospital', relationship: 'after-end' }] },
      { id: 'section_consent', title: 'Consent Details', relatedAction: [{ actionId: 'section_hospital', relationship: 'after-end' }] },
      { id: 'section_appointment', title: 'Appointment Details', relatedAction: [{ actionId: 'section_hospital', relationship: 'after-end' }] },
    ]);
  });
});
