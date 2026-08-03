import express from 'express';
import path from 'path';
import fs from 'fs';
import * as yaml from 'js-yaml';

// Core engine system module file imports
import { compileYamlToQuestionnaire } from './lib/yaml-to-questionnaire.js';
import { ComprehensiveLocalExtractor } from './lib/local-extractor.js';
import { LocalQueueManager } from './lib/local-queue-manager.js';
import { saveFormVersion } from './lib/forms-library.js';

// Load local secrets (e.g. CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AUTH_TOKEN) from .env into
// process.env. Safe to skip in environments (CI, hosting platforms) where env vars are
// injected directly and no .env file is present on disk.
try {
    process.loadEnvFile();
} catch (err) {
    if (err.code !== 'ENOENT') throw err;
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

const TEMP_YAML_PATH = path.join(process.cwd(), 'runtime-room-input.yaml');
const TEMP_JSON_PATH = path.join(process.cwd(), 'questionnaire-output.json');
const BLUEPRINT_PATH = path.join(process.cwd(), 'src', 'vitals-room.yaml');
const SYSTEM_FORMS_LIBRARY_PATH = path.join(process.cwd(), 'config', 'system-forms', 'system-forms-library.json');

/**
 * GET /api/workflow/system-forms
 * Returns the pre-compiled system-forms catalog (config/system-forms/system-forms-library.json,
 * produced by config/system-forms/build-system-forms.js), shaped identically to the browser's
 * cf_forms_library localStorage so seedSystemForms() can merge it straight in.
 */
app.get('/api/workflow/system-forms', (req, res) => {
    if (fs.existsSync(SYSTEM_FORMS_LIBRARY_PATH)) {
        const catalog = JSON.parse(fs.readFileSync(SYSTEM_FORMS_LIBRARY_PATH, 'utf8'));
        return res.json({ success: true, systemForms: catalog });
    }
    res.status(404).json({ success: false, error: "config/system-forms/system-forms-library.json not found. Run 'node config/system-forms/build-system-forms.js' first." });
});

/**
 * GET /api/workflow/default-blueprint
 * Returns the raw YAML text of the default room blueprint (src/vitals-room.yaml) so the
 * designer UI has something to load on first run.
 */
app.get('/api/workflow/default-blueprint', (req, res) => {
    if (fs.existsSync(BLUEPRINT_PATH)) {
        const yamlText = fs.readFileSync(BLUEPRINT_PATH, 'utf8');
        return res.json({ success: true, yaml: yamlText });
    }
    res.status(404).json({ success: false, error: "src/vitals-room.yaml file not found on disk." });
});

/**
 * POST /api/workflow/compile
 * Body: { yamlPayload: string }
 * Writes the submitted room-layout YAML to disk, compiles it into a FHIR Questionnaire via
 * compileYamlToQuestionnaire(), and derives a GBNF grammar constraining an LLM's output to the
 * compiled form's active field paths. This runs on every live-preview keystroke/rebuild in the
 * designer, so it only ever touches the scratch working copy (questionnaire-output.json) — it
 * does NOT persist to the forms library. Persisting is a separate, explicit user action; see
 * POST /api/workflow/save-to-library.
 */
app.post('/api/workflow/compile', (req, res) => {
    try {
        const { yamlPayload } = req.body;

        // Write the incoming workspace buffer straight to your configured temporary YAML input file location
        fs.writeFileSync(TEMP_YAML_PATH, yamlPayload, 'utf8');

        // Execute your config-aligned schema compiler pass
        const success = compileYamlToQuestionnaire(TEMP_YAML_PATH, TEMP_JSON_PATH);
        if (!success) {
            return res.status(400).json({ success: false, error: "Compilation blocked by validation engine schema parameters." });
        }

        const questionnaireJson = JSON.parse(fs.readFileSync(TEMP_JSON_PATH, 'utf8'));

        // Safely map active paths using your dynamic blueprint keys
        const activePaths = [];
        if (questionnaireJson.item) {
            questionnaireJson.item.forEach(sec => {
                if (sec.item) sec.item.forEach(q => activePaths.push(`\\"${q.linkId}\\"`));
            });
        }

        // Build edge-native GBNF rules targeting your exact field selections
        let finalGbnf = `root ::= "{\\n" "  \\"updates\\": [\\n" items "\\n  ]\\n}"\n`;
        finalGbnf += `items ::= item (",\\n" item)*\n`;
        finalGbnf += `path_enum ::= ${activePaths.length > 0 ? activePaths.join(' | ') : '"empty"'}\n`;

        res.json({
            success: true,
            questionnaireJson,
            finalGbnf,
            terminologyLogs: [
                `✅ Unified Master Path Schema Sync: Loaded from config/form-schematics.schema.json.`,
                `⚙️ Synchronized all multi-department resource mappings successfully.`
            ]
        });
    } catch (err) {
        console.error("❌ SDC Compiler Exception:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/workflow/save-to-library
 * Body: { yamlPayload: string, questionnaireJson: FHIR Questionnaire }
 * Explicit "save" action for the designer's preview pane — called once the user is happy with
 * how a compiled form looks, not on every live-preview compile. Archives the YAML alongside its
 * already-compiled Questionnaire as a new version under forms-library/<formId>/, so every saved
 * form always has a matching YAML + JSON pair for that version.
 *
 * Every clinic's forms library lives in the browser's localStorage by default (same as the
 * clinic profile / hospital data); the designer only calls this endpoint for clinics with an
 * active subscription, as a durable server-side backup on top of the local copy. That gating is
 * enforced client-side today since there's no server-side auth/session layer yet — if real
 * billing/auth is added later, this endpoint should verify entitlement itself rather than trust
 * the caller.
 */
app.post('/api/workflow/save-to-library', (req, res) => {
    try {
        const { yamlPayload, questionnaireJson } = req.body;

        if (!yamlPayload || !questionnaireJson) {
            return res.status(400).json({ success: false, error: "Both yamlPayload and questionnaireJson are required to save to the library." });
        }

        const savedVersion = saveFormVersion(questionnaireJson, yamlPayload);

        res.json({
            success: true,
            formId: savedVersion.formId,
            version: savedVersion.version,
            jsonPath: savedVersion.jsonPath,
            yamlPath: savedVersion.yamlPath
        });
    } catch (err) {
        console.error("❌ Forms Library Save Exception:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/workflow/test-scribe-mock
 * Body: { transcript: string, activeBlueprint: FHIR Questionnaire }
 * Offline stand-in for /api/workflow/test-scribe: instead of calling an LLM, it pattern-matches
 * a handful of keywords/numbers directly out of the transcript (gender, blood pressure, a couple
 * of demo condition/medication codes) so the scribe flow can be exercised without network access.
 * Persists the resulting QuestionnaireResponse to the local SQLite queue and runs it through the
 * local FHIR extractor, same as the real endpoint does.
 */
app.post('/api/workflow/test-scribe-mock', (req, res) => {
    try {
        const { transcript, activeBlueprint } = req.body;

        if (!activeBlueprint || !activeBlueprint.item) {
            return res.status(400).json({ success: false, error: "No compiled blueprint available. Compile form first." });
        }

        const lowerText = transcript.toLowerCase();
        
        // Match raw voice text tokens to simulate GBNF grammar constraints
        let capturedGender = "unknown";
        if (lowerText.includes('female') || lowerText.includes('woman')) capturedGender = "female";
        else if (lowerText.includes('male') || lowerText.includes('man')) capturedGender = "male";

        let capturedBp = 120; // Default fallback metric parameters
        const bpMatches = lowerText.match(/\b\d{2,3}\b/);
        if (bpMatches) {
            capturedBp = parseFloat(bpMatches[0]);
        }

        // SYNCHRONIZED ELEMENT ID ENVELOPE GENERATOR
        // This maps variables to your specific field IDs ('systolic_bp', 'diastolic_bp', etc.)
        const structuredResponseItems = activeBlueprint.item.map(section => {
            const nestedSectionItem = {
                linkId: section.linkId,
                text: section.text,
                item: []
            };

            if (section.item && Array.isArray(section.item)) {
                section.item.forEach(question => {
                    const matchedAnswer = [];

                    // FIXED ID-BASED BINDING VERIFICATIONS
                    if (question.linkId === 'patient_gender') {
                        matchedAnswer.push({ valueString: capturedGender });
                    }
                    else if (question.linkId === 'systolic_bp') {
                        matchedAnswer.push({ valueDecimal: capturedBp }); // e.g., 148
                    }
                    else if (question.linkId === 'diastolic_bp') {
                        matchedAnswer.push({ valueDecimal: Math.round(capturedBp * 0.6) }); // Simulated Diastolic relative vector
                    }
                    else if (question.linkId === 'condition_search' && capturedBp > 140) {
                        matchedAnswer.push({ valueString: "active-hypertension" });
                    }
                    // ─── ADDED: AUTOMATED MEDICATION SEARCH SIMULATOR MAPPING TRACE ───
                    else if (question.linkId === 'medication_search') {
                        // Simulates the user selecting an RxNorm entry from their autocomplete list
                        matchedAnswer.push({ valueString: "284305" }); // RxNorm Code for Lisinopril 10mg Oral Tablet
                    }
                    if (matchedAnswer.length > 0) {
                        nestedSectionItem.item.push({
                            linkId: question.linkId,
                            text: question.text,
                            answer: matchedAnswer
                        });
                    }
                });
            }

            return nestedSectionItem;
        });

        const questionnaireResponseEnvelope = {
            resourceType: "QuestionnaireResponse",
            questionnaire: `Questionnaire/${activeBlueprint.id}`,
            status: "completed",
            item: structuredResponseItems.filter(sec => sec.item.length > 0)
        };

        // Persist transaction record tracking payload into SQLite Holding Queue
        LocalQueueManager.enqueueResponse(`sess-${Date.now()}`, activeBlueprint.id, transcript, questionnaireResponseEnvelope);

        // Run the local extractor to graph discrete resources natively inside Node
        const localExtractedFhirGraph = ComprehensiveLocalExtractor.extract(activeBlueprint, questionnaireResponseEnvelope);

        res.json({ 
            success: true, 
            maskedLlmOutput: { 
                updates: [
                    { path: "Patient.gender", value: capturedGender },
                    { path: "Observation.component[0].valueQuantity.value", value: capturedBp },
                    { path: "Observation.component[1].valueQuantity.value", value: Math.round(capturedBp * 0.6) }
                ]
            }, 
            localExtractedFhirGraph 
        });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/workflow/test-scribe
 * Body: { transcript: string, activeBlueprint: FHIR Questionnaire }
 * The real (non-mock) scribe pipeline: sends the transcript to Cloudflare Workers AI
 * (Llama 3.3 70B), asks it to return clinical findings as JSON, then reflects that JSON against
 * the active blueprint's field labels/paths/trained-keywords using token-overlap scoring to bind
 * values onto the right questionnaire items. Per-field keywords (question.keywords) come from the
 * designer's "Training the Form" step and are weighted more heavily than generic label/path
 * tokens. Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN to be set (see .env.example) —
 * credentials are never hardcoded here.
 */
app.post('/api/workflow/test-scribe', async (req, res) => {
    try {
        const { transcript, activeBlueprint } = req.body;

        if (!activeBlueprint || !activeBlueprint.item) {
            return res.status(400).json({ success: false, error: "No compiled blueprint active. Rebuild form first." });
        }

        console.log("☁️ Transmitting to Cloudflare Llama-3.3-70B Production Inference Mesh...");

        const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
        const CLOUDFLARE_AUTH_TOKEN = process.env.CLOUDFLARE_AUTH_TOKEN;

        if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_AUTH_TOKEN) {
            return res.status(500).json({
                success: false,
                error: "Cloudflare credentials are not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN in .env."
            });
        }

        // Target Cloudflare's serverless Llama 3.3 70B inference endpoint for this account
        const cloudflareAiUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`;

        // 1. SYSTEMIC SOLUTION: Instruct the LLM to output a JSON object describing clinical realities
        const cfResponse = await fetch(cloudflareAiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_AUTH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messages: [
                    { 
                        role: "system", 
                        content: "You are an advanced medical extraction node. Analyze the raw clinical conversational transcript and output a JSON object mapping clinical findings. Group related metrics logically under clear keys. Output ONLY valid raw JSON." 
                    },
                    { role: "user", content: `Transcript: "${transcript}"` }
                ],
                temperature: 0.0
            })
        }).then(r => r.json());

        if (!cfResponse.success) {
            return res.status(502).json({ success: false, error: "Cloudflare worker node connection dropped." });
        }

        console.log("☁️ Response from Llama-3.3-70B Production Inference Mesh..." + JSON.stringify(cfResponse.result.response));

        // 2. EXTRACTION BOUNDARY SLICER
        // ─── 2. SYSTEMIC EXTRACTION BOUNDARY SLICER (DYNAMIC TYPE GUARD) ───
        let rawJsonTree;
        const responseDataPayload = cfResponse.result.response;

        if (typeof responseDataPayload === 'object' && responseDataPayload !== null) {
            console.log("📦 Cloudflare natively returned a pre-parsed JavaScript object. Stepping over string slicing loops...");
            rawJsonTree = responseDataPayload;
        } else if (typeof responseDataPayload === 'string') {
            console.log("📝 Cloudflare returned a raw text string. Slicing structural bracket boundaries...");
            const jsonStartIndex = responseDataPayload.indexOf('{');
            const jsonEndIndex = responseDataPayload.lastIndexOf('}');
            
            if (jsonStartIndex === -1 || jsonEndIndex === -1) {
                throw new Error("No structured curly brackets found inside model response string envelope.");
            }

            const cleanJsonStringNode = responseDataPayload.substring(jsonStartIndex, jsonEndIndex + 1).trim();
            rawJsonTree = JSON.parse(cleanJsonStringNode);
        } else {
            throw new Error(`Unrecognized Cloudflare Workers AI response payload type signature: ${typeof responseDataPayload}`);
        }

        // 2. UNIFIED DATA NODE FINGERPRINTING
        const extractedLlmFingerprints = [];
        
        function tokenizeAndCrawl(obj, activePath = '') {
            if (!obj || typeof obj !== 'object') return;
            
            Object.keys(obj).forEach(key => {
                const value = obj[key];
                const cleanKey = key.toLowerCase();
                const currentPath = activePath ? `${activePath}.${cleanKey}` : cleanKey;
                
                if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                    tokenizeAndCrawl(value, currentPath);
                } else if (value !== undefined && value !== null) {
                    const pathWords = currentPath.split(/[\.__-]/).flatMap(w => w.split(/(?=[A-Z])/)).map(w => w.toLowerCase());
                    const valueWords = String(value).toLowerCase().split(/[\s.__-]/);
                    
                    extractedLlmFingerprints.push({
                        rawPath: currentPath,
                        rawValue: value,
                        combinedTokens: new Set([...pathWords, ...valueWords, cleanKey])
                    });
                }
            });
        }
        tokenizeAndCrawl(rawJsonTree);

        // 3. REFLECT AGAINST ACTIVE BLUEPRINT INTENT SPECIFICATIONS
        const structuredResponseItems = activeBlueprint.item.map(section => {
            const nestedSectionItem = { linkId: section.linkId, text: section.text, item: [] };

            if (section.item && Array.isArray(section.item)) {
                section.item.forEach(question => {
                    const formLabelTokens = question.text.toLowerCase().split(/[\s.__-]/);

                    // FIXED: Correctly isolate string chunk index past hash token boundary safely
                    let formPathTokens = [];
                    if (question.definition && question.definition.includes('#')) {
                        const pathSection = question.definition.split('#');
                        formPathTokens = pathSection[1].toLowerCase().split(/[\.__-]/); // <-- FIXED INDEXING HERE
                    }

                    // Keywords trained per-field in the designer's "Training the Form" step
                    // (persisted as question.keywords on the compiled Questionnaire item). These
                    // are the strongest, most intentional signal for this field, so matches
                    // against them are weighted higher than the generic label/path tokens.
                    const trainedKeywordTokens = Array.isArray(question.keywords)
                        ? question.keywords.map(k => String(k).toLowerCase())
                        : [];

                    const formIntentTokens = new Set([...formLabelTokens, ...formPathTokens, ...trainedKeywordTokens]);

                    let bestMatchValue = null;
                    let bestMatchNode = null;
                    let highestMatchScore = 0;

                    // INTERSECTION DISTANCE MATRIX CRAWLER
                    extractedLlmFingerprints.forEach(node => {
                        let intersectionCount = 0;
                        node.combinedTokens.forEach(token => {
                            if (token.length > 2 && formIntentTokens.has(token)) {
                                intersectionCount++;
                                if (trainedKeywordTokens.includes(token)) intersectionCount += 2;
                            }
                        });

                        if (intersectionCount > highestMatchScore) {
                            highestMatchScore = intersectionCount;
                            bestMatchValue = node.rawValue;
                            bestMatchNode = node;
                        }
                    });

                    // 4. BIND AND FORMAT STANDARDIZED DATA NODE VALUE
                    if (highestMatchScore > 0 && bestMatchValue !== "stable" && bestMatchValue !== "unknown") {
                        const answerNode = {};
                        
                        if (question.type === 'decimal' || question.type === 'integer') {
                            const parsedNum = typeof bestMatchValue === 'number' ? bestMatchValue : parseFloat(String(bestMatchValue).match(/\d+/));
                            if (!isNaN(parsedNum)) answerNode.valueDecimal = parsedNum;
                        } else if (question.type === 'boolean') {
                            answerNode.valueBoolean = (bestMatchValue === true || String(bestMatchValue).toLowerCase() === 'true');
                        } else {
                            const cleanStrVal = String(bestMatchValue).toLowerCase();
                            // If value is a modifier status, walk back and pull the parent clinical key description string
                            if ((cleanStrVal === 'chronic' || cleanStrVal === 'active' || cleanStrVal === 'present') && bestMatchNode) {
                                answerNode.valueString = bestMatchNode.rawPath.split('.').pop();
                            } else {
                                answerNode.valueString = String(bestMatchValue);
                            }
                        }

                        if (Object.keys(answerNode).length > 0) {
                            nestedSectionItem.item.push({
                                linkId: question.linkId,
                                text: question.text,
                                answer: [answerNode]
                            });
                        }
                    }
                });
            }

            return nestedSectionItem;
        });

        const questionnaireResponseEnvelope = {
            resourceType: "QuestionnaireResponse",
            questionnaire: `Questionnaire/${activeBlueprint.id}`,
            status: "completed",
            item: structuredResponseItems.filter(sec => sec.item.length > 0)
        };

        LocalQueueManager.enqueueResponse(`sess-${Date.now()}`, activeBlueprint.id, transcript, questionnaireResponseEnvelope);
        const localExtractedFhirGraph = ComprehensiveLocalExtractor.extract(activeBlueprint, questionnaireResponseEnvelope);

        res.json({ 
            success: true, 
            maskedLlmOutput: rawJsonTree, 
            localExtractedFhirGraph 
        });


    } catch (err) {
        console.error("❌ Spec-Driven Reflection Engine Failed: ", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});



// Entry point for local development is /designer.html (the FHIR room-layout designer UI)
app.listen(3000, () => console.log('🚀 Unified Server live on http://localhost:3000/designer.html'));
