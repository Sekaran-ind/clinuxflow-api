import { describe, it, expect } from 'vitest';
import { ComprehensiveLocalExtractor } from './local-extractor.js';

// SPEC-13 §5.3's two hardening risks, exercised directly against real transitions, not just
// confirming the file parses. Fixtures use simple flat blueprints matching the real
// `resourceUrl#Resource.path` definition shape local-extractor.js actually parses.

function blueprint(items) {
  return { item: items };
}
function item(linkId, definition) {
  return { linkId, definition, type: 'string' };
}
function answered(linkId, value) {
  return { linkId, answer: [{ valueString: value }] };
}

describe('ComprehensiveLocalExtractor — silent-drop hardening', () => {
  it('logs and collects a warning for an answered linkId with no blueprint definition, instead of silently dropping it', () => {
    const bp = blueprint([item('name', 'http://hl7.org/Practitioner#Practitioner.name.text')]);
    const response = { item: [answered('name', 'Dr. Priya'), answered('untracked_field', 'oops')] };

    const result = ComprehensiveLocalExtractor.extract(bp, response);

    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('untracked_field');
    // the mapped field still extracts correctly alongside the warning
    expect(result.find((r) => r.resourceType === 'Practitioner').name.text).toBe('Dr. Priya');
  });

  it('logs and collects a warning for a malformed definition string (no "#")', () => {
    const bp = blueprint([item('bad', 'not-a-valid-definition-string')]);
    const response = { item: [answered('bad', 'value')] };

    const result = ComprehensiveLocalExtractor.extract(bp, response);

    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Malformed definition');
    expect(result.length).toBe(0); // nothing extracted, but nothing crashed either
  });

  it('produces zero warnings for a clean extraction', () => {
    const bp = blueprint([item('name', 'http://hl7.org/Practitioner#Practitioner.name.text')]);
    const response = { item: [answered('name', 'Dr. Priya')] };

    const result = ComprehensiveLocalExtractor.extract(bp, response);

    expect(result.warnings.length).toBe(0);
  });
});

describe('ComprehensiveLocalExtractor — Practitioner identity resolution', () => {
  const bp = blueprint([item('name', 'http://hl7.org/Practitioner#Practitioner.name.text')]);

  it('assigns the SAME Practitioner id across two independent extractions of the same name + facility', () => {
    const response = { item: [answered('name', 'Dr. Priya Rao')] };

    const first = ComprehensiveLocalExtractor.extract(bp, response, { identityContext: { facilityId: 'malar-hospital' } });
    const second = ComprehensiveLocalExtractor.extract(bp, response, { identityContext: { facilityId: 'malar-hospital' } });

    const firstId = first.find((r) => r.resourceType === 'Practitioner').id;
    const secondId = second.find((r) => r.resourceType === 'Practitioner').id;

    expect(firstId).toBe(secondId);
    expect(firstId).toMatch(/^practitioner-/);
  });

  it('assigns DIFFERENT ids for different names at the same facility', () => {
    const responseA = { item: [answered('name', 'Dr. Priya Rao')] };
    const responseB = { item: [answered('name', 'Dr. Arjun Mehta')] };
    const ctx = { identityContext: { facilityId: 'malar-hospital' } };

    const idA = ComprehensiveLocalExtractor.extract(bp, responseA, ctx).find((r) => r.resourceType === 'Practitioner').id;
    const idB = ComprehensiveLocalExtractor.extract(bp, responseB, ctx).find((r) => r.resourceType === 'Practitioner').id;

    expect(idA).not.toBe(idB);
  });

  it('assigns DIFFERENT ids for the same name at different facilities (no cross-facility collision)', () => {
    const response = { item: [answered('name', 'Dr. Priya Rao')] };

    const idAtA = ComprehensiveLocalExtractor.extract(bp, response, { identityContext: { facilityId: 'malar-hospital' } })
      .find((r) => r.resourceType === 'Practitioner').id;
    const idAtB = ComprehensiveLocalExtractor.extract(bp, response, { identityContext: { facilityId: 'other-clinic' } })
      .find((r) => r.resourceType === 'Practitioner').id;

    expect(idAtA).not.toBe(idAtB);
  });

  it('falls back to the existing random-id behavior when the name field is missing (resolver returns null)', () => {
    const bpNoName = blueprint([item('phone', 'http://hl7.org/Practitioner#Practitioner.telecom.value')]);
    const response = { item: [answered('phone', '555-1234')] };

    const result = ComprehensiveLocalExtractor.extract(bpNoName, response);
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');

    expect(practitioner.id).toMatch(/^local-res-/); // untouched by the resolver, unchanged prior behavior
  });

  it('does not resolve identity for resource types with no registered resolver (e.g. Location stays random)', () => {
    const bpLocation = blueprint([item('loc', 'http://hl7.org/Location#Location.name')]);
    const response = { item: [answered('loc', 'Main Branch')] };

    const first = ComprehensiveLocalExtractor.extract(bpLocation, response).find((r) => r.resourceType === 'Location').id;
    const second = ComprehensiveLocalExtractor.extract(bpLocation, response).find((r) => r.resourceType === 'Location').id;

    expect(first).not.toBe(second); // confirms this is opt-in per resource type, not a blanket behavior change
  });

});

