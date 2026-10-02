// Copied from clinuxflow-fhir-api (scripts/lib/compact.js) — clinuxflow-api builds its FHIR path dictionary
// from the same pinned official packages (fhir-packages.json) instead of @smile-cdr/fhirts.
// Keep in step with fhir-api: change it there first, then copy.
// Turns a StructureDefinition snapshot into the compact form the runtime validator uses.
//
// Only what validation and the path dictionary need is kept: cardinality, types (with target
// profiles), fixed/pattern values, bindings, slicing and content references. Descriptions,
// mappings and constraints' human text are dropped, which is what keeps the Worker bundle small.

const FHIR_TYPE_EXT = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type';

/** R4 snapshots type `Resource.id`, `Element.id`, `Extension.url` etc. as FHIRPath system types
 * with an extension naming the real FHIR type; resolve those to the FHIR type. */
function typeCode(type) {
    const ext = (type.extension || []).find((e) => e.url === FHIR_TYPE_EXT);
    if (ext) return ext.valueUrl || ext.valueUri;
    if (type.code?.startsWith('http://hl7.org/fhirpath/System.')) {
        const sys = type.code.slice('http://hl7.org/fhirpath/System.'.length);
        return { String: 'string', Boolean: 'boolean', Integer: 'integer', Decimal: 'decimal', Date: 'date', DateTime: 'dateTime', Time: 'time' }[sys] || 'string';
    }
    return type.code;
}

function prefixed(obj, prefix) {
    const key = Object.keys(obj).find((k) => k.startsWith(prefix) && k.length > prefix.length);
    return key ? { type: key.slice(prefix.length), value: obj[key] } : undefined;
}

export function compactElement(el) {
    const out = { id: el.id, path: el.path, min: el.min ?? 0, max: el.max ?? '*' };
    // JSON array-ness follows the BASE definition's cardinality, not the profile's: a profile
    // that narrows CodeableConcept.coding to max 1 still serializes it as an array.
    if (el.base?.max !== undefined && el.base.max !== out.max) out.baseMax = el.base.max;
    if (el.sliceName) out.sliceName = el.sliceName;
    if (el.type?.length) {
        out.types = el.type.map((t) => {
            const ct = { code: typeCode(t) };
            if (t.profile?.length) ct.profile = t.profile;
            if (t.targetProfile?.length) ct.targetProfile = t.targetProfile;
            return ct;
        });
    }
    if (el.contentReference) out.contentReference = el.contentReference.replace(/^.*#/, '');
    const fixed = prefixed(el, 'fixed');
    if (fixed) out.fixed = fixed;
    const pattern = prefixed(el, 'pattern');
    if (pattern) out.pattern = pattern;
    if (el.binding?.valueSet) out.binding = { strength: el.binding.strength, valueSet: el.binding.valueSet.split('|')[0] };
    if (el.slicing) {
        out.slicing = { discriminator: el.slicing.discriminator || [], rules: el.slicing.rules || 'open' };
        if (el.slicing.ordered) out.slicing.ordered = true;
    }
    if (el.mustSupport) out.mustSupport = true;
    return out;
}

/** @returns compact SD: { url, name, type, kind, baseDefinition, derivation, source, elements: [] } */
export function compactStructureDefinition(sd, source) {
    if (!sd.snapshot?.element?.length) throw new Error(`${sd.url} has no snapshot`);
    return {
        url: sd.url,
        name: sd.name,
        type: sd.type,
        kind: sd.kind,
        abstract: !!sd.abstract,
        baseDefinition: sd.baseDefinition,
        derivation: sd.derivation,
        source,
        elements: sd.snapshot.element.map(compactElement),
    };
}
