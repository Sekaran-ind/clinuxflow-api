// SPEC-22 decision #2's real loader, build-time half — mirrors build-system-forms.js's exact
// pattern (same compiler, same "write a precomputed JSON bundle" shape) but for workflow-
// definition YAMLs: compiles each into its authoring-form Questionnaire, then extracts the real
// PlanDefinition from a hand-built "worked example" response (see hospital-setup-workflow-
// response.js's own header on why a response has to be hand-built for now — there's no
// interactive authoring UI producing one yet).
//
// Writes data/system-flows-library.json, shaped like clinux-frontend's flowsLibrary.js collection
// rows (mirrors formsLibrary's versions[] array shape for consistency, with `planDefinition`
// where formsLibrary has `questionnaire`) so seedSystemFlows() can drop it straight in.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compileYamlToQuestionnaire } from '../src/lib/shared/yaml-to-questionnaire.js';
import { ComprehensiveLocalExtractor } from '../src/lib/shared/local-extractor.js';
import { buildHospitalSetupWorkflowResponse } from '../src/lib/runtime/hospital-setup-workflow-response.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.join(DIR, '..', 'samples');

// Each entry: the source YAML (in samples/) + the hand-built response proving what it extracts
// to. Adding a second real system-flow later means adding one more entry here, same as
// build-system-forms.js's own FORM_IDS list grows by adding a YAML file.
const FLOWS = [
  { flowId: 'hospital-setup-workflow-v1', buildResponse: buildHospitalSetupWorkflowResponse },
];

const catalog = {};
let failures = 0;

for (const { flowId, buildResponse } of FLOWS) {
  const yamlPath = path.join(SAMPLES_DIR, `${flowId}.yaml`);
  if (!fs.existsSync(yamlPath)) {
    console.error(`FAIL: ${flowId} — no YAML source at ${yamlPath}`);
    failures++;
    continue;
  }
  const yamlSource = fs.readFileSync(yamlPath, 'utf8');
  const compiled = compileYamlToQuestionnaire(yamlSource);
  if (!compiled.success) {
    console.error(`FAIL: ${flowId} — ${compiled.errors.join('; ')}`);
    failures++;
    continue;
  }

  const response = buildResponse();
  const result = ComprehensiveLocalExtractor.extract(compiled.questionnaire, response);
  if (result.warnings && result.warnings.length) {
    console.error(`FAIL: ${flowId} — extraction warnings: ${result.warnings.join('; ')}`);
    failures++;
    continue;
  }
  const planDefinition = result.find((r) => r.resourceType === 'PlanDefinition');
  if (!planDefinition) {
    console.error(`FAIL: ${flowId} — extraction produced no PlanDefinition resource`);
    failures++;
    continue;
  }

  catalog[flowId] = {
    isSystem: true,
    archived: false,
    activeVersion: 1,
    versions: [{ version: 1, status: 'active', yaml: yamlSource, planDefinition, savedAt: new Date().toISOString() }],
  };
  console.log(`OK: ${flowId} (${planDefinition.action.length} actions)`);
}

if (failures > 0) {
  console.error(`\n${failures} flow(s) failed to compile/extract. Not writing system-flows-library.json.`);
  process.exit(1);
}

const outPath = path.join(DIR, '..', 'data', 'system-flows-library.json');
fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2), 'utf8');
console.log(`\nWrote ${outPath} (${Object.keys(catalog).length} flow(s)).`);
