// D1-backed persistence for the encounterId -> Cloudflare RealtimeKit meeting id mapping.
// Schema: migrations/0004_add_encounter_meetings.sql.
export const EncounterMeetingsDb = {
    getByEncounterId: (db, encounterId) => {
        return db.prepare("SELECT * FROM encounter_meetings WHERE encounter_id = ?").bind(encounterId).first();
    },

    create: (db, encounterId, clinicId, cfMeetingId) => {
        return db.prepare(
            "INSERT INTO encounter_meetings (encounter_id, clinic_id, cf_meeting_id) VALUES (?, ?, ?)"
        ).bind(encounterId, clinicId, cfMeetingId).run();
    },
};
