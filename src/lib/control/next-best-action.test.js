import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { nextBestActions } from './next-best-action.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const graphPath = join(__dirname, '..', '..', '..', 'data', 'graph-definitions', 'ClinuxFlowOnboardingGraph.json');
const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));

const valid = { valid: true, errors: [] };
const invalid = { valid: false, errors: [{ path: 'x', message: 'incomplete' }] };

const facility = { resourceType: 'Organization', id: 'org-1', name: 'ABC Hospital' };

describe('nextBestActions — reverse links (repeatable children of a valid facility)', () => {
  it('offers role-at-facility once the facility is valid, with both real PractitionerRole profiles', () => {
    const actions = nextBestActions(graph, [facility], { 'org-1': valid });
    const role = actions.find((a) => a.linkId === 'role-at-facility');
    expect(role).toEqual({
      resourceType: 'PractitionerRole',
      profiles: ['ClinuxFlowProviderRole', 'ClinuxFlowAffiliatePractitionerRole'],
      reason: graph.link.find((l) => l.sourceId === 'role-at-facility').description,
      linkId: 'role-at-facility',
      sourceResourceId: 'org-1',
    });
  });

  it('offers affiliation-from-facility with its single real profile', () => {
    const actions = nextBestActions(graph, [facility], { 'org-1': valid });
    const affiliation = actions.find((a) => a.linkId === 'affiliation-from-facility');
    expect(affiliation.resourceType).toBe('OrganizationAffiliation');
    expect(affiliation.profiles).toEqual(['https://clinux.yaxb.ai/fhir/StructureDefinition/ClinuxFlowAffiliateOrganization']);
  });

  it('keeps offering role-at-facility even once one PractitionerRole already exists — staff onboarding is open-ended', () => {
    const existingRole = { resourceType: 'PractitionerRole', id: 'role-1', organization: { reference: 'Organization/org-1' } };
    const actions = nextBestActions(graph, [facility, existingRole], { 'org-1': valid });
    expect(actions.filter((a) => a.linkId === 'role-at-facility')).toHaveLength(1);
  });

  it('surfaces nothing for a facility that has not passed conformance validation yet', () => {
    const actions = nextBestActions(graph, [facility], { 'org-1': invalid });
    expect(actions).toEqual([]);
  });

  it('surfaces nothing for a facility with no validation entry at all', () => {
    const actions = nextBestActions(graph, [facility], {});
    expect(actions).toEqual([]);
  });
});

describe('nextBestActions — forward links (a single reference field, genuinely satisfiable)', () => {
  const validRole = { resourceType: 'PractitionerRole', id: 'role-1', organization: { reference: 'Organization/org-1' } };

  it('offers practitioner-behind-role while the role has no practitioner reference yet', () => {
    const actions = nextBestActions(graph, [facility, validRole], { 'org-1': valid, 'role-1': valid });
    const action = actions.find((a) => a.linkId === 'practitioner-behind-role');
    expect(action).toMatchObject({ resourceType: 'Practitioner', sourceResourceId: 'role-1' });
  });

  it('offers it again for a role whose practitioner reference points at nothing in the bundle', () => {
    const dangling = { ...validRole, practitioner: { reference: 'Practitioner/ghost' } };
    const actions = nextBestActions(graph, [facility, dangling], { 'org-1': valid, 'role-1': valid });
    expect(actions.some((a) => a.linkId === 'practitioner-behind-role')).toBe(true);
  });

  it('stops offering it once the referenced Practitioner actually exists in the bundle', () => {
    const linkedRole = { ...validRole, practitioner: { reference: 'Practitioner/pract-1' } };
    const practitioner = { resourceType: 'Practitioner', id: 'pract-1', name: [{ family: 'Rao' }] };
    const actions = nextBestActions(graph, [facility, linkedRole, practitioner], { 'org-1': valid, 'role-1': valid });
    expect(actions.some((a) => a.linkId === 'practitioner-behind-role')).toBe(false);
  });

  it('does not offer it for a role that has not itself passed conformance validation', () => {
    const actions = nextBestActions(graph, [facility, validRole], { 'org-1': valid, 'role-1': invalid });
    expect(actions.some((a) => a.linkId === 'practitioner-behind-role')).toBe(false);
  });

  it('mirrors the same forward logic for affiliate-partner-org', () => {
    const affiliation = { resourceType: 'OrganizationAffiliation', id: 'aff-1', organization: { reference: 'Organization/org-1' } };
    const openActions = nextBestActions(graph, [facility, affiliation], { 'org-1': valid, 'aff-1': valid });
    expect(openActions.find((a) => a.linkId === 'affiliate-partner-org')).toMatchObject({ resourceType: 'Organization', sourceResourceId: 'aff-1' });

    const partner = { resourceType: 'Organization', id: 'partner-1' };
    const resolvedAffiliation = { ...affiliation, participatingOrganization: { reference: 'Organization/partner-1' } };
    const closedActions = nextBestActions(graph, [facility, resolvedAffiliation, partner], { 'org-1': valid, 'aff-1': valid });
    expect(closedActions.some((a) => a.linkId === 'affiliate-partner-org')).toBe(false);
  });
});

