// D1-backed persistence for the generic resource_records mirror (migrations/0013). Same style as
// AccountsDb.getProviderComposition/upsertProviderComposition — a thin, direct accessor, no ORM.
// Every function is resourceType-generic; nothing here hard-codes 'Patient'. See
// resource-registry.js for the per-resourceType config (StructureDefinition/GraphDefinition/
// search-field extraction) this module's callers use to decide WHAT to write, not this module
// itself — this file only knows how to read/write rows, not what they mean.
export const ResourceRecordsDb = {
    get: (db, resourceType, id, clinicId) => {
        return db.prepare(
            'SELECT resource_type, id, data, updated_at AS updatedAt FROM resource_records WHERE resource_type = ? AND id = ? AND clinic_id = ?'
        ).bind(resourceType, id, clinicId).first();
    },

    // q is matched against all 3 promoted search columns (OR'd) via a plain LIKE — this is a
    // best-effort substring search over a small per-clinic table, not a full-text index; fine for
    // the realistic scale (patients at one clinic), not intended to generalize further than that.
    // Returns a plain array (unwraps D1's {results,...} envelope here), matching
    // AccountsDb.listAffiliatesByFacility/JoinTokensDb.listByClinic's own convention.
    search: async (db, resourceType, clinicId, q, limit = 25) => {
        if (!q) {
            const { results } = await db.prepare(
                'SELECT resource_type, id, data, updated_at AS updatedAt FROM resource_records WHERE resource_type = ? AND clinic_id = ? ORDER BY updated_at DESC LIMIT ?'
            ).bind(resourceType, clinicId, limit).all();
            return results;
        }
        const like = `%${q}%`;
        const { results } = await db.prepare(
            `SELECT resource_type, id, data, updated_at AS updatedAt FROM resource_records
             WHERE resource_type = ? AND clinic_id = ?
               AND (search_name LIKE ? OR search_mobile LIKE ? OR search_identifier LIKE ?)
             ORDER BY updated_at DESC LIMIT ?`
        ).bind(resourceType, clinicId, like, like, like, limit).all();
        return results;
    },

    // searchFields: { search_name, search_mobile, search_identifier } — already extracted by the
    // caller via resource-registry.js's searchFieldExtractor, kept as a plain object here rather
    // than this module reaching back into StructureDefinition-shaped data itself.
    upsert: (db, resourceType, id, clinicId, dataJson, searchFields = {}) => {
        const { search_name = null, search_mobile = null, search_identifier = null } = searchFields;
        return db.prepare(
            `INSERT INTO resource_records (resource_type, id, clinic_id, data, search_name, search_mobile, search_identifier, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(resource_type, id) DO UPDATE SET
                clinic_id = excluded.clinic_id,
                data = excluded.data,
                search_name = excluded.search_name,
                search_mobile = excluded.search_mobile,
                search_identifier = excluded.search_identifier,
                updated_at = excluded.updated_at`
        ).bind(resourceType, id, clinicId, dataJson, search_name, search_mobile, search_identifier).run();
    },
};
