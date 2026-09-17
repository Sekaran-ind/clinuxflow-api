// D1-backed persistence for the roomId -> Cloudflare RealtimeKit meeting id mapping, for
// contact-to-contact (not encounter-scoped) video calls. Schema: migrations/0011_add_contact_
// meetings.sql. Deliberately the same shape as encounter-meetings-db.js, not shared code with
// it — the two tables' key concepts (a deterministic account-pair string vs. a real
// encounterId foreign key) are different enough that forcing one function to serve both would
// just mean threading an extra "which table" parameter through, for no real gain.
export const ContactMeetingsDb = {
    getByRoomId: (db, roomId) => {
        return db.prepare("SELECT * FROM contact_meetings WHERE room_id = ?").bind(roomId).first();
    },

    create: (db, roomId, cfMeetingId) => {
        return db.prepare(
            "INSERT INTO contact_meetings (room_id, cf_meeting_id) VALUES (?, ?)"
        ).bind(roomId, cfMeetingId).run();
    },
};
