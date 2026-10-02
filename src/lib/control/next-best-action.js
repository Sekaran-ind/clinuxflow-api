// SPEC-24 §3 — the structural half of "what should this facility/provider onboarding do next":
// walks GraphDefinition.link[] and surfaces, for every link whose SOURCE resource already exists
// in the bundle and passes conformance validation, a candidate to create/fix the link's TARGET.
// Pure, stateless, recomputed fresh on every call from whatever `currentResourceBundle` the caller
// currently holds — no actor, no persisted status, no XState (SPEC-23's own "no plan definition or
// workflow for onboarding" correction stays true; see docs/SPEC-24-...md §3's own honest split:
// GraphDefinition supplies structural sequencing for free via its reference topology,
// business-rule sequencing is designed to live in each StructureDefinition's own invariants
// instead, not yet built).
//
// Scoped to how ClinuxFlowOnboardingGraph.json actually authors its own links — a `path` of
// "<ResourceType>.<field>" plus this app's own graph-link-direction/graph-link-profiles
// extensions — not a general arbitrary-GraphDefinition executor, the same deliberate scoping
// conformance-validator.js already uses for StructureDefinition (see its own header).
//
// Forward vs. reverse links get genuinely different "is this candidate still open" logic, because
// they mean different things structurally, not because of an arbitrary convention:
//   - forward (e.g. 'practitioner-behind-role', 'affiliate-partner-org'): the link's own `path`
//     names a single Reference element on the source resource itself (FHIR 0..1/1..1 by
//     construction, never an array) — genuinely "done" once that reference resolves to a target
//     resource actually present in the bundle, so the candidate is suppressed once satisfied.
//   - reverse (e.g. 'role-at-facility', 'affiliation-from-facility'): the source is the ONE
//     (an Organization), the target type is the MANY (PractitionerRole / OrganizationAffiliation,
//     genuinely 0..* in real FHIR) — there is no single count that means "done"; onboarding staff
//     is naturally open-ended. These stay offered as an available action for as long as the source
//     is valid; whether to act on it again is the caller/UI's call, not this function's.
//
// A reverse link's own source TYPE isn't named anywhere on the link itself (its `path` names the
// referencing FIELD, e.g. 'organization', not what resource type owns that field as a source) —
// this graph only ever reverses back to its own root, so `graphDefinition.start` is used. That is
// a real, deliberate scoping to what ClinuxFlowOnboardingGraph.json actually contains (a single
// root radiating outward), not a general rule for an arbitrary future GraphDefinition.

const DIRECTION_EXT = 'https://clinux.yaxb.ai/fhir/StructureDefinition/graph-link-direction';
const PROFILES_EXT = 'https://clinux.yaxb.ai/fhir/StructureDefinition/graph-link-profiles';

function extensionValue(extensions, url) {
  const ext = (extensions || []).find((e) => e.url === url);
  if (!ext) return undefined;
  return ext.valueCode ?? ext.valueString;
}

// The referencing field's own name — 'organization' out of 'PractitionerRole.organization'.
function referenceField(path) {
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(dot + 1);
}

function resourceTypeOf(path) {
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
}

// A target's candidate profile(s): either this app's own comma-joined graph-link-profiles
// extension (used when one resourceType, e.g. PractitionerRole, is shared by more than one real
// Profile — SPEC-24 §2's own two-shapes-one-word "Affiliate" finding), or GraphDefinition's own
// standard `target.profile` array, whichever the link actually carries. The two are genuinely
// different value formats as authored in ClinuxFlowOnboardingGraph.json, not a bug to normalize
// here: `target.profile` is real FHIR canonical URL(s); the custom extension's comma list is bare
// Profile names, chosen for a readable single valueString. Callers that need one profile per
// candidate to look up a StructureDefinition by should resolve either form against each
// StructureDefinition's own `.name`/`.url`, not assume a single format.
function targetProfiles(target) {
  const list = extensionValue(target.extension, PROFILES_EXT);
  if (list) return list.split(',');
  return target.profile ? [...target.profile] : [];
}

// Real FHIR Reference.reference is "ResourceType/id"; a bare id is accepted too, for resources
// this app hasn't stringified a typed reference for yet.
function referencedId(reference) {
  if (!reference) return undefined;
  const slash = reference.lastIndexOf('/');
  return slash === -1 ? reference : reference.slice(slash + 1);
}

function indexById(bundle) {
  const byId = new Map();
  bundle.forEach((resource) => {
    if (resource?.id) byId.set(resource.id, resource);
  });
  return byId;
}

function isValid(validationResults, resource) {
  const result = resource?.id ? validationResults[resource.id] : undefined;
  return result?.valid === true;
}

export function nextBestActions(graphDefinition, currentResourceBundle, validationResults = {}) {
  const bundle = currentResourceBundle || [];
  const byId = indexById(bundle);
  const actions = [];

  (graphDefinition?.link || []).forEach((link) => {
    const target = link.target?.[0];
    if (!target) return;
    const direction = extensionValue(target.extension, DIRECTION_EXT) || 'forward';
    const field = referenceField(link.path);
    const sourceType = direction === 'forward' ? resourceTypeOf(link.path) : graphDefinition.start;

    bundle
      .filter((resource) => resource.resourceType === sourceType)
      .forEach((source) => {
        if (!isValid(validationResults, source)) return; // source itself isn't done yet

        const candidate = {
          resourceType: target.type,
          profiles: targetProfiles(target),
          reason: link.description,
          linkId: link.sourceId,
          sourceResourceId: source.id,
        };

        if (direction === 'forward') {
          const targetId = referencedId(source[field]?.reference);
          const targetResource = targetId ? byId.get(targetId) : undefined;
          if (!targetResource) actions.push(candidate);
        } else {
          // Reverse: always an open, repeatable candidate once the source is valid — see header.
          actions.push(candidate);
        }
      });
  });

  return actions;
}
