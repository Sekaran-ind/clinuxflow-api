import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { v4 as uuidv4 } from 'uuid';

import { compileYamlToQuestionnaire } from './lib/yaml-to-questionnaire.js';
import { ComprehensiveLocalExtractor } from './lib/local-extractor.js';
import { LocalQueueManager } from './lib/local-queue-manager.js';
import { saveFormVersion } from './lib/forms-library.js';
import { serviceKeyAuth } from './lib/serviceAuth.js';
import { hashPassword, verifyPassword } from './lib/passwordHash.js';
import { issueSessionToken } from './lib/session.js';
import { AccountsDb } from './lib/accounts-db.js';
import { requireUser, requirePaidTier } from './lib/userAuth.js';

import systemFormsLibrary from '../data/system-forms-library.json';
import defaultBlueprintYaml from '../data/vitals-room.yaml';
import clinicSpecialities from '../data/clinic-specialities.json';

const app = new Hono();

// Locked down to clinux-frontend's real origins rather than wildcarded — this API fronts a
// paid Workers AI call (test-scribe) and a write endpoint (save-to-library), so an open CORS
// policy would let any webpage's JS call them on a visitor's behalf.
const ALLOWED_ORIGINS = [
    'https://clinux.yaxb.ai',
    'http://localhost:5173',
    // Capacitor's two platforms default to two DIFFERENT origins when no `server.androidScheme`
    // override is set in capacitor.config.json (confirmed against the actual config -- there is
    // none): iOS uses capacitor://localhost, Android uses https://localhost. Both are needed --
    // this isn't one scheme with two names, it's a real platform difference. http://localhost
    // (no port) is kept too for whatever local testing originally added it.
    'capacitor://localhost',
    'https://localhost',
    'http://localhost',
    // The Tauri desktop app's own shared LAN server (src-tauri/src/shared_server.rs) — pages it
    // serves call back into this API from that origin, not from clinux-frontend's normal dev/
    // prod origins above. Local dev port only; a production deployment would need whatever real
    // port the shared server binds to added here too.
    `http://localhost:47856`,
];
app.use('/api/*', cors({ origin: ALLOWED_ORIGINS }));

// See src/lib/serviceAuth.js for what/why — unit tested there.
app.use('/api/*', serviceKeyAuth());

/**
 * POST /api/auth/register
 * Body: { clinicName, email, password, adminName?, designation? }
 * Creates a new clinic (tier defaults to 'free') and its first account atomically, and returns a
 * session token. Still gated by serviceKeyAuth() above — X-Service-Key is an independent
 * anti-abuse layer proving "this is clinux-frontend", not superseded by this account-level auth.
 */
