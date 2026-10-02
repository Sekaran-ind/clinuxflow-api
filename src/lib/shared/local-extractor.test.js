import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ComprehensiveLocalExtractor } from './local-extractor.js';
import { compileYamlToQuestionnaire } from './yaml-to-questionnaire.js';

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
    expect(result.find((r) => r.resourceType === 'Practitioner').name[0].text).toBe('Dr. Priya'); // name is 0..* in FHIR: an array
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
    const names = result.filter((r) => r.resourceType === 'Practitioner').map((r) => r.name[0].text);

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

  it('SPEC-24 §2 real bug, confirmed live before this fix: a resourceType nested inside a DIFFERENT repeating resourceType\'s frame (PractitionerRole inside a repeating Practitioner "Staff" group — the real shape Provider capture needs) produced only ONE shared PractitionerRole, silently clobbered down to the last repetition\'s own values', () => {
    const bp = blueprint([]);
    bp.item = [{
      linkId: 'section_staff', repeats: true, item: [
        { linkId: 'staff_name', definition: 'http://hl7.org/Practitioner#Practitioner.name.text', type: 'string' },
        {
          linkId: 'staff_role_group', repeats: false, definition: 'http://hl7.org/Practitioner#PractitionerRole', item: [
            { linkId: 'staff_role_code', definition: 'http://hl7.org/Practitioner#PractitionerRole.code', type: 'string' },
          ],
        },
      ],
    }];
    const response = {
      item: [
        { linkId: 'section_staff', item: [
          { linkId: 'staff_name', answer: [{ valueString: 'Dr. Alice' }] },
          { linkId: 'staff_role_group', item: [{ linkId: 'staff_role_code', answer: [{ valueString: '1' }] }] },
        ] },
        { linkId: 'section_staff', item: [
          { linkId: 'staff_name', answer: [{ valueString: 'Dr. Bob' }] },
          { linkId: 'staff_role_group', item: [{ linkId: 'staff_role_code', answer: [{ valueString: '2' }] }] },
        ] },
      ],
    };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const roles = result.filter((r) => r.resourceType === 'PractitionerRole');

    expect(roles.map((r) => r.code[0].text)).toEqual(['1', '2']); // both survive; used to collapse to just ['2']
  });

  it('each per-repetition PractitionerRole correctly cross-references its OWN Practitioner (and the shared singleton Organization), not another repetition\'s', () => {
    const bp = blueprint([]);
    bp.item = [
      { linkId: 'section_hospital', item: [{ linkId: 'hospital_name', definition: 'http://hl7.org/Organization#Organization.name', type: 'string' }] },
      {
        linkId: 'section_staff', repeats: true, item: [
          { linkId: 'staff_name', definition: 'http://hl7.org/Practitioner#Practitioner.name.text', type: 'string' },
          {
            linkId: 'staff_role_group', repeats: false, definition: 'http://hl7.org/Practitioner#PractitionerRole', item: [
              { linkId: 'staff_role_code', definition: 'http://hl7.org/Practitioner#PractitionerRole.code', type: 'string' },
            ],
          },
        ],
      },
    ];
    const response = {
      item: [
        { linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'ABC Hospital' }] }] },
        { linkId: 'section_staff', item: [
          { linkId: 'staff_name', answer: [{ valueString: 'Dr. Alice' }] },
          { linkId: 'staff_role_group', item: [{ linkId: 'staff_role_code', answer: [{ valueString: '1' }] }] },
        ] },
        { linkId: 'section_staff', item: [
          { linkId: 'staff_name', answer: [{ valueString: 'Dr. Bob' }] },
          { linkId: 'staff_role_group', item: [{ linkId: 'staff_role_code', answer: [{ valueString: '2' }] }] },
        ] },
      ],
    };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const org = result.find((r) => r.resourceType === 'Organization');
    const alice = result.find((r) => r.resourceType === 'Practitioner' && r.name[0].text === 'Dr. Alice');
    const bob = result.find((r) => r.resourceType === 'Practitioner' && r.name[0].text === 'Dr. Bob');
    const aliceRole = result.find((r) => r.resourceType === 'PractitionerRole' && r.code[0].text === '1');
    const bobRole = result.find((r) => r.resourceType === 'PractitionerRole' && r.code[0].text === '2');

    expect(aliceRole.practitioner.reference).toBe(`Practitioner/${alice.id}`);
    expect(bobRole.practitioner.reference).toBe(`Practitioner/${bob.id}`);
    expect(aliceRole.organization.reference).toBe(`Organization/${org.id}`);
    expect(bobRole.organization.reference).toBe(`Organization/${org.id}`);
  });
});

