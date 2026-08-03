import { v4 as uuidv4 } from 'uuid';

// Converts a completed FHIR QuestionnaireResponse back into a set of discrete FHIR resources
// (Patient, Observation, Condition, ...), using each Questionnaire item's `definition` string
// (e.g. "http://hl7.org/Observation#Observation.component.valueQuantity.value") to know which
// resource type and property path an answer belongs to. Runs entirely locally/offline — no
// external FHIR server or LLM call is involved in this step.
export class ComprehensiveLocalExtractor {
    /**
     * Executes a strict local definition-based SDC extraction operation
     * @param {Object} questionnaireBlueprint - The compiled FHIR Questionnaire
     * @param {Object} responsePayload - The human-approved QuestionnaireResponse
     * @returns {Object[]} An array of fully formed, interconnected, valid FHIR resources
     */
    static extract(questionnaireBlueprint, responsePayload) {
        console.log(`⚙️ Compiling and transforming data stream for form context: ${responsePayload.id || 'anonymous'}`);
        
        const blueprintMap = new Map();
        
        function flattenItems(itemsList) {
            if (!itemsList || !Array.isArray(itemsList)) return;
            itemsList.forEach(item => {
                if (item.linkId && item.definition) {
                    blueprintMap.set(item.linkId, {
                        definition: item.definition,
                        type: item.type
                    });
                }
                if (item.item && Array.isArray(item.item)) {
                    flattenItems(item.item);
                }
            });
        }
        
        flattenItems(questionnaireBlueprint.item);

        const resourceCache = {};
        const referenceTrackingTable = { Patient: null, Encounter: null };

        const targetPatientId = `local-pat-${uuidv4()}`;
        const targetEncounterId = `local-enc-${uuidv4()}`;
        
        referenceTrackingTable.Patient = `Patient/${targetPatientId}`;
        referenceTrackingTable.Encounter = `Encounter/${targetEncounterId}`;

        // Track active array index counts dynamically per resource path block to prevent collisions
        const dynamicArrayIndexTrackingLedger = new Map();

        function extractAnswers(itemsList) {
            if (!itemsList || !Array.isArray(itemsList)) return;
            
            itemsList.forEach(answeredItem => {
                const meta = blueprintMap.get(answeredItem.linkId);
                
                if (meta && meta.definition && answeredItem.answer && answeredItem.answer.length > 0) {
                    const uriFragments = meta.definition.split('#');
                    if (uriFragments.length < 2) return;

                    const rightHandPathString = uriFragments[1];
                    const pathTokens = rightHandPathString.split('.');
                    
                    const resourceType = pathTokens[0];
                    const propertyPath = pathTokens.slice(1).join('.');

                    const cleanValue = ComprehensiveLocalExtractor._extractAnswerValue(answeredItem.answer[0]);
                    if (cleanValue !== undefined && cleanValue !== null) {
                        if (!resourceCache[resourceType]) {
                            resourceCache[resourceType] = {
                                resourceType: resourceType,
                                id: resourceType === 'Patient' ? targetPatientId : 
                                    resourceType === 'Encounter' ? targetEncounterId : `local-res-${uuidv4()}`,
                                meta: {
                                    lastUpdated: new Date().toISOString(),
                                    source: "clinixflow-edge-scribe"
                                }
                            };
                        }
                        
                        // Deduplicate list indices cleanly by checking active item count on the tracking ledger
                        const combinationTrackingKey = `${resourceType}.${propertyPath}`;
                        if (!dynamicArrayIndexTrackingLedger.has(combinationTrackingKey)) {
                            dynamicArrayIndexTrackingLedger.set(combinationTrackingKey, []);
                        }
                        
                        const processedLinkIdsList = dynamicArrayIndexTrackingLedger.get(combinationTrackingKey);
                        let targetSlotIndex = processedLinkIdsList.indexOf(answeredItem.linkId);
                        
                        if (targetSlotIndex === -1) {
                            processedLinkIdsList.push(answeredItem.linkId);
                            targetSlotIndex = processedLinkIdsList.length - 1;
                        }

                        ComprehensiveLocalExtractor._setValueAtPath(
                            resourceCache[resourceType], 
                            propertyPath, 
                            cleanValue, 
                            targetSlotIndex
                        );
                    }
                }

                if (answeredItem.item && Array.isArray(answeredItem.item)) {
                    extractAnswers(answeredItem.item);
                }
            });
        }

        extractAnswers(responsePayload.item);

        const finalizedOutputResources = [];

        Object.keys(resourceCache).forEach(type => {
            const resource = resourceCache[type];

            if (type === 'Observation') {
                if (!resource.status) resource.status = 'final';
                resource.subject = { reference: referenceTrackingTable.Patient };
                resource.encounter = { reference: referenceTrackingTable.Encounter };
            }

            if (type === 'Condition' || type === 'MedicationRequest') {
                resource.subject = { reference: referenceTrackingTable.Patient };
            }

            // ─── NEW: AUTOMATED ADMINISTRATIVE ONBOARDING REFERENCE LINKS ───
            if (type === 'Location' && resourceCache.Organization) {
                // Automatically tie the physical office branch to the parent corporate entity
                resource.managingOrganization = { reference: `Organization/${resourceCache.Organization.id}` };
            }
            if (type === 'PractitionerRole' && resourceCache.Practitioner && resourceCache.Organization) {
                // Link the medical staff member's active profile role to the practice facility
                resource.practitioner = { reference: `Practitioner/${resourceCache.Practitioner.id}` };
                resource.organization = { reference: `Organization/${resourceCache.Organization.id}` };
            }

            finalizedOutputResources.push(resource);
        });

        console.log(`  ➔ Comprehensive conversion complete. Extracted ${finalizedOutputResources.length} interdependent resources.`);
        return finalizedOutputResources;
    }