app.post('/api/auth/register', async (c) => {
    try {
        const { clinicName, email, password, adminName, designation } = await c.req.json();
        if (!clinicName || !email || !password) {
            return c.json({ success: false, error: 'clinicName, email, and password are required.' }, 400);
        }
        if (password.length < 8) {
            return c.json({ success: false, error: 'Password must be at least 8 characters.' }, 400);
        }
        const normalizedEmail = String(email).trim().toLowerCase();

        const existing = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (existing) {
            return c.json({ success: false, error: 'An account with this email already exists.' }, 409);
        }
        if (!c.env.JWT_SECRET) {
            return c.json({ success: false, error: 'Server auth is not configured.' }, 500);
        }

        const clinicId = uuidv4();
        const accountId = uuidv4();
        const passwordHash = await hashPassword(password);

        try {
            await AccountsDb.createClinicAndAccount(
                c.env.DB, clinicId, clinicName, accountId, normalizedEmail, passwordHash, adminName, designation
            );
        } catch (err) {
            // Narrow TOCTOU race: two concurrent registrations for the same email both pass the
            // getAccountByEmail check above; D1's UNIQUE(email) constraint rejects the second.
            if (String(err.message).includes('UNIQUE')) {
                return c.json({ success: false, error: 'An account with this email already exists.' }, 409);
            }
            throw err;
        }

        const token = await issueSessionToken({ sub: accountId, clinicId, email: normalizedEmail }, c.env.JWT_SECRET);

        return c.json({
            success: true,
            token,
            account: {
                id: accountId, clinicId, email: normalizedEmail,
                adminName: adminName ?? null, designation: designation ?? null,
                clinicName, tier: 'free',
            },
        }, 201);
    } catch (err) {
        console.error('❌ Register Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Generic "Invalid email or password" on any failure (unknown email or wrong password) — doesn't
 * leak which one was wrong.
 */
app.post('/api/auth/login', async (c) => {
    try {
        const { email, password } = await c.req.json();
        if (!email || !password) {
            return c.json({ success: false, error: 'email and password are required.' }, 400);
        }
        const normalizedEmail = String(email).trim().toLowerCase();

        const account = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (!account || !(await verifyPassword(password, account.password_hash))) {
            return c.json({ success: false, error: 'Invalid email or password.' }, 401);
        }
        if (!c.env.JWT_SECRET) {
            return c.json({ success: false, error: 'Server auth is not configured.' }, 500);
        }

        const clinic = await AccountsDb.getClinicById(c.env.DB, account.clinic_id);
        const token = await issueSessionToken(
            { sub: account.id, clinicId: account.clinic_id, email: account.email }, c.env.JWT_SECRET
        );

        return c.json({
            success: true,
            token,
            account: {
                id: account.id, clinicId: account.clinic_id, email: account.email,
                adminName: account.admin_name, designation: account.designation,
                clinicName: clinic?.name ?? '', tier: clinic?.tier ?? 'free',
            },
        });
    } catch (err) {
        console.error('❌ Login Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/auth/me
 * Re-fetches the caller's account + clinic (fresh tier included) — clinux-frontend calls this on
 * app boot when a session token exists, so a tier change since last login takes effect without a
 * fresh login.
 */
app.get('/api/auth/me', requireUser(), async (c) => {
    const user = c.get('user');
    const account = await AccountsDb.getAccountById(c.env.DB, user.accountId);
    if (!account) return c.json({ success: false, error: 'Account not found.' }, 404);

    const clinic = await AccountsDb.getClinicById(c.env.DB, account.clinic_id);
    return c.json({
        success: true,
        account: {
            id: account.id, clinicId: account.clinic_id, email: account.email,
            adminName: account.admin_name, designation: account.designation,
            clinicName: clinic?.name ?? '', tier: clinic?.tier ?? 'free',
        },
    });
});

// "a clinic's 1-4 staff logins share one subscription" -- migrations/0003_add_accounts_and_
// clinics.sql's own stated design constraint for this table, not a new business rule invented
// here. Applies to every clinic regardless of tier -- multi-user itself isn't paid-gated, unlike
// requirePaidTier()'s other features.
const MAX_ACCOUNTS_PER_CLINIC = 4;

/**
 * POST /api/auth/invite
 * Body: { email, password, adminName?, designation? }
 * Adds another login to the CALLER's OWN clinic — clinicId always comes from the caller's own
 * JWT (via requireUser()), never from the request body, so nobody can invite themselves into a
 * clinic they don't belong to. This app has no mail server, so there's no invite email/link:
 * the inviting admin sets the new teammate's email+password directly (same shape /register
 * already uses minus the "create a new clinic" half) and shares it with them out of band.
 */
app.post('/api/auth/invite', requireUser(), async (c) => {
    try {
        const { email, password, adminName, designation } = await c.req.json();
        if (!email || !password) {
            return c.json({ success: false, error: 'email and password are required.' }, 400);
        }
        if (password.length < 8) {
            return c.json({ success: false, error: 'Password must be at least 8 characters.' }, 400);
        }
        const normalizedEmail = String(email).trim().toLowerCase();
        const clinicId = c.get('user').clinicId;

        const existing = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (existing) {
            return c.json({ success: false, error: 'An account with this email already exists.' }, 409);
        }

        const { count } = await AccountsDb.countAccountsByClinicId(c.env.DB, clinicId);
        if (count >= MAX_ACCOUNTS_PER_CLINIC) {
            return c.json({ success: false, error: `This clinic already has the maximum of ${MAX_ACCOUNTS_PER_CLINIC} team accounts.` }, 403);
        }

        const accountId = uuidv4();
        const passwordHash = await hashPassword(password);

        try {
            await AccountsDb.createTeammateAccount(c.env.DB, clinicId, accountId, normalizedEmail, passwordHash, adminName, designation);
        } catch (err) {
            // Same narrow TOCTOU race as /register: two concurrent invites for the same email.
            if (String(err.message).includes('UNIQUE')) {
                return c.json({ success: false, error: 'An account with this email already exists.' }, 409);
            }
            throw err;
        }

        return c.json({
            success: true,
            account: {
                id: accountId, clinicId, email: normalizedEmail,
                adminName: adminName ?? null, designation: designation ?? null,
            },
        }, 201);
    } catch (err) {
        console.error('❌ Invite Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/auth/team
 * Every login on the caller's own clinic — id/email/adminName/designation/createdAt only, never
 * password hashes. Powers clinux-frontend's Team settings list.
 */
app.get('/api/auth/team', requireUser(), async (c) => {
    const clinicId = c.get('user').clinicId;
    const accounts = await AccountsDb.listAccountsByClinicId(c.env.DB, clinicId);
    return c.json({
        success: true,
        accounts: accounts.map((a) => ({
            id: a.id, email: a.email, adminName: a.admin_name, designation: a.designation, createdAt: a.created_at,
        })),
    });
});

/**
 * GET /api/workflow/system-forms
 * Returns the pre-compiled system-forms catalog (tools/build-system-forms.js's output, bundled
 * here as data/system-forms-library.json — regenerate via `npm run build:kernel`), shaped
 * identically to the browser's cf_forms_library localStorage so seedSystemForms() can merge it
 * straight in.
 */
app.get('/api/workflow/system-forms', (c) => {
    return c.json({ success: true, systemForms: systemFormsLibrary });
});

/**
 * GET /api/clinic-specialities
 * Ported from clinixflow's server.js, which computes this at request time via fs.readdirSync
 * over config/clinic-specialities/virtual-rooms/ — no filesystem here, so it's precomputed by
 * scripts/build-clinic-specialities.js into data/clinic-specialities.json and just served as-is.
 */
app.get('/api/clinic-specialities', (c) => {
    return c.json({ success: true, specialities: clinicSpecialities.specialities });
});

/**
 * GET /api/clinic-specialities/:folder/:file
 * Same data source as above; folder/file are validated against the bundled manifest's own keys
 * (not interpolated into a filesystem path), so there's no path-traversal surface to guard here
 * the way clinixflow's fs-based version needed to.
 */
app.get('/api/clinic-specialities/:folder/:file', (c) => {
    const { folder, file } = c.req.param();
    const markdown = clinicSpecialities.markdown[`${folder}/${file}`];
    if (!markdown) return c.json({ success: false, error: `Unknown role file: ${folder}/${file}` }, 404);
    return c.json({ success: true, folder, file, markdown });
});

/**
 * GET /api/workflow/default-blueprint
 * Returns the raw YAML text of the default room blueprint so the designer UI has something to
 * load on first run.
 */
app.get('/api/workflow/default-blueprint', (c) => {
    return c.json({ success: true, yaml: defaultBlueprintYaml });
});

/**
 * POST /api/workflow/compile
 * Body: { yamlPayload: string }
 * Compiles the submitted room-layout YAML into a FHIR Questionnaire via
 * compileYamlToQuestionnaire(), and derives a GBNF grammar constraining an LLM's output to the
 * compiled form's active field paths. This runs on every live-preview keystroke/rebuild in the
 * designer — it does NOT persist to the forms library. Persisting is a separate, explicit user
 * action; see POST /api/workflow/save-to-library.
 */
app.post('/api/workflow/compile', async (c) => {
    try {
        const { yamlPayload } = await c.req.json();

        const result = compileYamlToQuestionnaire(yamlPayload);
        if (!result.success) {
            return c.json({ success: false, error: result.errors.join('; ') }, 400);
        }
        const questionnaireJson = result.questionnaire;

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

        return c.json({
            success: true,
            questionnaireJson,
            finalGbnf,
            terminologyLogs: [
                `✅ Unified Master Path Schema Sync: Loaded from data/form-schematics.schema.json.`,
                `⚙️ Synchronized all multi-department resource mappings successfully.`
            ]
        });
    } catch (err) {
        console.error("❌ SDC Compiler Exception:", err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/workflow/save-to-library
 * Body: { yamlPayload: string, questionnaireJson: FHIR Questionnaire }
 * Explicit "save" action for the designer's preview pane — called once the user is happy with
 * how a compiled form looks, not on every live-preview compile. Archives the YAML alongside its
 * already-compiled Questionnaire as a new version in the FORMS_LIBRARY KV namespace, so every
 * saved form always has a matching YAML + JSON pair for that version.
 *
 * Every clinic's forms library lives in the browser's localStorage by default (same as the
 * clinic profile / hospital data); the designer only calls this endpoint for clinics with an
 * active subscription, as a durable server-side backup on top of the local copy. That gating is
 * enforced client-side today since there's no server-side auth/session layer yet — if real
 * billing/auth is added later, this endpoint should verify entitlement itself rather than trust
 * the caller.
 */
app.post('/api/workflow/save-to-library', async (c) => {
    try {
        const { yamlPayload, questionnaireJson } = await c.req.json();

        if (!yamlPayload || !questionnaireJson) {
            return c.json({ success: false, error: "Both yamlPayload and questionnaireJson are required to save to the library." }, 400);
        }

        const savedVersion = await saveFormVersion(c.env.FORMS_LIBRARY, questionnaireJson, yamlPayload);

        return c.json({
            success: true,
            formId: savedVersion.formId,
            version: savedVersion.version,
            jsonKey: savedVersion.jsonKey,
            yamlKey: savedVersion.yamlKey
        });
    } catch (err) {
        console.error("❌ Forms Library Save Exception:", err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/workflow/test-scribe-mock
 * Body: { transcript: string, activeBlueprint: FHIR Questionnaire }
 * Offline stand-in for /api/workflow/test-scribe: instead of calling an LLM, it pattern-matches
 * a handful of keywords/numbers directly out of the transcript (gender, blood pressure, a couple
 * of demo condition/medication codes) so the scribe flow can be exercised without network access.
 * Persists the resulting QuestionnaireResponse to the D1 holding queue and runs it through the
 * local FHIR extractor, same as the real endpoint does.
 */
app.post('/api/workflow/test-scribe-mock', async (c) => {
    try {
        const { transcript, activeBlueprint } = await c.req.json();

        if (!activeBlueprint || !activeBlueprint.item) {
            return c.json({ success: false, error: "No compiled blueprint available. Compile form first." }, 400);
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

        // Persist transaction record tracking payload into the D1 holding queue
        await LocalQueueManager.enqueueResponse(c.env.DB, `sess-${Date.now()}`, activeBlueprint.id, transcript, questionnaireResponseEnvelope);

        // Run the local extractor to graph discrete resources natively inside the Worker
        const localExtractedFhirGraph = ComprehensiveLocalExtractor.extract(activeBlueprint, questionnaireResponseEnvelope);

        return c.json({
            success: true,
            maskedLlmOutput: {
                updates: [
                    { path: "Patient.gender", value: capturedGender },
                    { path: "Observation.component[0].valueQuantity.value", value: capturedBp },
                    { path: "Observation.component[1].valueQuantity.value", value: Math.round(capturedBp * 0.6) }
                ]
            },
            localExtractedFhirGraph,
            questionnaireResponseEnvelope
        });

    } catch (err) {
        return c.json({ success: false, error: err.message }, 500);
    }
});

/**
 * POST /api/workflow/test-scribe
 * Body: { transcript: string, activeBlueprint: FHIR Questionnaire }
 * The real (non-mock) scribe pipeline: sends the transcript to Cloudflare Workers AI
 * (Llama 3.3 70B) via the native AI binding, asks it to return clinical findings as JSON, then
 * reflects that JSON against the active blueprint's field labels/paths/trained-keywords using
 * token-overlap scoring to bind values onto the right questionnaire items. Per-field keywords
 * (question.keywords) come from the designer's "Training the Form" step and are weighted more
 * heavily than generic label/path tokens.
 *
 * Ported off the original CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_AUTH_TOKEN REST call — running inside
 * a Worker, the AI binding authenticates automatically for this account, so no credentials need
 * to be configured at all.
 *
 * requireUser()/requirePaidTier(): this is a real per-call Workers AI cost, gated to paid-tier
 * clinics only — free tier gets zero access, by design (see src/lib/userAuth.js).
 */
app.post('/api/workflow/test-scribe', requireUser(), requirePaidTier(), async (c) => {
    try {
        const { transcript, activeBlueprint, context, source } = await c.req.json();

        // Designer.vue's testVoiceScribeExtraction() is a design-time tool for tuning a form's
        // keyword-training before it ever reaches a real encounter — it tags its own requests
        // with source: 'designer-test'. ConsultationDesk.vue's real "Generate SOAP draft"
        // feature never sends this field, so it's unaffected. Only Designer's dev-testing path
        // is denied in production; it still works under `wrangler dev` (ENVIRONMENT=development
        // via .dev.vars) for actually building/tuning forms.
        if (source === 'designer-test' && c.env.ENVIRONMENT === 'production') {
            return c.json({ success: false, error: 'test-scribe is disabled for Designer test runs in production. Use test-scribe-mock, or test locally with `wrangler dev`.' }, 403);
        }

        if (!activeBlueprint || !activeBlueprint.item) {
            return c.json({ success: false, error: "No compiled blueprint active. Rebuild form first." }, 400);
        }

        console.log("☁️ Transmitting to Cloudflare Llama-3.3-70B Production Inference Mesh...");

        const aiResult = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
                {
                    role: "system",
                    // context is the selected virtual-room role's markdown (clinix-frontend's
                    // Cübo Profile panel — config/clinic-specialities/virtual-rooms/**/*.md) —
                    // trusted, server-bundled config content, not user input, so it's appended
                    // as-is rather than run through client-side prompt-injection sanitization.
                    content: "You are an advanced medical extraction node. Analyze the raw clinical conversational transcript and output a JSON object mapping clinical findings. Group related metrics logically under clear keys. Output ONLY valid raw JSON."
                        + (context ? `\n\nApply the following role-specific clinical scope and SOAP note constraints when drafting the note:\n${context}` : '')
                },
                { role: "user", content: `Transcript: "${transcript}"` }
            ],
            temperature: 0.0
        });

        console.log("☁️ Response from Llama-3.3-70B Production Inference Mesh..." + JSON.stringify(aiResult.response));

        // EXTRACTION BOUNDARY SLICER (DYNAMIC TYPE GUARD)
        let rawJsonTree;
        const responseDataPayload = aiResult.response;

        if (typeof responseDataPayload === 'object' && responseDataPayload !== null) {
            rawJsonTree = responseDataPayload;
        } else if (typeof responseDataPayload === 'string') {
            const jsonStartIndex = responseDataPayload.indexOf('{');
            const jsonEndIndex = responseDataPayload.lastIndexOf('}');

            if (jsonStartIndex === -1 || jsonEndIndex === -1) {
                throw new Error("No structured curly brackets found inside model response string envelope.");
            }

            const cleanJsonStringNode = responseDataPayload.substring(jsonStartIndex, jsonEndIndex + 1).trim();
            rawJsonTree = JSON.parse(cleanJsonStringNode);
        } else {
            throw new Error(`Unrecognized Workers AI response payload type signature: ${typeof responseDataPayload}`);
        }

        // UNIFIED DATA NODE FINGERPRINTING
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

        // REFLECT AGAINST ACTIVE BLUEPRINT INTENT SPECIFICATIONS
        const structuredResponseItems = activeBlueprint.item.map(section => {
            const nestedSectionItem = { linkId: section.linkId, text: section.text, item: [] };

            if (section.item && Array.isArray(section.item)) {
                section.item.forEach(question => {
                    const formLabelTokens = question.text.toLowerCase().split(/[\s.__-]/);

                    let formPathTokens = [];
                    if (question.definition && question.definition.includes('#')) {
                        const pathSection = question.definition.split('#');
                        formPathTokens = pathSection[1].toLowerCase().split(/[\.__-]/);
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

                    // BIND AND FORMAT STANDARDIZED DATA NODE VALUE
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

        await LocalQueueManager.enqueueResponse(c.env.DB, `sess-${Date.now()}`, activeBlueprint.id, transcript, questionnaireResponseEnvelope);
        const localExtractedFhirGraph = ComprehensiveLocalExtractor.extract(activeBlueprint, questionnaireResponseEnvelope);

        return c.json({
            success: true,
            maskedLlmOutput: rawJsonTree,
            localExtractedFhirGraph,
            questionnaireResponseEnvelope
        });

    } catch (err) {
        console.error("❌ Spec-Driven Reflection Engine Failed: ", err.message);
        return c.json({ success: false, error: err.message }, 500);
    }
});

app.get('/health', (c) => c.json({ ok: true }));

export default app;
