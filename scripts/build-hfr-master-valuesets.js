// Precomputes real FHIR CodeSystem+ValueSet resources for the small, stable HFR (Health Facility
// Registry) master-data types ClinuxFlowFacility.json's coded extension fields are bound to —
// same treatment data/condition-types.json already gets (see build-condition-types.js), and the
// same reasoning: Workers has no live network call budget/reliability guarantee suitable for a
// dropdown's own data source, so a real, versioned, pre-expanded artifact is bundled at build
// time instead of live-fetched on every render.
//
// Source: clinuxflow-abdm-gateway's own GET /hfr/master/data?type=X (the real ABDM sandbox,
// through the gateway's existing KV cache) — NOT a static config file the way clinic-specialities
// is, because these codes genuinely come from a live government registry, not something authored
// in this repo. Deliberately scoped to types confirmed small/stable/reliably-fetchable this
// session (verified live, not assumed) — OWNER, FAC-STATUS, TYPE-SERVICE, MEDICINE, PROFIT-TYPE,
// NON-PROFIT-TYPE, SPECIALITY-TYPE, FACILITY-REGION. Deliberately EXCLUDES:
//   - LGD states/districts/subdistricts — a live, hierarchical, India-wide lookup (thousands of
//     rows across 3 cascading levels), not a small enumerated list; stays a real cascading API
//     call in FacilityHfrPanel.vue (GET /hfr/master/lgd/...), not a static ValueSet — the correct
//     FHIR answer for a large/external code system is a `compose.include.system` reference, not a
//     bundled `expansion.contains`, and this app doesn't need the mechanics of that distinction
//     built out for a field that already works correctly as a live lookup.
//   - Facility type / facility sub-type / ownership sub-type — the real dedicated ABDM endpoints
//     (fetch-facility-type / fetch-facility-Sub-type / get-owner-subtype) are returning real
//     HIS-500 errors on the live sandbox as of this build (confirmed live, retried, not
//     transient in the moment) — no reliable source to build a ValueSet FROM yet. Re-run this
//     script once ABDM's sandbox recovers; ClinuxFlowFacility.json's own comments already flag
//     these fields' real master-data source, so wiring the binding later is a one-line addition,
//     not a redesign.
//
// Run manually whenever ABDM's master data changes, or once the currently-broken endpoints
// above recover:
//   node scripts/build-hfr-master-valuesets.js
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const GATEWAY_BASE = process.env.ABDM_GATEWAY_BASE || 'http://localhost:8788';
const SERVICE_KEY = process.env.ABDM_GATEWAY_SERVICE_KEY || 'dev-local-shared-secret';