    // Unwraps a FHIR answer node's typed value (valueDecimal/valueInteger/valueBoolean/valueDate),
    // falling back to valueString for everything else.
    static _extractAnswerValue(fhirAnswerNode) {
        if (!fhirAnswerNode) return null;
        if (fhirAnswerNode.valueDecimal !== undefined) return fhirAnswerNode.valueDecimal;
        if (fhirAnswerNode.valueInteger !== undefined) return fhirAnswerNode.valueInteger;
        if (fhirAnswerNode.valueBoolean !== undefined) return fhirAnswerNode.valueBoolean;
        if (fhirAnswerNode.valueDate !== undefined) return fhirAnswerNode.valueDate;
        return fhirAnswerNode.valueString || null;
    }

    /**
     * Writes assignedValue onto targetObj at the given dot-separated property path, creating
     * intermediate objects as needed. Two path segments get special array handling because they
     * are FHIR list properties that this extractor populates positionally:
     *   - "component" (e.g. Observation.component[i].valueQuantity.value — one entry per vital sign)
     *   - "coding" (wraps the value as { code: assignedValue } per FHIR's Coding shape)
     * dynamicIndexOffset selects which array slot a "component"/"coding" segment writes into, so
     * that repeated answers bound to the same resource land in separate list entries instead of
     * overwriting each other.
     */
    static _setValueAtPath(targetObj, dotPathString, assignedValue, dynamicIndexOffset = 0) {
        const segments = dotPathString.split('.');
        let activePointer = targetObj;

        for (let i = 0; i < segments.length; i++) {
            let currentKey = segments[i];
            const isLastNode = (i === segments.length - 1);

            const isArrayType = (currentKey === 'component' || currentKey === 'coding');
            const targetArrayIndex = isArrayType ? dynamicIndexOffset : 0;

            if (isLastNode) {
                if (isArrayType) {
                    if (!Array.isArray(activePointer[currentKey])) activePointer[currentKey] = [];
                    activePointer[currentKey][targetArrayIndex] = currentKey === 'coding' ? { code: assignedValue } : assignedValue;
                } else {
                    activePointer[currentKey] = assignedValue;
                }
            } else {
                if (isArrayType) {
                    if (!Array.isArray(activePointer[currentKey])) activePointer[currentKey] = [];
                    if (!activePointer[currentKey][targetArrayIndex]) activePointer[currentKey][targetArrayIndex] = {};
                    activePointer = activePointer[currentKey][targetArrayIndex];
                } else {
                    if (isLastNode === false && segments[i + 1] === 'coding' && !activePointer[currentKey]) {
                        activePointer[currentKey] = {};
                    }
                    if (!activePointer[currentKey]) activePointer[currentKey] = {};
                    activePointer = activePointer[currentKey];
                }
            }
        }
    }
}
