// Design-time codegen (run via `npm run build:kernel`, not part of the live Worker). Replaces
// tools/dictionary-builder.js, which walked the @smile-cdr/fhirts TypeScript classes: the FHIR
// path dictionary now comes from the official FHIR packages pinned in fhir-packages.json (HL7 R4
// core, HL7 terminology, HL7 extensions, and the ABDM IG from NRCeS — https://nrces.in/ndhm/fhir/r4),
// built by the same generator clinuxflow-fhir-api uses (tools/fhir/lib/dictionary.js, copied from
// there). Same outputs, same shapes, so yaml-to-questionnaire.js and the runtime are unchanged:
//   - data/graphs/<resource>.graph.json — one shard per resource: every bindable field path, its
//     FHIR type, whether it repeats, a GBNF fragment, keyword metadata and a YAML snippet.
//   - data/form-schematics.schema.json — the structural JSON Schema for room-layout YAML.
// What's better than the TypeScript walk: codes for required bindings come from the official
// value sets (not TS string unions), Reference targets from the definitions' targetProfile (not
// guessed from the field name), and descriptions from the definitions' own `short` text.
//
// Run: node tools/fhir/fetch-packages.js (once; sha256-verified) && node tools/build-fhir-dictionary.js
import fs from 'node:fs';
import path from 'node:path';
import { loadPackages } from './fhir/lib/fhir-packages.js';
import { compactStructureDefinition } from './fhir/lib/compact.js';
import { buildDictionary, DICTIONARY_RESOURCES } from './fhir/lib/dictionary.js';

const ROOT = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'clinixflow.config.json'), 'utf8'));
const GRAPHS_DIR = path.join(ROOT, 'data', 'graphs');
const SCHEMA_PATH = path.join(ROOT, config.directories.schemaOutput);
const ABDM_PACKAGE = 'ndhm.in';

// ── Load the packages ────────────────────────────────────────────────────────────────────────
const packages = loadPackages();
const core = packages.find((p) => p.pkg.id === 'hl7.fhir.r4.core');
if (!core) throw new Error('hl7.fhir.r4.core is not in fhir-packages.json');

const compactByType = new Map(); // core type name -> compact SD
const rawByUrl = new Map(); // url -> raw SD (for `short` descriptions)
for (const sd of core.resources) {
    if (sd.resourceType !== 'StructureDefinition' || sd.derivation !== 'specialization' || !sd.snapshot) continue;
    compactByType.set(sd.type, compactStructureDefinition(sd, core.pkg.id));
    rawByUrl.set(sd.url, sd);
}
const shortByPath = new Map();
for (const sd of rawByUrl.values()) for (const el of sd.snapshot.element) if (el.short) shortByPath.set(el.id, el.short);

const valueSets = new Map();
const codeSystems = new Map();
for (const { resources } of packages) {
    for (const r of resources) {
        if (r.resourceType === 'ValueSet') valueSets.set(r.url, r);
        if (r.resourceType === 'CodeSystem') codeSystems.set(r.url, r);
    }
}

// The resources form authors may target: the compiler's own list, fhir-api's dictionary list,
// and every resource type the ABDM IG profiles (so a form can bind to an ABDM-profiled resource).
const abdm = packages.find((p) => p.pkg.id === ABDM_PACKAGE);
const abdmTypes = (abdm?.resources || [])
    .filter((r) => r.resourceType === 'StructureDefinition' && r.kind === 'resource' && r.derivation === 'constraint')
    .map((r) => r.type);
const RESOURCES = [...new Set([...config.validation.allowedResources, ...DICTIONARY_RESOURCES, ...abdmTypes])]
    .filter((t) => compactByType.has(t))
    .sort();

const dictionary = buildDictionary(RESOURCES, (type) => compactByType.get(type));

// Element ids FHIR itself references, so they are real authoring targets even though the shared
// generator skips ids on backbone elements: PlanDefinition.action.relatedAction.actionId points
// at an action's `id` (R4), and the workflow YAML (SPEC-18) binds the action id to it. Added here
// rather than in tools/fhir/lib/dictionary.js, which must stay identical to fhir-api's copy.
const REFERENCED_ELEMENT_IDS = { PlanDefinition: ['PlanDefinition.action.id'] };
for (const [resource, ids] of Object.entries(REFERENCED_ELEMENT_IDS)) {
    for (const id of ids) if (dictionary[resource]) dictionary[resource][id] = { types: ['string'], min: 0, max: '1' };
}