// type -> { title, description } — the CodeSystem's own human-readable framing; the concepts
// themselves come from the live fetch below, not authored here.
const TYPES = {
    OWNER: { title: 'HFR Ownership', description: 'Ownership of the facility (HFR get-master-data type=OWNER) — Organization.extension:ownershipCode.' },
    'FAC-STATUS': { title: 'HFR Facility Operational Status', description: 'Coded operational status (HFR get-master-data type=FAC-STATUS) — Organization.extension:operationalStatusCode.' },
    'TYPE-SERVICE': { title: 'HFR Type of Service', description: 'Type of service offered (HFR get-master-data type=TYPE-SERVICE) — Organization.extension:typeOfServiceCode.' },
    MEDICINE: { title: 'HFR System of Medicine', description: 'System(s) of medicine practiced (HFR get-master-data type=MEDICINE) — Organization.extension:systemOfMedicine.' },
    'PROFIT-TYPE': { title: 'HFR Ownership Sub-Type (Profit)', description: 'Ownership sub-type for a for-profit facility (HFR get-master-data type=PROFIT-TYPE) — Organization.extension:ownershipSubTypeCode2, when ownershipSubTypeCategory=PROFIT.' },
    'NON-PROFIT-TYPE': { title: 'HFR Ownership Sub-Type (Non-Profit)', description: 'Ownership sub-type for a non-profit facility (HFR get-master-data type=NON-PROFIT-TYPE) — Organization.extension:ownershipSubTypeCode2, when ownershipSubTypeCategory=NON-PROFIT.' },
    'SPECIALITY-TYPE': { title: 'HFR Speciality Type', description: 'Whether the facility offers a single or multiple specialities (HFR get-master-data type=SPECIALITY-TYPE) — Organization.extension:specialityTypeCode.' },
    'FACILITY-REGION': { title: 'HFR Facility Region', description: 'Urban or Rural (HFR get-master-data type=FACILITY-REGION) — Organization.extension:facilityRegion.' },
    'GENERAL-INFO-OPTIONS': { title: 'HFR General Info Options', description: 'Real 3-way answer for the Additional Information API\'s own hasDialysisCenter/hasPharmacy/hasBloodBank/hasCathLab/hasDiagnosticLab/hasImagingCenter flags (HFR get-master-data type=GENERAL-INFO-OPTIONS) — NOT a plain Y/N boolean, a real bug found and fixed: the doc\'s own sample uses "YALL" (available for everyone), not just Y/N.' },
    IMAGING: { title: 'HFR Imaging Services', description: 'Imaging service codes for the Detailed Information API\'s imagingServices section (HFR get-master-data type=IMAGING) — Organization.extension:imagingService.' },
    DIAGNOSTIC: { title: 'HFR Diagnostic Services', description: 'Diagnostic lab service codes for the Detailed Information API\'s diagnosticServices section (HFR get-master-data type=DIAGNOSTIC) — Organization.extension:diagnosticService.' },
};

async function fetchMasterData(type) {
    const res = await fetch(`${GATEWAY_BASE}/hfr/master/data?type=${encodeURIComponent(type)}`, {
        headers: { 'X-Service-Key': SERVICE_KEY },
    });
    const body = await res.json();
    if (!body.success) throw new Error(`GET /hfr/master/data?type=${type} failed: ${JSON.stringify(body)}`);
    // Real ABDM quirk found live this session: some codes/values come back space-padded
    // (e.g. "G         "). Trimmed here once, at build time, rather than by every consumer.
    return (body.data?.data || []).map((r) => ({ code: (r.code || '').trim(), display: (r.value || '').trim() }));
}

function slug(type) {
    return `hfr-${type.toLowerCase()}`;
}

const bundle = {};
for (const [type, meta] of Object.entries(TYPES)) {
    const concepts = await fetchMasterData(type);
    const id = slug(type);
    const codeSystemUrl = `http://yaxb.ai/clinixkernel/CodeSystem/${id}`;
    const valueSetUrl = `http://yaxb.ai/clinixkernel/ValueSet/${id}`;

    const codeSystem = {
        resourceType: 'CodeSystem',
        id,
        url: codeSystemUrl,
        version: '1.0.0',
        name: meta.title.replace(/[^A-Za-z0-9]/g, ''),
        title: meta.title,
        status: 'active',
        experimental: false,
        date: new Date().toISOString().slice(0, 10),
        description: meta.description,
        caseSensitive: true,
        content: 'complete',
        concept: concepts.map((c) => ({ code: c.code, display: c.display })),
    };

    const valueSet = {
        resourceType: 'ValueSet',
        id,
        url: valueSetUrl,
        version: '1.0.0',
        name: codeSystem.name,
        title: meta.title,
        status: 'active',
        compose: { include: [{ system: codeSystemUrl }] },
        expansion: {
            identifier: `urn:uuid:${id}-expansion`,
            timestamp: new Date().toISOString(),
            contains: concepts.map((c) => ({ system: codeSystemUrl, code: c.code, display: c.display })),
        },
    };

    bundle[type] = { codeSystem, valueSet };
    console.log(`  ${type}: ${concepts.length} concept(s).`);
}

writeFileSync(join(apiRoot, 'data', 'hfr-master-valuesets.json'), JSON.stringify(bundle, null, 2));
console.log(`Wrote data/hfr-master-valuesets.json: ${Object.keys(bundle).length} ValueSet(s).`);
