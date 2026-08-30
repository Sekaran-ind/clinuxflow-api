// Precomputes config/plandefinition-condition-types/*.json from the clinixflow dev sandbox into
// one bundled JSON manifest this Worker can `import` directly — same treatment
// data/clinic-specialities.json already gets (see build-clinic-specialities.js), since Workers
// has no filesystem to read from at request time.
//
// SPEC-18 (docs/SPEC-18-PLANDEFINITION-AUTHORING-VIA-YAML-PIPELINE.md) §7 step 4 — the
// constrained condition-field type. Compiles the source CodeSystem into a pre-expanded FHIR
// ValueSet (LHC-Forms' own sdc-support.md notes contained ValueSets are expected to carry an
// expansion — served, not compose-only) for `answerValueSet` consumption, alongside the
// CodeSystem itself and the (non-FHIR, ClinixFlow-specific) condition-type-templates lookup a
// later PlanDefinition-assembly step will need.
//
// Run manually whenever clinixflow's condition-types content changes:
//   node scripts/build-condition-types.js
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CLINIXFLOW_ROOT = process.env.CLINIXFLOW_ROOT || join(apiRoot, '..', '..', 'clinixflow');
const SOURCE_DIR = join(CLINIXFLOW_ROOT, 'config', 'plandefinition-condition-types');

const codeSystem = JSON.parse(readFileSync(join(SOURCE_DIR, 'condition-types.json'), 'utf8'));
const templates = JSON.parse(readFileSync(join(SOURCE_DIR, 'condition-type-templates.json'), 'utf8'));

const valueSet = {
  resourceType: 'ValueSet',
  id: 'plandefinition-condition-types',
  url: 'http://yaxb.ai/clinixkernel/ValueSet/plandefinition-condition-types',
  version: codeSystem.version,
  name: 'PlanDefinitionConditionTypes',
  title: codeSystem.title,
  status: codeSystem.status,
  compose: {
    include: [{ system: codeSystem.url }],
  },
  // Pre-expanded, not compose-only — LHC-Forms' sdc-support.md documents contained ValueSets are
  // expected to already carry an expansion, not be expanded server-side at render time.
  expansion: {
    identifier: `urn:uuid:${codeSystem.id}-expansion`,
    timestamp: new Date().toISOString(),
    contains: codeSystem.concept.map((c) => ({ system: codeSystem.url, code: c.code, display: c.display })),
  },
};

writeFileSync(
  join(apiRoot, 'data', 'condition-types.json'),
  JSON.stringify({ codeSystem, valueSet, templates: templates }, null, 2)
);

console.log(`Wrote data/condition-types.json: ${codeSystem.concept.length} condition type(s).`);
