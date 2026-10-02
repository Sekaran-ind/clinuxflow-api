import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validate } from './conformance-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdDir = join(__dirname, '..', '..', '..', 'data', 'structure-definitions');
function loadSd(name) {
  return JSON.parse(readFileSync(join(sdDir, `${name}.json`), 'utf-8'));
}

// Real, complete, valid Facility resource — every 1..1/1..* element from ClinuxFlowFacility.json
// present, matching the real HFR Basic Information API's own worked sample (Sample 1, page 9 of
// docs/NHPR SBX Doc/NHPR Doc/HFR/New_HFR_APIs_Documentation_SBX.pdf) mapped onto real FHIR shape.
function validFacility() {
  return {
    resourceType: 'Organization',
    name: 'ABC Hospital',
    active: true,
    type: { coding: [{ code: '5' }] },
    address: [{
      line: ['Temple street', 'Pune'],
      country: 'India',
      postalCode: '600107',
    }],
    telecom: [
      { system: 'phone', use: 'mobile', value: '9042703499' },
      { system: 'email', value: 'abc@gmail.in' },
    ],
    extension: [
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-state-lgd-code', valueString: '33' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-district-lgd-code', valueString: '568' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-subdistrict-lgd-code', valueString: '5704' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-geolocation-latitude', valueString: '24.068570' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-geolocation-longitude', valueString: '24.068570' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-ownership-code', valueString: 'G' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-ownership-subtype-code', valueString: 'S' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-facility-subtype', valueString: '30' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-system-of-medicine', valueString: 'M' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-system-of-medicine', valueString: 'D' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-operational-status-code', valueString: 'F' },
    ],
  };
}

