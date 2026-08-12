// Manually-run build step (`npm run build:system-forms`, or via the combined `build:kernel`
// chain) — compiles every system-form YAML in tools/system-forms/ into a FHIR Questionnaire and
// writes data/system-forms-library.json, shaped exactly like the browser's cf_forms_library so
// seedSystemForms() can drop it straight into localStorage unchanged.
//
// Imports the SAME src/lib/yaml-to-questionnaire.js the running Worker uses for POST
// /api/workflow/compile, rather than a separate build-time copy of that compiler (clinux-kernel,
// which this tool was folded in from, kept its own older file-path-based copy that had already
// drifted from the Worker's string-based one — see git history/prior notes). One compiler, used
// both at build time and request time, means there's only ever one place to fix a compiler bug.
//
// Requires data/form-schematics.schema.json and data/graphs.bundle.json to already exist — run
// dictionary-builder.js + build-graphs-bundle.js first (again, `build:kernel` chains all three).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compileYamlToQuestionnaire } from '../src/lib/yaml-to-questionnaire.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const YAML_DIR = path.join(DIR, 'system-forms');

// Fixed sidebar display order — must match clinux-frontend's SYSTEM_FORM_IDS
// (src/data/useSystemForms.js).
const FORM_IDS = [
    'system-hospital-profile-v1',
    'system-patient-profile-v1',
    'system-staff-profile-v1',
    'system-services-profile-v1',
    'system-consents-profile-v1',
    'system-appointments-profile-v1',
    'system-office-hours-profile-v1',
    'system-locations-profile-v1',
    'system-encounter-composition-v1',
];

const catalog = {};
let failures = 0;

for (const formId of FORM_IDS) {
    const yamlPath = path.join(YAML_DIR, `${formId}.yaml`);
    if (!fs.existsSync(yamlPath)) {
        console.error(`FAIL: ${formId} — no YAML source at ${yamlPath}`);
        failures++;
        continue;
    }
    const yamlSource = fs.readFileSync(yamlPath, 'utf8');
    const result = compileYamlToQuestionnaire(yamlSource);
    if (!result.success) {
        console.error(`FAIL: ${formId} — ${result.errors.join('; ')}`);
        failures++;
        continue;
    }
    catalog[formId] = {
        isSystem: true,
        archived: false,
        bookmarked: false,
        activeVersion: 1,
        versions: [{ version: 1, status: 'final', yaml: yamlSource, questionnaire: result.questionnaire, savedAt: new Date().toISOString() }],
    };
    console.log(`OK: ${formId}`);
}

if (failures > 0) {
    console.error(`\n${failures} form(s) failed to compile. Not writing system-forms-library.json.`);
    process.exit(1);
}

const outPath = path.join(DIR, '..', 'data', 'system-forms-library.json');
fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2), 'utf8');
console.log(`\nWrote ${outPath} (${Object.keys(catalog).length} forms).`);
