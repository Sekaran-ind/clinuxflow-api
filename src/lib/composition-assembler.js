import { v4 as uuidv4 } from 'uuid';

// The real missing half of "ready to be stored in a HAPI server or shared as a FHIR Document
// Composition" (explicit build directive) — ComprehensiveLocalExtractor (local-extractor.js)
// already produces genuine, individually-valid FHIR resources; nothing before this bundled them
// into an actual shareable document. Confirmed via grep before writing this: no Composition
// assembly existed anywhere in the codebase (docs/SPEC-13-FHIR-WORKFLOW-DOCUMENTS-AND-
// CONFORMANCE.md's own §5 named this as the eventual next step, never built).
//
// A bare `Composition` resource is NOT the real FHIR sharing unit — per the FHIR spec itself,
// "a Composition resource by itself is only the 'cover sheet' for a set of associated resources...
// the standard mechanism for exchanging a set of resources as one unit is to package them as a
// Bundle with type=document, with the Composition as the first entry." This module builds that
// real document Bundle, not just a standalone Composition — every resource the Composition's own
// sections reference is guaranteed present as a Bundle entry, since both are built from the same
// extractor output array in one pass (the FHIR "document" invariant: every referenced resource
// must actually be included), using `urn:uuid:` fullUrls (FHIR's own convention for a document
// bundle whose resources don't have server-assigned URLs yet — this content isn't persisted to a
// FHIR server here, see clinux-spec23-speciality-room-fixed-anchors memory note for what's still
// open: composition-assembler.js not connected to a real HAPI server).
export class FhirDocumentAssembler {
    /**
     * @param {Object[]} resources - ComprehensiveLocalExtractor.extract()'s own output array
     *   (Organization/Location/Practitioner/HealthcareService/Patient/... — already real,
     *   individually-valid FHIR resources with a real `id`).
     * @param {Object} meta
     * @param {string} meta.title - Composition.title (required by FHIR — no invented default).
     * @param {string} meta.typeText - Composition.type.text. Deliberately plain text, not a
     *   fabricated LOINC/SNOMED code — this app's registration documents (Facility/Provider/
     *   Patient) don't map cleanly onto an existing LOINC document-type code, and asserting a
     *   coding system this app doesn't actually conform to would be worse than an honest text-only
     *   CodeableConcept. Revisit if a real code gets identified later.
     * @param {{resourceType: string, id: string}} meta.authorRef - Composition.author is FHIR-
     *   required (1..*); caller supplies who's asserting this content (e.g. the extracted
     *   Practitioner performing their own Provider onboarding, or a Device reference representing
     *   the ClinuxFlow system itself for Facility onboarding, where no Practitioner may exist yet
     *   in the same batch) — never silently invented here.
     * @param {{resourceType: string, id: string}} [meta.subjectRef] - Composition.subject is FHIR-
     *   OPTIONAL (0..1), not required — omitted if the caller doesn't supply one, not defaulted.
     * @param {string} [meta.status='preliminary'] - real FHIR Composition.status. Defaults to
     *   'preliminary' deliberately — SPEC-13 §5's own attestation framing ('final' means signed/
     *   attested) doesn't exist as a real workflow step yet; asserting 'final' on freshly-extracted,
     *   unattested onboarding data would be a false claim, not a convenience default.
     * @param {{title: string, matchResourceTypes: string[]}[]} [meta.sectionPlan] - which
     *   resourceTypes group into which named section, in what order. Defaults to one section per
     *   distinct resourceType present, titled with the resourceType's own name — real, honest,
     *   generic behavior for any extractor output, not hardcoded to one journey.
     * @returns {Object} a real FHIR Bundle, type: 'document'.
     */
    static assemble(resources, meta) {
        if (!meta || !meta.title) throw new Error('FhirDocumentAssembler.assemble: meta.title is required (FHIR Composition.title is 1..1).');
        if (!meta.authorRef || !meta.authorRef.resourceType || !meta.authorRef.id) {
            throw new Error('FhirDocumentAssembler.assemble: meta.authorRef {resourceType, id} is required (FHIR Composition.author is 1..*).');
        }
        if (!resources || resources.length === 0) {
            throw new Error('FhirDocumentAssembler.assemble: at least one resource is required — a document with no content is not a real document.');
        }

        const now = new Date().toISOString();

        // urn:uuid: fullUrls — real FHIR convention for a document Bundle whose resources haven't
        // been assigned server-side URLs yet (verified against local-extractor.js's own id shape:
        // `local-res-${uuid}` / `local-pat-${uuid}` / `practitioner-<hash>` — not all are literal
        // UUIDs, so a fresh uuid is minted per resource for the fullUrl/reference pairing here
        // rather than assuming resource.id itself is always UUID-shaped).
        const fullUrlByResource = new Map();
        resources.forEach((r) => fullUrlByResource.set(r, `urn:uuid:${uuidv4()}`));
        function refFor(resource) {
            return { reference: fullUrlByResource.get(resource), type: resource.resourceType };
        }

        // One section per distinct resourceType present, in first-seen order — real, generic
        // behavior, not hardcoded to Facility/Provider/Patient specifically, so the SAME assembler
        // serves all three journeys. `meta.sectionPlan` lets a caller override grouping/titles/
        // order when it wants to (e.g. splitting Organization's own 4-merged-block content from
        // Location), but nothing here REQUIRES the caller to specify one.
        const sections = meta.sectionPlan
            ? meta.sectionPlan.map((plan) => ({
                title: plan.title,
                entry: resources.filter((r) => plan.matchResourceTypes.includes(r.resourceType)).map(refFor),
            })).filter((s) => s.entry.length > 0)
            : Array.from(new Set(resources.map((r) => r.resourceType))).map((resourceType) => ({
                title: resourceType,
                entry: resources.filter((r) => r.resourceType === resourceType).map(refFor),
            }));

        const composition = {
            resourceType: 'Composition',
            id: uuidv4(),
            status: meta.status || 'preliminary',
            type: { text: meta.typeText || meta.title },
            date: now,
            author: [{ reference: `${meta.authorRef.resourceType}/${meta.authorRef.id}` }],
            title: meta.title,
            ...(meta.subjectRef ? { subject: { reference: `${meta.subjectRef.resourceType}/${meta.subjectRef.id}` } } : {}),
            section: sections,
        };
        const compositionFullUrl = `urn:uuid:${uuidv4()}`;

        return {
            resourceType: 'Bundle',
            type: 'document',
            identifier: { system: 'urn:ietf:rfc:3986', value: `urn:uuid:${uuidv4()}` },
            timestamp: now,
            entry: [
                { fullUrl: compositionFullUrl, resource: composition },
                ...resources.map((r) => ({ fullUrl: fullUrlByResource.get(r), resource: r })),
            ],
        };
    }
}
