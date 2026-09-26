-- Generic StructureDefinition-anchored resource mirror (SPEC-24 follow-up, Patient GraphDefinition
-- + generic conformance/search/save API) -- the paid-tier cloud-durable/cross-device counterpart
-- to local-first `formData` (clinux-frontend's own device-scoped TanStack DB collection),
-- generalized one step further than provider_composition (migrations/0005)/task_snapshots
-- (migrations/0010): those are keyed one-row-per-clinic (a real singleton per owner); this is
-- keyed one-row-per-(resource type, resource id), since more than one resource of a given type
-- can exist per clinic (many Patients, unlike one Organization). Patient is the first real
-- consumer (src/lib/control/resource-registry.js only registers Patient this pass) -- NOT
-- Patient-specific by construction, so a future StructureDefinition-anchored entity reuses this
-- same table/routes via a registry entry, not a new migration.
--
-- Same "eventually consistent, best-effort mirror, never the local-first source of truth" model
-- every other D1 mirror in this app already uses -- the owning clinic's own device keeps writing
-- its local-first collection first; this table is what a search/cross-device pull reads from.
CREATE TABLE IF NOT EXISTS resource_records (
    resource_type TEXT NOT NULL,       -- e.g. 'Patient' -- matches StructureDefinition.type
    id TEXT NOT NULL,                  -- the resource's own FHIR id (local-pat-<uuid> today)
    clinic_id TEXT NOT NULL REFERENCES clinics(id),
    data TEXT NOT NULL,                -- the full, already-StructureDefinition-validated FHIR resource JSON
    -- Promoted search columns -- deliberately NOT a generic key/value sidecar table; the small,
    -- known set of fields real search UIs need, decided per-resourceType by
    -- src/lib/control/resource-registry.js's own searchFieldExtractor, nullable so a resource
    -- type (or a Patient with no ABHA yet) simply leaves what doesn't apply blank.
    search_name TEXT,                  -- Patient.name (given+family joined) today
    search_mobile TEXT,                -- Patient.telecom:mobile.value today
    search_identifier TEXT,            -- Patient.identifier:abhaNumber/abhaAddress.value today
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (resource_type, id)
);

CREATE INDEX IF NOT EXISTS idx_resource_records_clinic ON resource_records (clinic_id, resource_type);
CREATE INDEX IF NOT EXISTS idx_resource_records_search
    ON resource_records (clinic_id, resource_type, search_name, search_mobile, search_identifier);