// SPEC-23/§"Facility Onboarding/Provider Onboarding/Patient Registration" build — a real,
// severe, empirically-confirmed data-loss bug found while grounding that work before writing any
// UI: sibling fields sharing one FHIR leaf path (Organization.telecom.value, Practitioner.
// identifier.value, ...) silently overwrote each other, and every non-component/coding array-
// typed FHIR property was written as a bare object instead of a JSON array — structurally invalid
// for a real HAPI server regardless of the collision. Both confirmed live against the REAL,
// unmodified system-provider-composition-v1.yaml through the real compile+extract pipeline before
// fixing, not assumed — these tests reproduce those exact confirmed cases.
describe('ComprehensiveLocalExtractor — FHIR array-cardinality fix (real data-loss bug, confirmed live)', () => {
  const providerYaml = fs.readFileSync(
    path.join(process.cwd(), 'tools', 'system-forms', 'system-provider-composition-v1.yaml'),
    'utf8'
  );
  const compiledProvider = compileYamlToQuestionnaire(providerYaml);

  function staffAnswer(...fields) {
    return {
      item: [{ linkId: 'section_staff', item: [{ linkId: 'section_staff', item: fields }] }],
    };
  }

  it('compiles cleanly (guards this whole describe block against the fixture drifting from the real YAML)', () => {
    expect(compiledProvider.success).toBe(true);
  });

  it('REGRESSION: staff_phone and staff_email (both Practitioner.telecom.value) both survive extraction, as a real array — previously only the last one processed did, as a bare object', () => {
    const response = staffAnswer(
      answered('staff_name', 'Dr. Test Person'),
      answered('staff_phone', '555-1234'),
      answered('staff_email', 'dr.test@example.com'),
    );
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');

    expect(Array.isArray(practitioner.telecom)).toBe(true);
    expect(practitioner.telecom.map((t) => t.value).sort()).toEqual(['555-1234', 'dr.test@example.com'].sort());
  });

  // UPDATE — the 9-way Practitioner.identifier.value collision this test originally proved safe
  // is now, correctly, TWO separate real FHIR homes: staff_license/staff_hprid/staff_hpr_id_number
  // are genuine business identifiers (stay on Practitioner.identifier); the 6 ABDM-registration-
  // process fields moved to real, distinctly-URLed Practitioner.extension entries (see
  // system-provider-composition-v1.yaml's own comment on this move). Both halves still need array
  // safety — this proves both, not just one.
  it('staff_license/staff_hprid/staff_hpr_id_number (genuine identifiers) survive as a real 3-element identifier array', () => {
    const response = staffAnswer(
      answered('staff_name', 'Dr. Nine Fields'),
      answered('staff_license', 'LIC-1'),
      answered('staff_hprid', 'HPR-1'),
      answered('staff_hpr_id_number', 'HPRN-1'),
    );
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');

    expect(Array.isArray(practitioner.identifier)).toBe(true);
    expect(practitioner.identifier.map((i) => i.value).sort()).toEqual(['LIC-1', 'HPR-1', 'HPRN-1'].sort());
  });

  // UPDATE — was 6 fields including staff_abdm_role; SPEC-24 §2 real re-homing moved that field
  // off Practitioner.extension entirely (it's PractitionerRole.code now, a genuinely separate
  // resource — see system-provider-composition-v1.yaml's own section_staff_role comment and the
  // dedicated PractitionerRole test just below this one), leaving 5 real Practitioner-level
  // ABDM-registration extensions here.
  it('the 5 ABDM-registration-process fields (hp_category/hp_subcategory/state/district/council) land as real, distinctly-URLed extensions, not bare identifiers', () => {
    const response = staffAnswer(
      answered('staff_name', 'Dr. Nine Fields'),
      answered('staff_hp_category_code', 'CAT-1'),
      answered('staff_hp_subcategory_code', 'SUB-1'),
      answered('staff_state_code', 'ST-1'),
      answered('staff_district_code', 'DT-1'),
      { linkId: 'staff_council', answer: [{ valueBoolean: true }] },
    );
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');

    expect(Array.isArray(practitioner.extension)).toBe(true);
    expect(practitioner.extension.length).toBe(5);
    const byUrl = Object.fromEntries(practitioner.extension.map((e) => [e.url, e]));
    expect(byUrl['https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-category-code'].valueString).toBe('CAT-1');
    expect(byUrl['https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-registered-with-council'].valueBoolean).toBe(true);
  });

  it('SPEC-24 §2: staff_provider_role/staff_role_active (section_staff_role, a sibling block) extract to a real, separate PractitionerRole resource, auto-linked to the Practitioner and Organization from the same submission', () => {
    const response = {
      item: [
        { linkId: 'section_hospital', item: [answered('hospital_name', 'ABC Hospital')] },
        { linkId: 'section_staff', item: [{ linkId: 'section_staff', item: [answered('staff_name', 'Dr. Role Test')] }] },
        { linkId: 'section_staff_role', item: [
          answered('staff_provider_role', 'Facility Manager'),
          { linkId: 'staff_role_active', answer: [{ valueBoolean: true }] },
        ] },
      ],
    };
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const org = result.find((r) => r.resourceType === 'Organization');
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');
    const role = result.find((r) => r.resourceType === 'PractitionerRole');

    // Role vs entitlement: the HPR role is an entitlement source, kept as its own extension —
    // never PractitionerRole.code, which is the SNOMED professional role (none captured here).
    expect(role.extension).toEqual([{ url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-role', valueString: 'Facility Manager' }]);
    expect(role.code).toBeUndefined();
    expect(role.active).toBe(true);
    expect(role.practitioner.reference).toBe(`Practitioner/${practitioner.id}`);
    expect(role.organization.reference).toBe(`Organization/${org.id}`);
    expect(practitioner.extension).toBeUndefined(); // the old, wrong Practitioner.extension home is gone, not just unused
  });

  it('REGRESSION: a MultiSelect field with multiple selections keeps ALL of them, not just the first', () => {
    const response = staffAnswer(
      answered('staff_name', 'Dr. Multi Test'),
      { linkId: 'staff_specialty', answer: [{ valueString: 'Cardiology' }, { valueString: 'Pediatrics' }, { valueString: 'Radiology' }] },
    );
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');

    expect(Array.isArray(practitioner.extension)).toBe(true);
    expect(practitioner.extension.length).toBe(3);
  });

  it('Practitioner.name.given (first + middle name, same field family, different linkIds) both land in the SAME name entry, not two different ones', () => {
    const response = staffAnswer(
      answered('staff_name', 'Dr. Given Test'),
      answered('staff_first_name', 'Alpha'),
      answered('staff_middle_name', 'Beta'),
      answered('staff_last_name', 'Gamma'),
    );
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');

    // Practitioner.name itself stays a single real entry (this app only ever captures one name
    // per person) — .given WITHIN it is the genuinely multi-value part.
    expect(practitioner.name[0].text).toBe('Dr. Given Test');
    expect(practitioner.name[0].given.sort()).toEqual(['Alpha', 'Beta'].sort());
    expect(practitioner.name[0].family).toBe('Gamma');
  });

  // UPDATE — ownership/facility-type/facility-subtype moved off the generic Organization.type
  // (they're real HFR registry codes, not a good CodeableConcept classification fit) onto real,
  // distinctly-URLed Organization.extension entries — this test now proves that move, not the old
  // 4-way Organization.type collision it originally covered (hospital_type alone stays there,
  // confirmed still correct).
  it('hospital_ownership_code/facility_type/facility_subtype land as real, distinctly-URLed Organization extensions; hospital_type (the only real Organization.type field left) is unaffected', () => {
    const response = {
      item: [
        { linkId: 'section_hospital', item: [
          answered('hospital_name', 'Test Hospital'),
          answered('hospital_type', 'Hospital'),
        ]},
        { linkId: 'section_hospital_abdm_facility_type', item: [
          answered('hospital_ownership_code', 'OWN-1'),
          answered('hospital_facility_type', 'FT-1'),
          answered('hospital_facility_subtype', 'FST-1'),
        ]},
      ],
    };
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const org = result.find((r) => r.resourceType === 'Organization');

    // Organization.type is genuinely 0..* in real FHIR — correctly a real 1-element array now
    // (not a bare string), even with only one field left targeting it; no longer a collision case.
    expect(org.type).toEqual([{ text: 'Hospital' }]);
    expect(Array.isArray(org.extension)).toBe(true);
    expect(org.extension.length).toBe(3);
    const byUrl = Object.fromEntries(org.extension.map((e) => [e.url, e]));
    expect(byUrl['https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-ownership-code'].valueString).toBe('OWN-1');
    expect(byUrl['https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-facility-type'].valueString).toBe('FT-1');
    expect(byUrl['https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-facility-subtype'].valueString).toBe('FST-1');
    expect(org.name).toBe('Test Hospital'); // Organization.name is genuinely 0..1 — confirms non-array paths are unaffected
  });

  it('Appointment.participant.actor (appt_patient + appt_staff, both real fields) survive as two separate participants, not one overwriting the other', () => {
    const response = {
      item: [{ linkId: 'section_appointment', item: [{ linkId: 'section_appointment', item: [
        answered('appt_patient', 'Patient/pat-1'),
        answered('appt_staff', 'Practitioner/prac-1'),
        answered('appt_status', 'booked'),
      ]}]}],
    };
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const appt = result.find((r) => r.resourceType === 'Appointment');

    expect(Array.isArray(appt.participant)).toBe(true);
    expect(appt.participant.map((p) => p.actor).sort()).toEqual(['Patient/pat-1', 'Practitioner/prac-1'].sort());
  });
});

// "in case any field is not found in the FHIR spec needed for ABDM capture, that as part of the
// extension fields" (explicit instruction). Real FHIR extension shape ({url, value[x]}), not a
// bare value — proven directly here (synthetic fixtures) before applying it to the real ABDM
// fields in system-provider-composition-v1.yaml.
describe('ComprehensiveLocalExtractor — real FHIR extension.url tagging', () => {
  function itemWithExtensionUrl(linkId, path, extensionUrl, type = 'string') {
    return { linkId, definition: `http://hl7.org/Organization#${path}`, type, extensionUrl };
  }

  it('writes a real {url, valueString} extension, not a bare value', () => {
    const bp = blueprint([itemWithExtensionUrl('ownership', 'Organization.extension', 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-ownership-code')]);
    const response = { item: [answered('ownership', 'P')] };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const org = result.find((r) => r.resourceType === 'Organization');

    expect(Array.isArray(org.extension)).toBe(true);
    expect(org.extension[0]).toEqual({
      url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-ownership-code',
      valueString: 'P',
    });
  });

  it('two DIFFERENT extension fields produce two distinct, correctly-tagged entries — not one overwriting the other', () => {
    const bp = blueprint([
      itemWithExtensionUrl('ownership', 'Organization.extension', 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-ownership-code'),
      itemWithExtensionUrl('facilityType', 'Organization.extension', 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-facility-type'),
    ]);
    const response = { item: [answered('ownership', 'P'), answered('facilityType', 'HOSPITAL')] };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const org = result.find((r) => r.resourceType === 'Organization');

    expect(org.extension.length).toBe(2);
    const byUrl = Object.fromEntries(org.extension.map((e) => [e.url, e]));
    expect(byUrl['https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-ownership-code'].valueString).toBe('P');
    expect(byUrl['https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-facility-type'].valueString).toBe('HOSPITAL');
  });

  it('picks the real matching value[x] key from the answer\'s own FHIR type — valueBoolean for a boolean answer', () => {
    const bp = blueprint([itemWithExtensionUrl('council', 'Practitioner.extension', 'https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-registered-with-council', 'boolean')]);
    const response = { item: [{ linkId: 'council', answer: [{ valueBoolean: true }] }] };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const practitioner = result.find((r) => r.resourceType === 'Practitioner');

    expect(practitioner.extension[0]).toEqual({
      url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-registered-with-council',
      valueBoolean: true,
    });
  });

  it('an extension field with NO extensionUrl declared falls back to the old bare-value behavior (fails safe, never guesses a URL)', () => {
    const bp = blueprint([{ linkId: 'raw', definition: 'http://hl7.org/Organization#Organization.extension', type: 'string' }]); // no extensionUrl
    const response = { item: [answered('raw', 'unlabeled')] };

    const result = ComprehensiveLocalExtractor.extract(bp, response);
    const org = result.find((r) => r.resourceType === 'Organization');

    expect(org.extension[0]).toBe('unlabeled'); // bare value, exactly the pre-existing behavior
  });
});

describe('ComprehensiveLocalExtractor — real end-to-end against the improved Facility/Provider FHIR mapping', () => {
  const providerYaml = fs.readFileSync(
    path.join(process.cwd(), 'tools', 'system-forms', 'system-provider-composition-v1.yaml'),
    'utf8'
  );
  const compiledProvider = compileYamlToQuestionnaire(providerYaml);

  // REGRESSION: found live via a full end-to-end pipeline run, not caught reading the YAML alone
  // — hospital_operational_status was `uiComponent: Dropdown` with string choices despite mapping
  // to Organization.active (a real FHIR boolean), producing a structurally invalid
  // `active: "Functional"` instead of `active: true`. staff_status (Practitioner.active) already
  // used Checkbox correctly — this was a real, live inconsistency, not by design.
  it('hospital_operational_status now produces a real boolean Organization.active, not a raw string', () => {
    const response = {
      item: [{ linkId: 'section_hospital_abdm_facility_type', item: [
        { linkId: 'hospital_operational_status', answer: [{ valueBoolean: true }] },
      ]}],
    };
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const org = result.find((r) => r.resourceType === 'Organization');
    expect(org.active).toBe(true);
    expect(typeof org.active).toBe('boolean');
  });

  it('a full Facility + Provider registration extracts to genuinely valid-shaped FHIR resources, with ABDM-specific codes correctly homed as real extensions, not generic identifiers', () => {
    function ans(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }
    const response = {
      item: [
        { linkId: 'section_hospital', item: [
          ans('hospital_name', 'Malar Hospital'),
          ans('hospital_type', 'Hospital'),
          ans('hospital_phone', '044-2222'),
          ans('hospital_email', 'contact@malar.example'),
        ]},
        { linkId: 'section_hospital_abdm_facility_type', item: [
          ans('hospital_ownership_code', 'P'),
          ans('hospital_facility_type', 'HOSPITAL'),
          { linkId: 'hospital_operational_status', answer: [{ valueBoolean: true }] },
        ]},
        { linkId: 'section_hospital_abdm_location', item: [
          ans('hospital_state_lgd_code', '33'),
          ans('hospital_district_lgd_code', '600'),
        ]},
        { linkId: 'section_staff', item: [{ linkId: 'section_staff', item: [
          ans('staff_name', 'Dr. Priya Rao'),
          ans('staff_license', 'MCI-12345'),
          ans('staff_hp_category_code', 'A'),
        ]}]},
      ],
    };
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    expect(result.warnings).toEqual([]);

    const org = result.find((r) => r.resourceType === 'Organization');
    const prac = result.find((r) => r.resourceType === 'Practitioner');

    // Real FHIR shape throughout — every multi-cardinality field a real array, every ABDM-only
    // code a real, distinctly-URLed extension, every genuine identifier/boolean/name field its
    // real FHIR type — not "close enough", genuinely valid for a real HAPI server.
    expect(org.name).toBe('Malar Hospital');
    expect(Array.isArray(org.type)).toBe(true);
    expect(Array.isArray(org.telecom)).toBe(true);
    expect(org.active).toBe(true);
    expect(Array.isArray(org.extension)).toBe(true);
    expect(org.extension.every((e) => e.url.startsWith('https://clinux.yaxb.ai/fhir/StructureDefinition/'))).toBe(true);
    // No captured identifier fell back to the old catch-all: the only identifier is the ABDM IG's
    // required one (min 1), ClinuxFlow's own typed record id, until HFR issues a facility id.
    expect(org.identifier).toEqual([{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PRN', display: 'Provider number' }], text: 'Provider number' }, system: 'https://clinux.yaxb.ai/fhir/sid/clinic', value: org.id }]);

    expect(prac.name[0].text).toBe('Dr. Priya Rao');
    expect(Array.isArray(prac.identifier)).toBe(true);
    expect(prac.identifier[0].value).toBe('MCI-12345'); // the genuine license identifier, alone — not mixed with ABDM codes
    // ...and typed as the ABDM IG requires (data/ig-conformance.json slice licenseNumber: v2-0203 MD).
    expect(prac.identifier[0].type.coding[0]).toMatchObject({ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MD' });
    expect(Array.isArray(prac.extension)).toBe(true);
    expect(prac.extension.every((e) => e.url.startsWith('https://clinux.yaxb.ai/fhir/StructureDefinition/'))).toBe(true);
  });

  // Services/Staff scoped to a branch, not the facility root (design call) — service_location_id
  // (HealthcareService.location, single) and staff_location_ids (PractitionerRole.location,
  // 0..*) against the REAL compiled YAML, not a synthetic fixture, since the whole point is
  // proving refTo's index-correlation actually resolves to the RIGHT branch out of several, not
  // just index 0 by luck.
  it('service_location_id resolves to the SECOND of two branches, correctly correlated by submission index, not just whichever Location happened to extract first', () => {
    function ans(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }
    const response = {
      item: [
        { linkId: 'section_hospital', item: [ans('hospital_name', 'Malar Hospital')] },
        { linkId: 'section_location', item: [ans('location_name', 'Main Branch')] },
        { linkId: 'section_location', item: [ans('location_name', 'Satellite Branch')] },
        { linkId: 'section_services_matrix', item: [
          ans('service_name', 'Dialysis'),
          ans('service_location_id', '1'), // Satellite Branch — index 1, not 0
        ]},
      ],
    };
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    expect(result.warnings).toEqual([]);

    const locations = result.filter((r) => r.resourceType === 'Location');
    const service = result.find((r) => r.resourceType === 'HealthcareService');
    const satellite = locations.find((l) => l.name === 'Satellite Branch');

    expect(locations.length).toBe(2);
    expect(Array.isArray(service.location)).toBe(true);
    expect(service.location).toEqual([{ reference: `Location/${satellite.id}` }]);
  });

  it('staff_location_ids (MultiSelect) resolves to references for BOTH selected branches on the real PractitionerRole resource', () => {
    function ans(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }
    const response = {
      item: [
        { linkId: 'section_hospital', item: [ans('hospital_name', 'Malar Hospital')] },
        { linkId: 'section_location', item: [ans('location_name', 'Main Branch')] },
        { linkId: 'section_location', item: [ans('location_name', 'Satellite Branch')] },
        { linkId: 'section_staff', item: [ans('staff_name', 'Dr. Priya Rao')] },
        { linkId: 'section_staff_role', item: [
          ans('staff_location_ids', '0'),
          ans('staff_location_ids', '1'),
        ]},
      ],
    };
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    expect(result.warnings).toEqual([]);

    const locations = result.filter((r) => r.resourceType === 'Location');
    const role = result.find((r) => r.resourceType === 'PractitionerRole');
    const [main, satellite] = ['Main Branch', 'Satellite Branch'].map((n) => locations.find((l) => l.name === n));

    expect(role.location).toEqual(expect.arrayContaining([
      { reference: `Location/${main.id}` },
      { reference: `Location/${satellite.id}` },
    ]));
    expect(role.location.length).toBe(2);
  });

  it('a branch reference to an index that does not exist in this document drops with a warning, instead of writing a broken reference', () => {
    function ans(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }
    const response = {
      item: [
        { linkId: 'section_hospital', item: [ans('hospital_name', 'Malar Hospital')] },
        { linkId: 'section_services_matrix', item: [
          ans('service_name', 'Dialysis'),
          ans('service_location_id', '0'), // no section_location instance exists at all
        ]},
      ],
    };
    const result = ComprehensiveLocalExtractor.extract(compiledProvider.questionnaire, response);
    const service = result.find((r) => r.resourceType === 'HealthcareService');

    expect(service.location).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('Location#0'))).toBe(true);
  });
});

describe('ComprehensiveLocalExtractor — professional role vs entitlement (ABDM IG)', () => {
    it('codes PractitionerRole.code in SNOMED CT from the staff member\'s HPR category, and keeps the HPR role as an extension', async () => {
        const { default: lib } = await import('../../../data/system-forms-library.json', { with: { type: 'json' } });
        const q = Object.values(lib['system-provider-composition-v1'].versions).at(-1).questionnaire;
        const response = {
            resourceType: 'QuestionnaireResponse',
            item: [
                { linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'Asha Clinic' }] }] },
                { linkId: 'section_staff', item: [
                    { linkId: 'staff_first_name', answer: [{ valueString: 'Meera' }] },
                    { linkId: 'staff_hp_category_code', answer: [{ valueString: '2' }] },
                ] },
                { linkId: 'section_staff_role', item: [
                    { linkId: 'staff_provider_role', answer: [{ valueString: 'Facility Manager' }] },
                ] },
            ],
        };
        const role = ComprehensiveLocalExtractor.extract(q, response).find((r) => r.resourceType === 'PractitionerRole');
        expect(role.code).toEqual([{ coding: [{ system: 'http://snomed.info/sct', code: '106292003', display: 'Professional nurse' }], text: 'Professional nurse' }]);
        expect(role.extension).toEqual([{ url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-role', valueString: 'Facility Manager' }]);
    });
});
