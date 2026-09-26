// The registry the new generic /api/resources/:resourceType/* routes (control.js) are driven by
// — one static entry per StructureDefinition-anchored resource this app persists/searches
// server-side. Patient is the only entry this pass; the shape itself is the point: onboarding a
// future entity (a Facility/Provider mirror, a future Observation, ...) onto search/save means
// adding an entry here, not writing a new route file — the real fix for control.js's own
// hand-copied facility/provider/affiliate-organization/patient conformance endpoints.
import clinuxFlowPatientSd from '../../../data/structure-definitions/ClinuxFlowPatient.json';
import clinuxFlowPatientGraph from '../../../data/graph-definitions/ClinuxFlowPatientGraph.json';

// FHIR_ARRAY_PATHS (local-extractor.js) makes Patient.telecom/.identifier real arrays but leaves
// Patient.name a plain nested object (not in that set) — so `name` here may be an object OR,
// defensively, an array (a future extractor change shouldn't silently break search). `given` is
// itself base-FHIR 0..*, so it may already be an array even inside a single name object.
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function patientSearchName(patient) {
  const name = asArray(patient.name)[0];
  if (!name) return null;
  const given = asArray(name.given).join(' ');
  const parts = [given, name.family].filter(Boolean).join(' ').trim();
  return parts || name.text || null;
}

function patientSearchMobile(patient) {
  // Known, already-documented gap (system-patient-profile-v1.yaml's own comment): captured
  // telecom entries never carry a .system/.use discriminator (the compiler has no mechanism to
  // co-locate one onto the same array element as the visible captured value), so this can't
  // filter by system==='phone' — Patient.telecom realistically holds exactly one entry (the
  // patient's own mobile) today, so the first value is the honest best-effort answer.
  const telecom = asArray(patient.telecom)[0];
  return telecom?.value || null;
}

function patientSearchIdentifier(patient) {
  // Same gap as above applies to identifier:abhaNumber/abhaAddress — neither slice's .system is
  // actually populated by extraction, so the two can't be told apart here either. Joining every
  // captured identifier value keeps a search for EITHER the ABHA number or the ABHA address
  // working, rather than guessing which one a lone entry is.
  return asArray(patient.identifier).map((i) => i.value).filter(Boolean).join(' ') || null;
}

export const RESOURCE_REGISTRY = {
  Patient: {
    structureDefinition: clinuxFlowPatientSd,
    graphDefinition: clinuxFlowPatientGraph,
    extractResourceType: 'Patient', // the resourceType ComprehensiveLocalExtractor.extract() output is filtered by
    searchFieldExtractor: (patient) => ({
      search_name: patientSearchName(patient),
      search_mobile: patientSearchMobile(patient),
      search_identifier: patientSearchIdentifier(patient),
    }),
  },
};

export function resourceConfig(resourceType) {
  return RESOURCE_REGISTRY[resourceType];
}
