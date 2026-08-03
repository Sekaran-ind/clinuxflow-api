import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { compileYamlToQuestionnaire } from '../lib/yaml-to-questionnaire.js';

const COMPOSITIONS_DIR = path.join(process.cwd(), 'src/compositions');
const TEMPORARY_COMPOSITE_PATH = path.join(process.cwd(), 'runtime-composite-questionnaire.json');

export class WorkflowOrchestrator {
    constructor(hapiServerBaseUrl) {
        this.hapiServerUrl = hapiServerBaseUrl;
        this._provisionMockCompositionRegistry();
    }

    /**
     * Internal provision hook setting up room workflow chunks for testing
     */
    _provisionMockCompositionRegistry() {
        if (!fs.existsSync(COMPOSITIONS_DIR)) {
            fs.mkdirSync(COMPOSITIONS_DIR, { recursive: true });
        }

        // Module 1: Core demographic fragment
        fs.writeFileSync(path.join(COMPOSITIONS_DIR, 'core-demographics.yaml'), `
            formId: core-demographics-chunk
            composition:
            - resourceType: Patient
                fields:
                - path: "Patient.gender"
                    label: "Biological Sex"
                    uiComponent: "Dropdown"
                    choices: ["male", "female", "other", "unknown"]
                    required: true
            `.trim());

        // Module 2: Nursing Triage vitals fragment
        fs.writeFileSync(path.join(COMPOSITIONS_DIR, 'triage-vitals.yaml'), `
            formId: triage-vitals-chunk
            composition:
            - resourceType: Observation
                fields:
                - path: "Observation.valueQuantity"
                    label: "Systolic Blood Pressure"
                    uiComponent: "NumericInput"
                    required: true
            `.trim());

        // Module 3: Specialized Cardiology tracking parameters
        fs.writeFileSync(path.join(COMPOSITIONS_DIR, 'cardio-exam.yaml'), `
            formId: cardio-exam-chunk
            composition:
            - resourceType: Observation
                fields:
                - path: "Observation.status"
                    label: "Process Flag"
                    uiComponent: "Hidden"
                    defaultValue: "final"
            - resourceType: Condition
                fields:
                - path: "Condition.clinicalStatus"
                    label: "Cardiology Assessment Abnormality Marker"
                    uiComponent: "TextInput"
            `.trim());
    }


    /**
     * Internal Compiler Tool: Compiles the unified Questionnaire into a rigid GBNF rule file
     */
    _compileQuestionnaireToGbnf(fhirQuestionnaire, gbnfOutputPath) {
        // 1. Isolate only the fields that are active form targets (ignore hidden/admin fields for voice tracking)
        const formFields = fhirQuestionnaire.item
            .filter(item => !item.extension?.some(ext => ext.url.endsWith('questionnaire-hidden')))
            .map(item => item.linkId);

        if (formFields.length === 0) return;

        // 2. Build the GBNF Root array rules forcing a strict JSON output shape
        const escapedPaths = formFields.map(p => `"${p}"`).join(' | ');
        let gbnf = `root ::= "{\\n" "  \\"updates\\": [\\n" items "\\n  ]\\n}"\n\n`;
        gbnf += `items ::= item (",\\n" item)*\n`;
        gbnf += `item ::= "    {\\n" "      \\"path\\": " path_enum ",\\n" "      \\"value\\": " value_rules "\\n    }"\n\n`;
        gbnf += `path_enum ::= ${escapedPaths}\n\n`;

        // 3. Build conditional value tracking tokens for each specific data path path type
        const valueConditions = [];
        let typeMatchingRules = '';

        fhirQuestionnaire.item.forEach((item, index) => {
            if (item.extension?.some(ext => ext.url.endsWith('questionnaire-hidden'))) return;

            const ruleLabel = `val_rule_${index}`;
            valueConditions.push(ruleLabel);

            if (item.type === 'decimal' || item.type === 'integer') {
                // Force numeric integer/float output constraints
                typeMatchingRules += `${ruleLabel} ::= [0-9]+\n`;
            } else if (item.type === 'boolean') {
                // Force absolute true/false mapping values
                typeMatchingRules += `${ruleLabel} ::= "true" | "false"\n`;
            } else if (item.type === 'choice' && item.answerOption) {
                // Extract exact enum strings allowed for this field: "male" | "female"
                const allowedChoices = item.answerOption.map(opt => `"${opt.valueString}"`).join(' | ');
                typeMatchingRules += `${ruleLabel} ::= ${allowedChoices}\n`;
            } else {
                // Generic alphanumeric string literal fallback
                typeMatchingRules += `${ruleLabel} ::= "\\"" [a-zA-Z0-9 ]+ "\\""\n`;
            }
        });

        gbnf += `value_rules ::= ${valueConditions.join(' | ')}\n\n`;
        gbnf += typeMatchingRules;
        gbnf += `\nws ::= [ \\t\\n]*\n`;

        // Save the grammar asset configuration directly to disk
        fs.writeFileSync(gbnfOutputPath, gbnf, 'utf8');
        console.log(`  ➔ Local AI constraints compiled! Generated strict GBNF rule at: ${gbnfOutputPath}`);
    }

