import fs from 'fs';
import { ComprehensiveLocalExtractor } from '../lib/local-extractor.js';

const mockQuestionnaireContract = {
    resourceType: "Questionnaire",
    id: "comprehensive-triage-v1",
    item: [
        {
            linkId: "Patient.name[0].family", // Added array index indicator for complex FHIR handling
            type: "string",
            definition: "http://hl7.org"
        },
        {
            linkId: "Patient.gender",
            type: "choice",
            definition: "http://hl7.org"
        },
        {
            linkId: "Observation.valueQuantity.value",
            type: "decimal",
            definition: "http://hl7.org"
        },
        {
            linkId: "Condition.note[0].text", // Handled array annotation wrapper parameters
            type: "string",
            definition: "http://hl7.org"
        }
    ]
};

const clinicianApprovedResponseForm = {
    resourceType: "QuestionnaireResponse",
    id: "triage-session-101",
    questionnaire: "Questionnaire/comprehensive-triage-v1",
    status: "completed",
    item: [
        { linkId: "Patient.name[0].family", answer: [{ valueString: "Smith" }] },
        { linkId: "Patient.gender", answer: [{ valueString: "male" }] },
        { linkId: "Observation.valueQuantity.value", answer: [{ valueDecimal: 120.5 }] },
        { linkId: "Condition.note[0].text", answer: [{ valueString: "Patient mentions mild chest tightness under heavy exertion." }] }
    ]
};

async function executeProductionExtraction() {
    console.log("🎬 Initiating edge verification simulation runner...");

    const coreInteroperableBundle = ComprehensiveLocalExtractor.extract(
        mockQuestionnaireContract, 
        clinicianApprovedResponseForm
    );

    console.log("\n💎 Extracted Operational Code Assets Graph Object Output:");
    console.log(JSON.stringify(coreInteroperableBundle, null, 2));

    console.log("\n🔬 Verifying Structural Connectivity Paths:");
    const observation = coreInteroperableBundle.find(r => r.resourceType === 'Observation');
    const patient = coreInteroperableBundle.find(r => r.resourceType === 'Patient');
    
    console.log(`  -> Patient Resource Generated ID: ${patient.id}`);
    console.log(`  -> Observation Linked Subject Reference target: ${observation.subject.reference}`);
    
    if (observation.subject.reference === `Patient/${patient.id}`) {
        console.log("  -> SUCCESS: Graph connectivity rules executed flawlessly without breaking database dependencies.");
    } else {
        console.error("  -> INTEGRITY FAULT: Disconnected graph assets detected.");
    }
}

executeProductionExtraction();
