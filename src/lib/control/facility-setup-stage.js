// Server-side mirror of clinux-frontend's facilitySetupMachine.js (data/control/
// facilitySetupMachine.js) — SAME four stages, same guard ordering, same default eligibility bar.
// Deliberately a plain function here, not a ported XState machine: the Worker has no existing
// xstate dependency, and pulling one in for a four-branch classifier this small would be
// overkill just for symmetry's sake. The REAL logic — draft -> basics_saved -> published ->
// hfr_registered, "published" (not full HFR) as the default join-token eligibility bar — has to
// match the frontend's exactly, since the frontend badge and this server-side gate must never
// silently disagree about what stage a facility is in; keep the two files' guard conditions in
// sync by hand if either ever changes, same as any other cross-repo duplication in this codebase
// (e.g. abdmAdapter.js's body builders vs. the real gateway routes they target).
//
// Unlike the frontend machine, this reads real DURABLE signals — provider_composition's own
// `data`/`published_at` columns (migrations/0012), not live local-first collection state, since
// this runs server-side with no access to a device's own TanStack DB.
export function deriveFacilitySetupStage({ hasBasics, publishedAt, hfrFacilityId } = {}) {
  if (hfrFacilityId && publishedAt) return 'hfr_registered';
  if (publishedAt) return 'published';
  if (hasBasics) return 'basics_saved';
  return 'draft';
}

export function canAcceptFacilityJoinToken(stage) {
  return stage === 'published' || stage === 'hfr_registered';
}

// Reads a provider_composition row (getProviderComposition's own return shape:
// {data, updatedAt, publishedAt}) and derives the stage in one call — the shape every route this
// pass needs (issue, redeem) actually wants, so they don't each re-derive hasBasics/hfrFacilityId
// extraction by hand.
// Recursive walk + multi-type answer extraction, deliberately mirroring clinux-frontend's own
// getAnswer()/extractAnswerValue() (data/collections/formData.js) exactly — hospital_name/
// hospital_facility_id can sit at any depth under section_hospital, not necessarily as direct
// children, and a value can legitimately arrive as valueBoolean/valueDecimal/etc, not just
// valueString (see that file's own answerFor() fix this session for why assuming valueString
// alone is a real bug, not a simplification).
function findAnswer(items, linkId) {
  for (const item of items || []) {
    if (item.linkId === linkId && item.answer?.[0]) {
      const a = item.answer[0];
      return a.valueString ?? a.valueDecimal ?? a.valueInteger ?? a.valueBoolean ?? a.valueDate
        ?? (a.valueCoding && (a.valueCoding.display ?? a.valueCoding.code)) ?? null;
    }
    if (item.item) {
      const found = findAnswer(item.item, linkId);
      if (found !== null) return found;
    }
  }
  return null;
}

export function deriveStageFromCompositionRow(row) {
  if (!row) return 'draft';
  let hasBasics = false;
  let hfrFacilityId = null;
  try {
    const doc = JSON.parse(row.data);
    hasBasics = !!findAnswer(doc?.item, 'hospital_name');
    hfrFacilityId = findAnswer(doc?.item, 'hospital_facility_id');
  } catch {
    // Malformed/legacy data — treat as no basics captured rather than throwing; the gate should
    // fail closed (draft), not 500.
  }
  return deriveFacilitySetupStage({ hasBasics, publishedAt: row.publishedAt, hfrFacilityId });
}
