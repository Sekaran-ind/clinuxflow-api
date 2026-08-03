// Persistent, versioned archive of designer forms, backed by a Workers KV namespace. A form is
// only archived here when the user explicitly saves it from the designer's preview pane (not on
// every live-preview compile) — see POST /api/workflow/save-to-library in src/index.js. Each
// save keeps BOTH the source YAML and its compiled FHIR Questionnaire together, so every version
// can be re-opened for editing or re-served as-is.
// Ported from the original filesystem version (forms-library/<formId>/v1.json + v1.yaml, ...) —
// Workers has no filesystem, so this now takes the KV binding (env.FORMS_LIBRARY) as an explicit
// argument. Key layout: formlib:<formId>:versions (index), formlib:<formId>:v<N>.json/.yaml.

/**
 * Persists a compiled FHIR Questionnaire (and the room-layout YAML it was compiled from) into
 * the KV-backed forms library, keyed by its formId. Each call writes a new version pair,
 * numbered one higher than the highest version already saved for that formId (starting at 1 if
 * none exist yet). The saved resource's meta.versionId/meta.lastUpdated are stamped to match,
 * per the standard FHIR resource versioning convention.
 * @param {KVNamespace} kv - The FORMS_LIBRARY KV binding.
 * @param {Object} questionnaireJson - The compiled FHIR Questionnaire resource (must have an `id`).
 * @param {string} yamlSource - The room-layout YAML text that was compiled into questionnaireJson.
 * @returns {Promise<{ formId: string, version: number, jsonKey: string, yamlKey: string, resource: Object }>}
 */
export async function saveFormVersion(kv, questionnaireJson, yamlSource) {
    const formId = questionnaireJson.id;
    if (!formId) {
        throw new Error("Cannot save to forms library: compiled Questionnaire is missing an 'id' (formId).");
    }

    const indexKey = `formlib:${formId}:versions`;
    const existingVersions = (await kv.get(indexKey, 'json')) || [];
    const nextVersion = existingVersions.length > 0 ? Math.max(...existingVersions) + 1 : 1;

    const versionedResource = {
        ...questionnaireJson,
        meta: {
            ...(questionnaireJson.meta || {}),
            versionId: String(nextVersion),
            lastUpdated: new Date().toISOString()
        }
    };

    const jsonKey = `formlib:${formId}:v${nextVersion}.json`;
    const yamlKey = `formlib:${formId}:v${nextVersion}.yaml`;

    await kv.put(jsonKey, JSON.stringify(versionedResource));
    await kv.put(yamlKey, yamlSource);
    await kv.put(indexKey, JSON.stringify([...existingVersions, nextVersion]));

    return {
        formId,
        version: nextVersion,
        jsonKey,
        yamlKey,
        resource: versionedResource
    };
}