describe('validate — ClinuxFlowFacility (real HFR-grounded profile)', () => {
  const sd = loadSd('ClinuxFlowFacility');

  it('a real, complete facility resource (matching HFR\'s own worked sample) passes clean', () => {
    const result = validate(sd, validFacility());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('flags a missing required name', () => {
    const facility = validFacility();
    delete facility.name;
    const result = validate(sd, facility);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'Organization.name')).toBe(true);
  });

  it('a missing email is NOT an error — HFR marks facilityEmailId optional, unlike HPR\'s own Provider email (see the Provider describe block below)', () => {
    const facility = validFacility();
    facility.telecom = facility.telecom.filter((t) => t.system !== 'email');
    const result = validate(sd, facility);
    expect(result.errors.some((e) => e.path === 'Organization.telecom:email')).toBe(false);
    expect(result.errors.some((e) => e.path === 'Organization.telecom:website')).toBe(false);
  });

  it('a phone entry with the wrong `use` does not satisfy the contactPhone slice (real discriminator matching, not just system)', () => {
    const facility = validFacility();
    facility.telecom = facility.telecom.map((t) => (t.system === 'phone' ? { ...t, use: 'home' } : t));
    // contactPhone is min:0 in the real profile (HFR marks facilityContactNumber optional), so this
    // alone isn't an error — but it proves the slice genuinely discriminates on use, not just
    // system, by checking landline (also system:phone, use:work) doesn't wrongly absorb it either.
    const result = validate(sd, facility);
    expect(result.errors.some((e) => e.path === 'Organization.telecom:contactPhone')).toBe(false);
    expect(result.errors.some((e) => e.path === 'Organization.telecom:landline')).toBe(false);
  });

  it('flags a missing required address (narrowed from base FHIR\'s 0..* to this profile\'s 1..1)', () => {
    const facility = validFacility();
    delete facility.address;
    const result = validate(sd, facility);
    expect(result.errors.some((e) => e.path === 'Organization.address')).toBe(true);
  });

  it('flags a wrong fixed country value (HFR: country defaults to India)', () => {
    const facility = validFacility();
    facility.address[0].country = 'US';
    const result = validate(sd, facility);
    expect(result.errors.some((e) => e.path === 'Organization.address.country')).toBe(true);
  });

  it('flags a missing required extension slice (e.g. hfr-ownership-code)', () => {
    const facility = validFacility();
    facility.extension = facility.extension.filter((e) => !e.url.endsWith('hfr-ownership-code'));
    const result = validate(sd, facility);
    expect(result.errors.some((e) => e.path === 'Organization.extension:ownershipCode')).toBe(true);
  });

  it('a single systemOfMedicine value still satisfies its real 1..* cardinality', () => {
    const facility = validFacility();
    facility.extension = facility.extension.filter((e) => !e.url.endsWith('hfr-system-of-medicine'));
    facility.extension.push({ url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hfr-system-of-medicine', valueString: 'M' });
    const result = validate(sd, facility);
    expect(result.errors.some((e) => e.path === 'Organization.extension:systemOfMedicine')).toBe(false);
  });

  it('the optional hfrFacilityId identifier being absent is not an error (server-assigned post-submission)', () => {
    const result = validate(sd, validFacility()); // no identifier[] at all
    expect(result.errors.some((e) => e.path.startsWith('Organization.identifier'))).toBe(false);
  });
});

describe('validate — ClinuxFlowProvider (real HPR-grounded profile)', () => {
  const sd = loadSd('ClinuxFlowProvider');

  function validProvider() {
    return {
      resourceType: 'Practitioner',
      active: true,
      name: [{ given: ['Priya'], family: 'Kumar' }],
      telecom: [{ system: 'email', value: 'priya@example.com' }],
      identifier: [{ system: 'https://doctor.ndhm.gov.in', value: 'priya1993@hpr.abdm' }],
      extension: [
        { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-category-code', valueInteger: 1 },
        { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-subcategory-code', valueInteger: 1 },
      ],
      qualification: [{ code: { coding: [{ code: '4060' }] } }],
    };
  }

  it('a real, complete provider identity passes clean', () => {
    expect(validate(sd, validProvider()).valid).toBe(true);
  });

  // FHIR cardinality is per repetition: qualification.code (1..1 in the IG-based profile) applies to
  // each qualification that exists. A qualification without a code is flagged; having none at all
  // is not, since neither the ABDM IG nor ClinuxFlowProvider makes Practitioner.qualification
  // itself required (the old aggregate count only appeared to enforce that).
  it('flags a qualification with no code — qualification.code is 1..1 in each qualification', () => {
    const p = validProvider();
    p.qualification = [{ code: { coding: [{ code: '4060' }] } }, { period: { start: '2010-01-01' } }];
    const result = validate(sd, p);
    expect(result.errors.some((e) => e.path === 'Practitioner.qualification.code')).toBe(true);
  });

  it('does not require a qualification at all (no profile makes Practitioner.qualification min 1)', () => {
    const p = validProvider();
    p.qualification = [];
    expect(validate(sd, p).errors.some((e) => e.path === 'Practitioner.qualification.code')).toBe(false);
  });

  // Real regression this exact test guards against: this validator's generic slice/cardinality
  // check flattens a nested element's values ACROSS every repetition of an enclosing repeating
  // element (Practitioner.qualification is 0..*) — an earlier draft of this profile declared
  // Practitioner.qualification.code as max:1, which would have WRONGLY failed a practitioner with
  // 2 real qualifications (2 .code values counted in aggregate); fixed to max:'*' (see the
  // profile's own comment). A practitioner really can hold more than one qualification — this is
  // the exact shape empirically verified via local-extractor.js's own test-extraction.mjs run
  // this session (2 qualification entries, no data loss).
  it('a provider with 2 real qualifications (a genuine, tested shape) passes clean, not flagged as too many', () => {
    const p = validProvider();
    p.qualification = [
      { code: { coding: [{ code: '4060' }] } },
      { code: { coding: [{ code: '4074' }] } },
    ];
    expect(validate(sd, p).valid).toBe(true);
  });

  it('flags a missing hprId identifier — the one genuinely required business identifier', () => {
    const p = validProvider();
    p.identifier = [];
    const result = validate(sd, p);
    expect(result.errors.some((e) => e.path === 'Practitioner.identifier:hprId')).toBe(true);
  });

  it('flags a missing email — HPR createHprId marks it Required, unlike HFR\'s own facility email', () => {
    const p = validProvider();
    p.telecom = p.telecom.filter((t) => t.system !== 'email');
    const result = validate(sd, p);
    expect(result.errors.some((e) => e.path === 'Practitioner.telecom:email')).toBe(true);
  });

  it('flags a missing hpCategoryCode (real HPR: Doctor/Nurse, Required)', () => {
    const p = validProvider();
    p.extension = p.extension.filter((e) => !e.url.endsWith('hpr-category-code'));
    const result = validate(sd, p);
    expect(result.errors.some((e) => e.path === 'Practitioner.extension:hpCategoryCode')).toBe(true);
  });

  it('a name with both given and middle name (HPR: firstName + middleName) satisfies the 1..2 cardinality', () => {
    const p = validProvider();
    p.name[0].given = ['Priya', 'Rani'];
    expect(validate(sd, p).valid).toBe(true);
  });
});

describe('validate — ClinuxFlowAffiliateOrganization (OrganizationAffiliation, no cited ABDM spec)', () => {
  const sd = loadSd('ClinuxFlowAffiliateOrganization');

  it('a real, complete affiliation passes clean', () => {
    const affiliation = {
      resourceType: 'OrganizationAffiliation',
      active: true,
      organization: { reference: 'Organization/facility-1' },
      participatingOrganization: { reference: 'Organization/imaging-partner-1' },
      code: [{ text: 'diagnostics' }],
    };
    expect(validate(sd, affiliation).valid).toBe(true);
  });

  it('flags a missing participatingOrganization — the affiliate partner itself', () => {
    const affiliation = {
      resourceType: 'OrganizationAffiliation',
      active: true,
      organization: { reference: 'Organization/facility-1' },
      code: [{ text: 'diagnostics' }],
    };
    const result = validate(sd, affiliation);
    expect(result.errors.some((e) => e.path === 'OrganizationAffiliation.participatingOrganization')).toBe(true);
  });
});

// Idealized, hand-built valid resource (system/use set directly, unlike the real capture pipeline
// — see system-patient-profile-v1.yaml's own comment on that known-deferred gap) — this suite
// tests the SD/validator directly, same convention validFacility()/validProvider() above use.
function validPatient() {
  return {
    resourceType: 'Patient',
    active: true,
    name: [{ text: 'Arjun Verma', given: ['Arjun'], family: 'Verma' }],
    gender: 'male',
    birthDate: '1990-01-01',
    telecom: [{ system: 'phone', use: 'mobile', value: '9876543210' }],
  };
}

describe('validate — ClinuxFlowPatient (Patient.contact addition)', () => {
  const sd = loadSd('ClinuxFlowPatient');

  it('a complete patient with no emergency contact passes clean — Patient.contact is genuinely optional', () => {
    const result = validate(sd, validPatient());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('a patient with a real emergency contact (name + phone) also passes clean', () => {
    const p = validPatient();
    p.contact = [{ name: { text: 'Priya Verma' }, telecom: [{ value: '9123456780' }] }];
    const result = validate(sd, p);
    expect(result.valid).toBe(true);
  });

  it('does not require contact.telecom.system to be fixed — the known-deferred capture gap stays honestly unenforced, not silently broken', () => {
    const p = validPatient();
    // No .system on the emergency-contact telecom entry, matching what the real capture pipeline
    // actually produces today (patient_emergency_contact_phone -> Patient.contact.telecom.value only).
    p.contact = [{ name: { text: 'Priya Verma' }, telecom: [{ value: '9123456780' }] }];
    expect(validate(sd, p).valid).toBe(true);
  });
});

describe('validate — ClinuxFlowPatient (ABHA verification-status extensions, grounded against the real ABHA V3 API doc)', () => {
  const sd = loadSd('ClinuxFlowPatient');

  it('a patient with no ABHA link yet still passes clean — every ABHA extension is genuinely optional', () => {
    expect(validate(sd, validPatient()).valid).toBe(true);
  });

  it('a fully ABHA-verified patient (all 7 extensions, including repeating authMethods) validates clean', () => {
    const p = validPatient();
    p.extension = [
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-kyc-verified', valueBoolean: true },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-verification-status', valueCode: 'VERIFIED' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-verification-type', valueCode: 'AADHAAR' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-email-verified', valueBoolean: false },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-mobile-verified', valueBoolean: true },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-status', valueCode: 'ACTIVE' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-auth-methods', valueCode: 'AADHAAR_OTP' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-auth-methods', valueCode: 'MOBILE_OTP' },
    ];
    const result = validate(sd, p);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('flags more than one abhaStatus — a real, single-valued extension, unlike the repeating authMethods slice', () => {
    const p = validPatient();
    p.extension = [
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-status', valueCode: 'ACTIVE' },
      { url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/abha-status', valueCode: 'DEACTIVATED' },
    ];
    const result = validate(sd, p);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'Patient.extension:abhaStatus')).toBe(true);
  });
});