// ── Codes for a required binding (enumerated value sets only; filters are never expanded) ────
const flatten = (concepts = []) => concepts.flatMap((c) => [c.code, ...flatten(c.concept)]);
function codesOf(valueSetUrl, seen = new Set()) {
    const vs = valueSets.get(valueSetUrl);
    if (!vs || seen.has(valueSetUrl)) return [];
    seen.add(valueSetUrl);
    const codes = [];
    for (const inc of vs.compose?.include || []) {
        if (inc.filter?.length) return []; // not a closed list
        if (inc.concept?.length) codes.push(...inc.concept.map((c) => c.code));
        else if (inc.system) {
            const cs = codeSystems.get(inc.system);
            if (!cs || cs.content !== 'complete') return [];
            codes.push(...flatten(cs.concept));
        }
        for (const nested of inc.valueSet || []) codes.push(...codesOf(nested, seen));
    }
    return [...new Set(codes)];
}

// ── Shard nodes, same shape as dictionary-builder.js wrote ───────────────────────────────────
const ENGLISH_STOP_WORDS = new Set(['the', 'and', 'this', 'that', 'with', 'from', 'for', 'was', 'were', 'been', 'each', 'such', 'their', 'them', 'these', 'into', 'under', 'over', 'above', 'value', 'element', 'property', 'type', 'contains']);
const NUMERIC = new Set(['decimal', 'integer', 'positiveInt', 'unsignedInt', 'integer64']);
const POLYMORPHIC = config.validation.runtimePolymorphicPrimitives.map((p) => p.toLowerCase()); // extension, reference, narrative, codeableconcept
const isPrimitive = (code) => /^[a-z]/.test(code);

function gbnfRule(placeholderId, type, isArray, choices) {
    let value = `[^\\"\\r\\n]*`;
    if (NUMERIC.has(type)) value = `[0-9]+ (\\".\\" [0-9]+)?`;
    else if (type === 'boolean') value = `(true | false)`;
    else if (choices.length) value = `(${choices.map((c) => `\\"${c}\\"`).join(' | ')})`;
    else if (type === 'CodeableConcept' || type === 'Coding' || type === 'code') value = `[a-zA-Z0-9\\-]+`;
    if (isArray) return `"\\"${placeholderId}\\": [ " ( \\"" ${value} "\\"" ( ", \\"" ${value} "\\"" )* )? " ]"`;
    return `"\\"${placeholderId}\\": \\"" ${value} "\\""`;
}

function uiComponentFor(type, isArray, pathStr, choices) {
    if (NUMERIC.has(type)) return 'NumericInput';
    if (type === 'boolean') return 'Checkbox';
    if (type === 'date' || type === 'dateTime') return 'DatePicker';
    if (choices.length || type === 'CodeableConcept' || type === 'Coding' || type === 'code' || pathStr.toLowerCase().includes('code')) return isArray ? 'MultiSelect' : 'Dropdown';
    return 'TextInput';
}

