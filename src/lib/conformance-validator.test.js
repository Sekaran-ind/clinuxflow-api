import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validate } from './conformance-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdDir = join(__dirname, '..', '..', 'data', 'structure-definitions');
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
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-state-lgd-code', valueString: '33' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-district-lgd-code', valueString: '568' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-subdistrict-lgd-code', valueString: '5704' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-geolocation-latitude', valueString: '24.068570' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-geolocation-longitude', valueString: '24.068570' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-ownership-code', valueString: 'G' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-ownership-subtype-code', valueString: 'S' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-facility-subtype', valueString: '30' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-system-of-medicine', valueString: 'M' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-system-of-medicine', valueString: 'D' },
      { url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-operational-status-code', valueString: 'F' },
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
    facility.extension.push({ url: 'https://clinuxflow.example/fhir/StructureDefinition/hfr-system-of-medicine', valueString: 'M' });
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
      identifier: [{ system: 'https://facility.abdm.gov.in/hpr-id', value: 'priya1993@hpr.abdm' }],
      extension: [
        { url: 'https://clinuxflow.example/fhir/StructureDefinition/hpr-category-code', valueInteger: 1 },
        { url: 'https://clinuxflow.example/fhir/StructureDefinition/hpr-subcategory-code', valueInteger: 1 },
      ],
    };
  }

  it('a real, complete provider identity passes clean', () => {
    expect(validate(sd, validProvider()).valid).toBe(true);
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
