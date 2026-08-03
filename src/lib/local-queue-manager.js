// D1-backed persistence layer for the scribe workflow: clinic profile info, per-room YAML
// workflow configs, and a holding queue of scribe-captured QuestionnaireResponses awaiting
// human review before they're accepted into the record. Ported from the original
// better-sqlite3 version (see clinuxflow-api/legacy-data/database.sqlite) — better-sqlite3 is a
// native Node addon and can't run in Workers, so this now takes the D1 binding (env.DB) as an
// explicit argument on every call instead of opening a file on disk.
// Schema (see migrations/0001_init.sql):
//   partner_profile(id, hospital_name, address)
//   room_workflows(room_id, role, specialty, yaml_payload)
//   local_holding_queue(session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at)

export const LocalQueueManager = {
    // Single-row upsert: this app currently supports exactly one clinic/hospital profile (id = 1).
    savePartner: (db, name, address) => {
        return db.prepare("INSERT OR REPLACE INTO partner_profile (id, hospital_name, address) VALUES (1, ?, ?)")
            .bind(name, address).run();
    },

    getPartner: (db) => {
        return db.prepare("SELECT * FROM partner_profile WHERE id = 1").first();
    },

    // Persists the YAML room-layout config assigned to a given room/role/specialty combination.
    saveWorkflow: (db, roomId, role, specialty, yaml) => {
        return db.prepare("INSERT OR REPLACE INTO room_workflows (room_id, role, specialty, yaml_payload) VALUES (?, ?, ?, ?)")
            .bind(roomId, role, specialty, yaml).run();
    },

    getWorkflow: (db, roomId) => {
        return db.prepare("SELECT * FROM room_workflows WHERE room_id = ?").bind(roomId).first();
    },

    // Records a captured scribe transcript + its compiled QuestionnaireResponse as
    // 'pending_review' so a clinician can approve it before it's treated as authoritative.
    enqueueResponse: (db, sessionId, roomId, transcript, responseJson) => {
        return db.prepare("INSERT OR REPLACE INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES (?, ?, ?, ?, 'pending_review', ?)")
            .bind(sessionId, roomId, transcript, JSON.stringify(responseJson), new Date().toISOString()).run();
    },

    getPendingQueue: async (db) => {
        const { results } = await db.prepare("SELECT * FROM local_holding_queue WHERE status = 'pending_review'").all();
        return results;
    }
};