function shardNodes(resource) {
    const entries = Object.entries(dictionary[resource] || {});
    const nodes = [{
        path: `${resource}.resourceType`, resourceType: resource, primitiveType: 'object', isArray: false, arrayTargetType: null, outboundEdges: null,
        gbnfRuleToken: gbnfRule('resource_type', 'string', false, []),
        semanticFingerprint: { jsdocDefinition: `This is a ${resource} resource`, coreKeywords: [resource.toLowerCase(), 'resource'] },
        reverseYamlSnippet: `      - id: "resource_type"\n        path: "${resource}.resourceType"\n        label: "Enter resourceType"\n        description: "This is a ${resource} resource"\n        uiComponent: "TextInput"`,
    }];
    for (const [p, e] of entries) {
        if (config.validation.systemOverheadProperties.some((o) => p === `${resource}.${o}`)) continue;
        const type = e.types?.[0] || 'string';
        const isArray = e.max === '*' || Number(e.max) > 1;
        const choices = e.binding?.strength === 'required' && type === 'code' ? codesOf(e.binding.valueSet) : [];
        const tokens = p.split('.');
        const leaf = tokens.at(-1);
        const placeholderId = leaf.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_+/, '');
        const short = (shortByPath.get(p) || shortByPath.get(p.replace(/(\.[a-z]+)[A-Z][A-Za-z]+$/, '$1[x]')) || '').replace(/"/g, "'");
        const ui = uiComponentFor(type, isArray, p, choices);
        const keywords = [...new Set(
            [...tokens.flatMap((t) => t.split(/(?=[A-Z])/)), ui, ...short.toLowerCase().split(/[\s._-]/)]
                .map((w) => w.replace(/[^a-zA-Z]/g, '').toLowerCase())
                .filter((w) => w.length > 2 && !ENGLISH_STOP_WORDS.has(w)),
        )];
        const lower = type.toLowerCase();
        const targets = type === 'Reference'
            ? (compactByType.get(resource)?.elements.find((el) => el.id === p)?.types?.[0]?.targetProfile || [])
            : [];
        const node = {
            path: p,
            resourceType: resource,
            primitiveType: isPrimitive(type) ? type : POLYMORPHIC.includes(lower) ? `polymorphic-${lower}` : 'object',
            isArray,
            arrayTargetType: isArray ? type : null,
            outboundEdges: type === 'Reference'
                ? (targets.length ? targets : ['http://hl7.org/fhir/StructureDefinition/Resource']).map((t) => {
                    const target = t.split('/').pop();
                    return { relationshipType: `${leaf}-link`, targetResource: target, traversalPath: `${target}.id` };
                })
                : null,
            gbnfRuleToken: gbnfRule(placeholderId, type, isArray, choices),
            semanticFingerprint: { jsdocDefinition: short, coreKeywords: keywords },
            reverseYamlSnippet: `      - id: "${placeholderId}"\n        path: "${p}"\n        label: "Enter ${leaf}"\n        description: "${short || 'Clinical data element.'}"\n        uiComponent: "${ui}"`,
        };
        if (e.binding) node.binding = e.binding;
        if (choices.length) node.choices = choices;
        nodes.push(node);
    }
    return nodes;
}

// ── Write shards + schema ────────────────────────────────────────────────────────────────────
fs.rmSync(GRAPHS_DIR, { recursive: true, force: true });
fs.mkdirSync(GRAPHS_DIR, { recursive: true });
const allPaths = [];
for (const resource of RESOURCES) {
    const nodes = shardNodes(resource);
    allPaths.push(...nodes.map((n) => n.path));
    fs.writeFileSync(path.join(GRAPHS_DIR, `${resource.toLowerCase()}.graph.json`), JSON.stringify(nodes, null, 2));
}

const fieldDefinition = {
    type: 'object',
    oneOf: [
        {
            required: ['id', 'path', 'label', 'uiComponent'],
            properties: {
                id: { type: 'string' },
                path: { type: 'string', enum: allPaths },
                label: { type: 'string' },
                uiComponent: { type: 'string', enum: config.validation.allowedUiComponents },
                description: { type: 'string' },
                required: { type: 'boolean' },
                choices: { type: 'array', items: { type: 'string' } },
                unit: { type: 'string' },
                valueSetUrl: { type: 'string' },
                terminologyServerUrl: { type: 'string' },
                defaultValue: { type: 'string' },
                repeats: { type: 'boolean' },
            },
        },
        {
            required: ['id', 'label', 'type', 'path', 'fields'],
            properties: {
                id: { type: 'string' },
                path: { type: 'string', enum: allPaths },
                label: { type: 'string' },
                type: { const: 'group' },
                repeats: { type: 'boolean' },
                fields: { type: 'array', items: { $ref: '#/definitions/field' } },
            },
        },
    ],
};
const metaSchema = {
    $schema: 'http://json-schema.org',
    title: 'ClinixFlow Validation Schema Base',
    $comment: 'Generated by tools/build-fhir-dictionary.js from the official FHIR packages in fhir-packages.json (HL7 R4 core + ABDM IG ndhm.in). Do not edit by hand.',
    type: 'object',
    required: ['formId', 'composition'],
    definitions: { field: fieldDefinition },
    properties: {
        formId: { type: 'string' },
        journey: { type: 'string', enum: ['patient', 'hospital'] },
        composition: {
            type: 'array',
            items: {
                type: 'object',
                required: ['resourceType', 'fields'],
                properties: {
                    resourceType: { type: 'string', enum: RESOURCES },
                    fields: { type: 'array', items: { $ref: '#/definitions/field' } },
                },
            },
        },
    },
};
fs.writeFileSync(SCHEMA_PATH, JSON.stringify(metaSchema, null, 2));
console.log(`✅ ${RESOURCES.length} resources, ${allPaths.length} paths → data/graphs/ + ${path.relative(ROOT, SCHEMA_PATH)} (from ${packages.map((p) => `${p.pkg.id}#${p.pkg.version}`).join(', ')})`);