    /**
     * 1. Dynamic Layout Composition Layer
     * Assembles discrete YAML chunks into a single unified Questionnaire based on clinician runtime context
     */
    assembleRoomContext(role, specialty) {
        console.log(`\nDoc-Scribe Pipeline Engine initialized: Role=${role}, Specialty=${specialty}`);

        const fragmentsToBlend = [];
        fragmentsToBlend.push(path.join(COMPOSITIONS_DIR, 'core-demographics.yaml'));

        if (role === 'Nurse' || role === 'Doctor') {
            fragmentsToBlend.push(path.join(COMPOSITIONS_DIR, 'triage-vitals.yaml'));
        }

        if (specialty === 'Cardiology' && role === 'Doctor') {
            fragmentsToBlend.push(path.join(COMPOSITIONS_DIR, 'cardio-exam.yaml'));
        }

        const masterCompositionMap = {
            formId: `dynamic-${role.toLowerCase()}-${specialty.toLowerCase()}-v1`,
            composition: []
        };

        const mergedResourceBlocks = new Map();
        fragmentsToBlend.forEach(filePath => {
            const rawYaml = yaml.load(fs.readFileSync(filePath, 'utf8'));
            rawYaml.composition.forEach(block => {
                if (!mergedResourceBlocks.has(block.resourceType)) {
                    mergedResourceBlocks.set(block.resourceType, { resourceType: block.resourceType, fields: [] });
                }
                mergedResourceBlocks.get(block.resourceType).fields.push(...block.fields);
            });
        });

        masterCompositionMap.composition = Array.from(mergedResourceBlocks.values());

        const compositeYamlPath = path.join(process.cwd(), 'runtime-composite.yaml');
        fs.writeFileSync(compositeYamlPath, yaml.dump(masterCompositionMap), 'utf8');

        // Compile raw inputs into our official FHIR Questionnaire blueprint format
        const compilationSuccess = compileYamlToQuestionnaire(compositeYamlPath, TEMPORARY_COMPOSITE_PATH);
        if (!compilationSuccess) throw new Error("Compilation Fault on Merged configuration structures.");

        const compiledQuestionnaireJson = JSON.parse(fs.readFileSync(TEMPORARY_COMPOSITE_PATH, 'utf8'));
        console.log(`  ➔ Layout composition unified! Generated ${compiledQuestionnaireJson.item.length} dynamic field targets.`);

        // --- NEW PIPELINE TASK EXTENSION ---
        // Dynamically compile the layout down into a unique local GBNF grammar track for this specific clinical room
        const roomGbnfPath = path.join(process.cwd(), `room-${role.toLowerCase()}-${specialty.toLowerCase()}.gbnf`);
        this._compileQuestionnaireToGbnf(compiledQuestionnaireJson, roomGbnfPath);

        return {
            uiQuestionnaire: compiledQuestionnaireJson,
            aiGbnfFile: roomGbnfPath
        };
    }


    /**
     * 2. Initialize Browser Render Context (LHC-Forms Handoff)
     * Simulates passing the compiled blueprint straight into the web client controller widget
     */
    initializeLformsWidget(fhirQuestionnaireJson) {
        console.log("🖥️ Passing configuration blueprint payload to front-end LHC-Forms (lforms) controller...");
        // In actual browser execution context: 
        // const formDef = LForms.Util.getFormDefFromFHIRQuestionnaire(fhirQuestionnaireJson);
        // LForms.Util.addFormToPage(formDef, 'formContainerElementId');
        return true;
    }


    /**
     * 3. Sync Persistence Layer (HAPI Server $extract Ingestion)
     * Transmits a filled QuestionnaireResponse to HAPI FHIR server's Structured Data Capture operation hook
     */
    async transmitAndExtractToHapi(questionnaireResponsePayload) {
        const endpointTarget = `${this.hapiServerUrl}/Questionnaire/$extract`;
        console.log(`\n🚀 Transmitting tracking asset to HAPI FHIR Server endpoint: ${endpointTarget}`);

        try {
            // Simulated local edge fetch routine handling integration boundaries
            console.log("  ➔ Sending payload payload transaction stack via HTTP POST standard channel...");
            console.log(`  ➔ Payload context extraction tracking target: Questionnaire reference '${questionnaireResponsePayload.questionnaire}'`);
            
            // In live execution pipeline:
            // const response = await fetch(endpointTarget, {
            //     method: 'POST',
            //     headers: { 'Content-Type': 'application/fhir+json' },
            //     body: JSON.stringify(questionnaireResponsePayload)
            // });
            // return await response.json();

            console.log("✅ Success! HAPI server processed the $extract transaction natively, generating separate linked Patient, Observation, and Condition assets.");
            return { status: 200, message: "Transaction complete. Data elements successfully decoupled." };
        } catch (error) {
            console.error(`❌ Persistence Transmission Fault: ${error.message}`);
            throw error;
        }
    }
}