describe('nextBestActions — multiple source instances and ordering', () => {
  it('produces an independent candidate per valid source instance of the same type', () => {
    const roleA = { resourceType: 'PractitionerRole', id: 'role-a', organization: { reference: 'Organization/org-1' } };
    const roleB = { resourceType: 'PractitionerRole', id: 'role-b', organization: { reference: 'Organization/org-1' } };
    const actions = nextBestActions(graph, [facility, roleA, roleB], { 'org-1': valid, 'role-a': valid, 'role-b': valid });
    const forRoleA = actions.filter((a) => a.linkId === 'practitioner-behind-role' && a.sourceResourceId === 'role-a');
    const forRoleB = actions.filter((a) => a.linkId === 'practitioner-behind-role' && a.sourceResourceId === 'role-b');
    expect(forRoleA).toHaveLength(1);
    expect(forRoleB).toHaveLength(1);
  });

  it('walks links in GraphDefinition order, so role-at-facility precedes affiliation-from-facility', () => {
    const actions = nextBestActions(graph, [facility], { 'org-1': valid });
    const linkIds = actions.map((a) => a.linkId);
    expect(linkIds.indexOf('role-at-facility')).toBeLessThan(linkIds.indexOf('affiliation-from-facility'));
  });
});

describe('nextBestActions — degenerate inputs', () => {
  it('returns an empty list for an empty bundle', () => {
    expect(nextBestActions(graph, [], {})).toEqual([]);
  });

  it('returns an empty list when the bundle is omitted entirely', () => {
    expect(nextBestActions(graph, undefined, {})).toEqual([]);
  });

  it('ignores a source resource with no id rather than crashing (nothing to key validationResults or a reference on)', () => {
    const idLess = { resourceType: 'Organization', name: 'No Id Yet' };
    expect(() => nextBestActions(graph, [idLess], {})).not.toThrow();
    expect(nextBestActions(graph, [idLess], {})).toEqual([]);
  });

  it('returns an empty list for a GraphDefinition with no links', () => {
    expect(nextBestActions({ ...graph, link: [] }, [facility], { 'org-1': valid })).toEqual([]);
  });
});

// ClinuxFlowPatientGraph.json — a second, real GraphDefinition instance run through this same
// pure walker with zero code changes (its own design goal — see the graph file's own header).
// One reverse link only: Patient -> Encounter.
const patientGraphPath = join(__dirname, '..', '..', '..', 'data', 'graph-definitions', 'ClinuxFlowPatientGraph.json');
const patientGraph = JSON.parse(readFileSync(patientGraphPath, 'utf-8'));

describe('nextBestActions — ClinuxFlowPatientGraph (reverse Patient -> Encounter link)', () => {
  const patient = { resourceType: 'Patient', id: 'pat-1', active: true };

  it('offers "capture an Encounter for this patient" once the Patient is valid', () => {
    const actions = nextBestActions(patientGraph, [patient], { 'pat-1': valid });
    expect(actions).toEqual([{
      resourceType: 'Encounter',
      profiles: [],
      reason: patientGraph.link[0].description,
      linkId: 'encounters-for-patient',
      sourceResourceId: 'pat-1',
    }]);
  });

  it('surfaces nothing for a patient that has not passed conformance validation yet', () => {
    expect(nextBestActions(patientGraph, [patient], { 'pat-1': invalid })).toEqual([]);
  });

  it('keeps offering it even once an Encounter already exists — a patient can always start another visit', () => {
    const existingEncounter = { resourceType: 'Encounter', id: 'enc-1', subject: { reference: 'Patient/pat-1' } };
    const actions = nextBestActions(patientGraph, [patient, existingEncounter], { 'pat-1': valid });
    expect(actions.filter((a) => a.linkId === 'encounters-for-patient')).toHaveLength(1);
  });
});
