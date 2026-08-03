import fs from 'fs';
import path from 'path';

/**
 * Runtime Scribe Engine - SPEC-03 Implementation
 * Decoupled token-constrained extraction and deterministic state reconciliation.
 *
 * Note: this class is not currently imported by server.js. The live /api/workflow/test-scribe
 * and /api/workflow/test-scribe-mock endpoints implement their own inline field-matching logic
 * instead of using it. Kept here as a standalone, reusable engine for embedding the same
 * schema-constrained-extraction + reconciliation flow outside the Express server (e.g. a CLI
 * or a different host process) — construct it with the path to a compiled Questionnaire JSON.
 */
export class RuntimeScribeEngine {
    /**
     * @param {string} questionnaireJsonPath - Path to compiled Questionnaire blueprint
     */
    constructor(questionnaireJsonPath) {
        this.blueprintPath = questionnaireJsonPath;
        this.activeFormFields = [];
        this.adminFields = [];
        this.clientStateContainer = {};
        
        this._loadFormBlueprintDefinitions();
    }

    /**
     * 1. Extract structural context from the compiled Questionnaire blueprint
     */
    _loadFormBlueprintDefinitions() {
        if (!fs.existsSync(this.blueprintPath)) {
            throw new Error(`Critical Runtime Error: Form blueprint target not found at '${this.blueprintPath}'`);
        }

        const blueprint = JSON.parse(fs.readFileSync(this.blueprintPath, 'utf8'));
        
        blueprint.item.forEach(item => {
            const isHidden = item.extension?.some(ext => 
                ext.url === "http://hl7.org" && ext.valueBoolean === true
            );

            if (isHidden) {
                // Track administrative entries separately
                this.adminFields.push({
                    path: item.linkId,
                    defaultValue: item.initial?.[0]?.valueString || null
                });
                // Initialize default value into the client state loop
                this.clientStateContainer[item.linkId] = item.initial?.[0]?.valueString || null;
            } else {
                // Track active visual room workflow components
                this.activeFormFields.push({
                    path: item.linkId,
                    type: item.type,
                    allowedChoices: item.answerOption?.map(opt => opt.valueString) || null
                });
                // Initialize clean memory block allocation
                this.clientStateContainer[item.linkId] = null;
            }
        });
    }

    /**
     * 2. Build the strict JSON Schema object parameter for local model runners (Ollama, Llama.cpp)
     * This forces the LLM to format its output exactly to your active form fields.
     */
    generateModelConstraintSchema() {
        const propertiesObject = {};
        const requiredFieldsArray = [];

        this.activeFormFields.forEach(field => {
            let schemaType = { type: "string" };

            if (field.type === 'decimal' || field.type === 'integer') {
                schemaType = { type: "number" };
            } else if (field.type === 'boolean') {
                schemaType = { type: "boolean" };
            } else if (field.type === 'choice' && field.allowedChoices) {
                schemaType = { type: "string", enum: field.allowedChoices };
            }

            // Assign unique identifier property blocks
            propertiesObject[field.path] = {
                ...schemaType,
                description: `Extracted medical value for target node: ${field.path}`
            };
            requiredFieldsArray.push(field.path);
        });

        // Construct the root structure schema map
        return {
            type: "object",
            properties: propertiesObject,
            required: requiredFieldsArray,
            additionalProperties: false
        };
    }

    /**
     * 3. Process transcription fragments and reconcile data safely into the state container
     * @param {Object} modelExtractionOutput - The constrained JSON payload emitted from the LLM
     */
    reconcileAndPatchState(modelExtractionOutput) {
        console.log("\n⚡ Ingesting raw extraction fragment into Reconciliation Engine...");
        
        const changeLogs = [];

        // Loop through captured active variables and apply deterministic rules
        this.activeFormFields.forEach(field => {
            const incomingValue = modelExtractionOutput[field.path];
            
            if (incomingValue !== undefined && incomingValue !== null) {
                const previousValue = this.clientStateContainer[field.path];
                
                if (previousValue !== incomingValue) {
                    // Update the state machine cache allocation
                    this.clientStateContainer[field.path] = incomingValue;
                    changeLogs.push(`  -> [Updated Form Field] '${field.path}': ${previousValue} ➔ ${incomingValue}`);
                }
            }
        });

        // Automatically maintain administrative system values behind the scenes
        this.adminFields.forEach(adminItem => {
            if (this.clientStateContainer[adminItem.path] !== adminItem.defaultValue) {
                this.clientStateContainer[adminItem.path] = adminItem.defaultValue;
                changeLogs.push(`  -> [Enforced Admin Rule] '${adminItem.path}': Locked to default context '${adminItem.defaultValue}'`);
            }
        });

        // 4. Run Derived Elements Rule: Auto-calculate local safety threshold logic
        this._evaluateDerivedElements(changeLogs);

        if (changeLogs.length > 0) {
            changeLogs.forEach(log => console.log(log));
        } else {
            console.log("  -> No state changes detected. UI elements are perfectly synchronized.");
        }

        return this.clientStateContainer;
    }

    /**
     * Custom interpretation processor simulating algorithmic calculations
     */
    _evaluateDerivedElements(logsCollection) {
        const bpPath = "Observation.valueQuantity"; // Mapped base token node from design-time steps
        const currentBp = this.clientStateContainer[bpPath];

        if (currentBp && typeof currentBp === 'number') {
            const alertNodePath = "Observation.interpretation";
            let derivedAlertStatus = "Normal Range";

            if (currentBp > 140) {
                derivedAlertStatus = "CRITICAL HYPERTENSION RISK";
            } else if (currentBp > 120) {
                derivedAlertStatus = "Elevated Blood Pressure Baseline";
            }

            if (this.clientStateContainer[alertNodePath] !== derivedAlertStatus) {
                this.clientStateContainer[alertNodePath] = derivedAlertStatus;
                logsCollection.push(`  -> [Computed Insight Derived] ${derivedAlertStatus} triggered by input constraint mapping rule.`);
            }
        }
    }

    /**
     * Export the unified runtime state container formatted as a standard FHIR QuestionnaireResponse
     */
    compileFinalQuestionnaireResponse() {
        return {
            resourceType: "QuestionnaireResponse",
            questionnaire: `Questionnaire/${JSON.parse(fs.readFileSync(this.blueprintPath, 'utf8')).id}`,
            status: "completed",
            item: Object.keys(this.clientStateContainer).map(pathKey => ({
                linkId: pathKey,
                answer: [{ valueString: String(this.clientStateContainer[pathKey]) }]
            }))
        };
    }
}
