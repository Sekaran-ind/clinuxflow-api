import { WorkflowOrchestrator } from './workflow-orchestrator.js';

async function executeSimulationScenario() {
    const orchestrator = new WorkflowOrchestrator('http://localhost:8080/fhir');

    // 1. Trigger compilation for a Cardiology Specialist Room Context
    const roomAssets = orchestrator.assembleRoomContext('Doctor', 'Cardiology');

    // 2. Access your compiled assets cleanly
    const uiBlueprint = roomAssets.uiQuestionnaire;
    const aiGrammarPath = roomAssets.aiGbnfFile;

    console.log(`\n🎉 System Assets Ready for Clinical Deployment:`);
    console.log(`  ➔ Screen Layout Asset JSON ready to send to browser.`);
    console.log(`  ➔ Local AI Grammar constraint file sitting at: ${aiGrammarPath}`);

    const mockFilledFormResponse = {
        resourceType: "QuestionnaireResponse",
        questionnaire: `Questionnaire/${uiBlueprint.id}`,
        status: "completed",
        item: [
            { linkId: "Patient.gender", answer: [{ valueString: "female" }] },
            { linkId: "Observation.valueQuantity", answer: [{ valueDecimal: 138.0 }] },
            { linkId: "Condition.clinicalStatus", answer: [{ valueString: "active-murmur" }] }
        ]
    };

    await orchestrator.transmitAndExtractToHapi(mockFilledFormResponse);
}

executeSimulationScenario();
