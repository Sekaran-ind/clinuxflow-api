import { describe, expect, it } from 'vitest';
import { deriveFacilitySetupStage, canAcceptFacilityJoinToken, deriveStageFromCompositionRow } from './facility-setup-stage.js';

describe('deriveFacilitySetupStage', () => {
  it('is draft when nothing captured', () => {
    expect(deriveFacilitySetupStage({})).toBe('draft');
  });
  it('is basics_saved once a name exists but never published', () => {
    expect(deriveFacilitySetupStage({ hasBasics: true, publishedAt: null })).toBe('basics_saved');
  });
  it('is published once publishedAt is set, regardless of HFR', () => {
    expect(deriveFacilitySetupStage({ hasBasics: true, publishedAt: '2026-09-09T00:00:00Z' })).toBe('published');
  });
  it('is hfr_registered only once BOTH published and a real facilityId exist', () => {
    expect(deriveFacilitySetupStage({ hasBasics: true, publishedAt: '2026-09-09T00:00:00Z', hfrFacilityId: 'HFR123' })).toBe('hfr_registered');
  });
  it('does not skip to hfr_registered off a facilityId alone if never published', () => {
    expect(deriveFacilitySetupStage({ hasBasics: true, publishedAt: null, hfrFacilityId: 'HFR123' })).toBe('basics_saved');
  });
});

describe('canAcceptFacilityJoinToken', () => {
  it('false for draft/basics_saved, true for published/hfr_registered', () => {
    expect(canAcceptFacilityJoinToken('draft')).toBe(false);
    expect(canAcceptFacilityJoinToken('basics_saved')).toBe(false);
    expect(canAcceptFacilityJoinToken('published')).toBe(true);
    expect(canAcceptFacilityJoinToken('hfr_registered')).toBe(true);
  });
});

describe('deriveStageFromCompositionRow', () => {
  it('is draft when no row exists at all', () => {
    expect(deriveStageFromCompositionRow(null)).toBe('draft');
  });

  it('reads hospital_name/hospital_facility_id at any nesting depth, mirroring getAnswer()', () => {
    const data = {
      resourceType: 'QuestionnaireResponse',
      item: [
        {
          linkId: 'section_hospital',
          item: [
            { linkId: 'hospital_name', answer: [{ valueString: 'ABC Hospital' }] },
            { linkId: 'hospital_facility_id', answer: [{ valueString: 'HFR999' }] },
          ],
        },
      ],
    };
    const row = { data: JSON.stringify(data), publishedAt: '2026-09-09T00:00:00Z' };
    expect(deriveStageFromCompositionRow(row)).toBe('hfr_registered');
  });

  it('treats malformed JSON as draft rather than throwing', () => {
    expect(deriveStageFromCompositionRow({ data: 'not json', publishedAt: null })).toBe('draft');
  });

  it('is basics_saved when a name exists but published_at is null', () => {
    const data = { item: [{ linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'X' }] }] }] };
    const row = { data: JSON.stringify(data), publishedAt: null };
    expect(deriveStageFromCompositionRow(row)).toBe('basics_saved');
  });
});
