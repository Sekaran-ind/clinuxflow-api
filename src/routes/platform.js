// SPEC-24-adjacent (NIST ZTA discussion) — genuinely layer-agnostic: serving/saving the compiled
// forms/flows library (used by control-layer AND runtime-layer forms alike) and the bare health
// check. Mounted unprefixed (`app.route('/', platformRoutes)`) by src/index.js, so every path
// below is already the real, final route — no rewriting.
import { Hono } from 'hono';
import { saveFormVersion } from '../lib/shared/forms-library.js';

import systemFormsLibrary from '../../data/system-forms-library.json';
import systemFlowsLibrary from '../../data/system-flows-library.json';

export const platformRoutes = new Hono();
const app = platformRoutes;

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
 * GET /api/workflow/system-flows
 * SPEC-22 decision #2's real loader — the actual missing link between the SPEC-18 YAML-authoring
 * pipeline and the frontend's workflowRuntime.js/planDefinitionRunner.js, which until now only
 * ever ran hand-authored JS PlanDefinition objects. Returns the pre-compiled-and-extracted
 * system-flows catalog (tools/build-system-flows.js's output, bundled as
 * data/system-flows-library.json — regenerate via `npm run build:system-flows`), shaped like
 * clinux-frontend's flowsLibrary.js collection rows so seedSystemFlows() can merge it straight in,
 * same "seed once, never overwrite a locally-edited copy" convention system-forms above uses.
 */
app.get('/api/workflow/system-flows', (c) => {
    return c.json({ success: true, systemFlows: systemFlowsLibrary });
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

app.get('/health', (c) => c.json({ ok: true }));