describe('ComprehensiveLocalExtractor — repeating-group handling (severe bug, confirmed live before this fix: only the LAST repetition of a repeats:true group survived, all earlier ones silently destroyed)', () => {
  function repeatingGroupBlueprint(groupLinkId, fieldDefs) {
    return { item: [{ linkId: groupLinkId, repeats: true, item: fieldDefs.map(([linkId, definition]) => item(linkId, definition)) }] };
  }
  function groupInstance(groupLinkId, answers) {
    return { linkId: groupLinkId, item: answers.map(([linkId, value]) => answered(linkId, value)) };
  }

  it('SEPARATE-INSTANCES mode: diverging paths (Practitioner.name.text vs Practitioner.telecom.value) produce one resource PER repetition, not one overwritten N times', () => {
    const bp = repeatingGroupBlueprint('section_staff', [
      ['staff_name', 'http://hl7.org/Practitioner#Practitioner.name.text'],
      ['staff_phone', 'http://hl7.org/Practitioner#Practitioner.telecom.value'],
    ]);
    const response = {
      item: [
        groupInstance('section_staff', [['staff_name', 'Dr. Priya Rao'], ['staff_phone', '111']]),
        groupInstance('section_staff', [['staff_name', 'Dr. Arjun Mehta'], ['staff_phone', '222']]),
      ],
    };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const names = result.filter((r) => r.resourceType === 'Practitioner').map((r) => r.name.text);

    expect(names).toEqual(['Dr. Priya Rao', 'Dr. Arjun Mehta']); // both survive; first one used to be silently destroyed
  });

  it('a single-leaf-field repeating group (Location.name) also resolves to separate-instances, not a false array-field match against itself', () => {
    const bp = repeatingGroupBlueprint('section_location', [['loc_name', 'http://hl7.org/Location#Location.name']]);
    const response = {
      item: [
        groupInstance('section_location', [['loc_name', 'Main Branch']]),
        groupInstance('section_location', [['loc_name', 'Annex Branch']]),
      ],
    };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const names = result.filter((r) => r.resourceType === 'Location').map((r) => r.name);

    expect(names).toEqual(['Main Branch', 'Annex Branch']);
  });

  it('ARRAY-FIELD mode: converging paths (PlanDefinition.action.id / .title share "action") produce ONE resource with a correctly-positioned array, not a scalar overwritten N times', () => {
    const bp = repeatingGroupBlueprint('section_workflow_action', [
      ['action_id', 'http://hl7.org/PlanDefinition#PlanDefinition.action.id'],
      ['action_title', 'http://hl7.org/PlanDefinition#PlanDefinition.action.title'],
    ]);
    const response = {
      item: [
        groupInstance('section_workflow_action', [['action_id', 'facility_registration'], ['action_title', 'Facility Registration']]),
        groupInstance('section_workflow_action', [['action_id', 'provider_registration'], ['action_title', 'Provider Registration']]),
      ],
    };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const plans = result.filter((r) => r.resourceType === 'PlanDefinition');

    expect(plans.length).toBe(1); // one shared resource, not two
    expect(plans[0].action).toEqual([
      { id: 'facility_registration', title: 'Facility Registration' },
      { id: 'provider_registration', title: 'Provider Registration' },
    ]);
  });

  it('non-repeating groups and bare fields are completely unaffected (existing component/coding Observation behavior still works)', () => {
    const bp = blueprint([
      item('bp_sys', 'http://hl7.org/Observation#Observation.component.valueQuantity.value'),
      item('bp_dia', 'http://hl7.org/Observation#Observation.component.valueQuantity.value'),
    ]);
    const response = { item: [answered('bp_sys', 120), answered('bp_dia', 80)] };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const obs = result.find((r) => r.resourceType === 'Observation');

    expect(obs.component.map((c) => c.valueQuantity.value)).toEqual([120, 80]);
  });

  it('GENUINE NESTING: a repeating group nested inside another repeating group (PlanDefinition.action[i].relatedAction[j]) resolves correctly — the two-independently-repeating-groups collision from SPEC-18 §7 step 3, closed by construction', () => {
    // Matches yaml-to-questionnaire.js's real compiled shape for a type:"group" field: the
    // relatedAction group has its own `definition` and sits INSIDE the action item, not as a
    // sibling top-level block — this is what makes the fix work, not extractor cleverness.
    const bp = blueprint([]);
    bp.item = [{
      linkId: 'section_workflow_action', repeats: true, item: [
        { linkId: 'action_id', definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.id', type: 'string' },
        { linkId: 'action_title', definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.title', type: 'string' },
        {
          linkId: 'action_related', repeats: true, definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.relatedAction', item: [
            { linkId: 'relation_target', definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.relatedAction.actionId', type: 'string' },
            { linkId: 'relation_relationship', definition: 'http://hl7.org/PlanDefinition#PlanDefinition.action.relatedAction.relationship', type: 'string' },
          ],
        },
      ],
    }];

    const response = {
      item: [
        { linkId: 'section_workflow_action', item: [
          { linkId: 'action_id', answer: [{ valueString: 'facility_registration' }] },
          { linkId: 'action_title', answer: [{ valueString: 'Facility Registration' }] },
        ] },
        { linkId: 'section_workflow_action', item: [
          { linkId: 'action_id', answer: [{ valueString: 'provider_registration' }] },
          { linkId: 'action_title', answer: [{ valueString: 'Provider Registration' }] },
          { linkId: 'action_related', item: [
            { linkId: 'relation_target', answer: [{ valueString: 'facility_registration' }] },
            { linkId: 'relation_relationship', answer: [{ valueString: 'after-start' }] },
          ] },
        ] },
      ],
    };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const plan = result.find((r) => r.resourceType === 'PlanDefinition');

    expect(plan.action).toEqual([
      { id: 'facility_registration', title: 'Facility Registration' }, // untouched by the relatedAction — the bug this fixes
      { id: 'provider_registration', title: 'Provider Registration', relatedAction: [{ actionId: 'facility_registration', relationship: 'after-start' }] },
    ]);
  });

  it('reference-linking still resolves against the RESOLVED Practitioner id, not the pre-resolution random one', () => {
    const bpWithRole = blueprint([
      item('name', 'http://hl7.org/Practitioner#Practitioner.name.text'),
      item('org', 'http://hl7.org/Organization#Organization.name'),
      item('roleTitle', 'http://hl7.org/PractitionerRole#PractitionerRole.code'),
    ]);
    const response = {
      item: [answered('name', 'Dr. Priya Rao'), answered('org', 'Malar Hospital'), answered('roleTitle', 'Cardiologist')],
    };

    const result = ComprehensiveLocalExtractor.extract(bpWithRole, response, { identityContext: { facilityId: 'malar-hospital' } });
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');
    const role = result.find((r) => r.resourceType === 'PractitionerRole');

    expect(practitioner.id).toMatch(/^practitioner-/);
    expect(role.practitioner.reference).toBe(`Practitioner/${practitioner.id}`);
  });
});
