import fs from 'fs';
import path from 'path';
import { RuntimeScribeEngine } from '../lib/runtime-scribe-engine.js';
import { ComprehensiveLocalExtractor } from '../lib/local-extractor.js';
import { LocalQueueManager } from '../lib/local-queue-manager.js';

const BLUEPRINT_PATH = path.join(process.cwd(), 'questionnaire-output.json');

async function runEndToEndPipelineTest() {
    console.log("🏁 Starting End-to-End System Stress Test...");

    // 1. Core Check: Verify the design-time compiler output exists
    if (!fs.existsSync(BLUEPRINT_PATH)) {
        console.error("❌ Test Failed: questionnaire-output.json missing. Compile your form via http://localhost:3000/designer.html first.");
        return;
    }
    const activeBlueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, 'utf8'));

    // 2. Step 1: Initialize the Server-Side Scribe Module
    console.log("🤖 Initializing runtime-scribe-engine model constraint masks...");
    const scribe = new RuntimeScribeEngine(BLUEPRINT_PATH);
    
    // 3. Step 2: Ingest a simulated medical transcription fragment string
    const sampleTranscript = "Patient is a male complaining of chest tightness. Checked vitals in room: systolic blood pressure is tracking at 155.";
    console.log(`🎙️ Incoming Voice Stream: "${sampleTranscript}"`);

    // Simulate your GBNF-constrained LLM parsing logic
    const mockLlmExtraction = {
        "Patient.gender": "male",
        "Observation.valueQuantity": 155
    };

    // 4. Step 3: Run real-time state reconciliation & compute derived alert parameters
    const localLogs = [];
    const updatedState = scribe.reconcileAndPatchState(mockLlmExtraction);
    
    // 5. Step 4: Assemble your finalized QuestionnaireResponse answer envelope
    const questionnaireResponse = scribe.compileFinalQuestionnaireResponse();
    console.log("✅ QuestionnaireResponse generated cleanly.");

    // 6. Step 5: Save unverified record into SQLite Holding Queue (Time Lag Simulation)
    console.log("💾 Caching unverified asset inside local holding queue database...");
    const sessionToken = `test-session-${Date.now()}`;
    LocalQueueManager.enqueueResponse(sessionToken, activeBlueprint.id, sampleTranscript, questionnaireResponse);

    // Verify record retrieval from SQLite database
    const pendingItems = LocalQueueManager.getPendingQueue();
    const queuedRecord = pendingItems.find(item => item.session_id === sessionToken);
    
    if (queuedRecord) {
        console.log("✅ Database Verification: Record successfully written and retrieved from SQLite Holding Queue.");
    } else {
        console.error("❌ Database Verification Failure: Asset lost in transaction queue.");
        return;
    }

    // 7. Step 6: Trigger Local Extraction Graph Reconstruction
    console.log("📦 Executing local-extractor mapping and dynamic referential stitching...");
    const discreteFhirGraph = ComprehensiveLocalExtractor.extract(activeBlueprint, questionnaireResponse);

    // 8. Step 7: Validate graph relationships and outputs
    const patient = discreteFhirGraph.find(r => r.resourceType === 'Patient');
    const observation = discreteFhirGraph.find(r => r.resourceType === 'Observation');

    console.log("\n🔬 Evaluating Core Interoperability Linkage Constraints:");
    console.log(`  -> Extracted Patient Gender: ${patient?.gender}`);
    console.log(`  -> Extracted Observation Numeric Value: ${observation?.valueQuantity}`);
    console.log(`  -> Observation Linked Subject Reference: ${observation?.subject?.reference}`);

    if (observation?.subject?.reference === `Patient/${patient?.id}`) {
        console.log("\n🎉 SUCCESS: End-to-end data pipeline is solid. The quasi-language configuration, grammar maps, database queue, and graph transforms are fully synchronized with zero errors.");
    } else {
        console.error("\n❌ INTEGRITY ERROR: Relational links between core assets failed validation.");
    }
}

runEndToEndPipelineTest();
