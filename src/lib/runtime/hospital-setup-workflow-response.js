// SPEC-22 decision #2's real loader — the actual content of hospital-setup-workflow-v1.yaml's
// authoring form (see that file's own header: the compiled Questionnaire is a form FOR describing
// a PlanDefinition's steps, not the plan itself; a QuestionnaireResponse to it is what
// ComprehensiveLocalExtractor turns into the real PlanDefinition). There's no real authoring UI
// yet that produces this response interactively (that's the Room-Architect Designer rebuild,
// still unbuilt) — this is a hand-built "worked example" response, same honest framing
// clinux-frontend's hospitalSetupPlanDefinition.js already used for its own hand-authored mirror.
// Extracted here as its own module (not inlined in the test) because tools/build-system-flows.js
// needs the IDENTICAL response the test proves is correct — one fixture, two consumers, so they
// can never silently drift apart.
//
// Matches clinux-frontend's HOSPITAL_SETUP_PLAN_DEFINITION action-for-action: the linear 3-step
// ABDM sub-chain under section_hospital, plus 6 operational groups each depending ONLY on
// section_hospital (siblings, not chained to each other) — a genuinely new shape for this pipeline
// to prove (the original 4-step version was linear-only; this is the first real non-linear/
// multiple-siblings-of-one-parent case run through the extractor).
function step(id, title, dependsOnId) {
  return {
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
  };
}

export function buildHospitalSetupWorkflowResponse() {
  return {
    item: [
      {
        linkId: 'section_workflow_plan',
        item: [
          { linkId: 'plan_title', answer: [{ valueString: 'Hospital Setup Workflow' }] },
          { linkId: 'plan_status', answer: [{ valueString: 'active' }] },
          { linkId: 'plan_type', answer: [{ valueString: 'workflow-definition' }] },
        ],
      },
      // Linear ABDM sub-chain — a hospital must exist before it can be classified, must be
      // classified before its location is coded, must be located before it can be registered.
      step('section_hospital', 'Hospital Details', null),
      step('section_hospital_abdm_facility_type', 'ABDM Facility Type', 'section_hospital'),
      step('section_hospital_abdm_location', 'ABDM Location (LGD Codes)', 'section_hospital_abdm_facility_type'),
      step('section_hospital_abdm_registration', 'ABDM Facility Registration', 'section_hospital_abdm_location'),
      // The 6 operational groups — no real dependency on each other, only on section_hospital
      // existing first (can't attach a staff roster to a facility that isn't saved yet).
      step('section_location', 'Branch / Location Details', 'section_hospital'),
      step('section_staff', 'Staff Details', 'section_hospital'),
      step('section_services_matrix', 'Service Details', 'section_hospital'),
      step('section_hours', 'Operating Hours', 'section_hospital'),
      step('section_consent', 'Consent Details', 'section_hospital'),
      step('section_appointment', 'Appointment Details', 'section_hospital'),
    ],
  };
}
