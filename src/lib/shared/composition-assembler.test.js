import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FhirDocumentAssembler } from './composition-assembler.js';
import { ComprehensiveLocalExtractor } from './local-extractor.js';
import { compileYamlToQuestionnaire } from './yaml-to-questionnaire.js';

function answered(linkId, value) {
  return { linkId, answer: [{ valueString: value }] };
}

describe('FhirDocumentAssembler — required-field guards (FHIR Composition.title/.author are 1..1/1..*)', () => {
  const oneResource = [{ resourceType: 'Organization', id: 'org-1', name: 'Test' }];
  const validAuthor = { resourceType: 'Practitioner', id: 'prac-1' };

  it('throws without a title', () => {
    expect(() => FhirDocumentAssembler.assemble(oneResource, { authorRef: validAuthor })).toThrow(/title/i);
  });

  it('throws without an authorRef', () => {
    expect(() => FhirDocumentAssembler.assemble(oneResource, { title: 'Test Doc' })).toThrow(/author/i);
  });

  it('throws with zero resources — a document with no content is not a real document', () => {
    expect(() => FhirDocumentAssembler.assemble([], { title: 'Test Doc', authorRef: validAuthor })).toThrow(/at least one resource/i);
  });
});

describe('FhirDocumentAssembler — real FHIR document/Bundle shape', () => {
  const resources = [
    { resourceType: 'Organization', id: 'org-1', name: 'Test Hospital' },
    { resourceType: 'Location', id: 'loc-1', name: 'Main Branch' },
    { resourceType: 'HealthcareService', id: 'svc-1', name: 'Cardiology OPD' },
  ];
  const authorRef = { resourceType: 'Practitioner', id: 'prac-1' };

  it('produces a real Bundle, type "document" — not a bare Composition (the real FHIR sharing unit)', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, { title: 'Facility Registration', authorRef });
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('document');
  });

  it('entry[0] is the Composition; every OTHER entry is one of the real extracted resources', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, { title: 'Facility Registration', authorRef });
    expect(bundle.entry[0].resource.resourceType).toBe('Composition');
    const rest = bundle.entry.slice(1).map((e) => e.resource);
    expect(rest).toEqual(expect.arrayContaining(resources));
    expect(rest.length).toBe(resources.length);
  });

  it('FHIR document self-containment: every section.entry.reference in the Composition matches a REAL fullUrl actually present in the Bundle — nothing referenced that is not included', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, { title: 'Facility Registration', authorRef });
    const composition = bundle.entry[0].resource;
    const allFullUrls = new Set(bundle.entry.map((e) => e.fullUrl));

    const referencedUrls = composition.section.flatMap((s) => s.entry.map((e) => e.reference));
    expect(referencedUrls.length).toBeGreaterThan(0);
    referencedUrls.forEach((ref) => expect(allFullUrls.has(ref)).toBe(true));
  });

  it('required Composition fields are real, not placeholders — title/author/date/status/type all set', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, { title: 'Facility Registration', typeText: 'Facility Registration Document', authorRef, status: 'final' });
    const composition = bundle.entry[0].resource;
    expect(composition.title).toBe('Facility Registration');
    expect(composition.type).toEqual({ text: 'Facility Registration Document' });
    expect(composition.author).toEqual([{ reference: 'Practitioner/prac-1' }]);
    expect(composition.status).toBe('final');
    expect(typeof composition.date).toBe('string');
    expect(new Date(composition.date).toString()).not.toBe('Invalid Date');
  });

  it('defaults status to "preliminary" — never silently claims freshly-extracted, unattested data is "final"', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, { title: 'Facility Registration', authorRef });
    expect(bundle.entry[0].resource.status).toBe('preliminary');
  });

  it('subject is genuinely optional (FHIR Composition.subject is 0..1) — omitted, not defaulted, when not supplied', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, { title: 'Facility Registration', authorRef });
    expect(bundle.entry[0].resource.subject).toBeUndefined();
  });

  it('sets subject when supplied', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, { title: 'Facility Registration', authorRef, subjectRef: { resourceType: 'Organization', id: 'org-1' } });
    expect(bundle.entry[0].resource.subject).toEqual({ reference: 'Organization/org-1' });
  });

  it('one section per distinct resourceType, in first-seen order, by default', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, { title: 'Facility Registration', authorRef });
    const sectionTitles = bundle.entry[0].resource.section.map((s) => s.title);
    expect(sectionTitles).toEqual(['Organization', 'Location', 'HealthcareService']);
  });

  it('sectionPlan overrides grouping/titles/order, and drops an empty section rather than including an empty one', () => {
    const bundle = FhirDocumentAssembler.assemble(resources, {
      title: 'Facility Registration',
      authorRef,
      sectionPlan: [
        { title: 'Locations & Services', matchResourceTypes: ['Location', 'HealthcareService'] },
        { title: 'Facility Profile', matchResourceTypes: ['Organization'] },
        { title: 'Consents (none captured)', matchResourceTypes: ['Consent'] },
      ],
    });
    const sections = bundle.entry[0].resource.section;
    expect(sections.map((s) => s.title)).toEqual(['Locations & Services', 'Facility Profile']); // Consents section dropped — zero matching resources
    expect(sections[0].entry.length).toBe(2); // Location + HealthcareService
  });
});

describe('FhirDocumentAssembler — real, end-to-end against the actual Provider composition pipeline', () => {
  it('assembles a real document from a real Facility extraction (compile -> extract -> assemble, no synthetic fixtures)', () => {
    const yamlSource = fs.readFileSync(
      path.join(process.cwd(), 'tools', 'system-forms', 'system-provider-composition-v1.yaml'),
      'utf8'
    );
    const compiled = compileYamlToQuestionnaire(yamlSource);
    expect(compiled.success).toBe(true);

    const response = {
      item: [
        { linkId: 'section_hospital', item: [
          answered('hospital_name', 'Real Test Hospital'),
          answered('hospital_type', 'Hospital'),
          answered('hospital_phone', '555-1000'),
          answered('hospital_email', 'contact@realtesthospital.example'),
        ]},
        { linkId: 'section_location', item: [{ linkId: 'section_location', item: [
          answered('location_name', 'Main Branch'),
        ]}]},
      ],
    };
    const resources = ComprehensiveLocalExtractor.extract(compiled.questionnaire, response);
    expect(resources.warnings).toEqual([]);

    const org = resources.find((r) => r.resourceType === 'Organization');
    const bundle = FhirDocumentAssembler.assemble(resources, {
      title: 'Real Test Hospital — Facility Registration',
      typeText: 'Facility Registration Document',
      authorRef: { resourceType: 'Organization', id: org.id }, // the facility itself, asserting its own registration
      subjectRef: { resourceType: 'Organization', id: org.id },
    });

    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('document');
    expect(bundle.entry.length).toBe(resources.length + 1); // Composition + every extracted resource
    // Real, confirmed fix from earlier this session, still holding through the whole pipeline:
    // hospital_phone/hospital_email both survive as a real 2-element telecom array, not one
    // overwriting the other.
    expect(Array.isArray(org.telecom)).toBe(true);
    expect(org.telecom.map((t) => t.value).sort()).toEqual(['555-1000', 'contact@realtesthospital.example'].sort());
  });
});
