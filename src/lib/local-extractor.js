import { v4 as uuidv4 } from 'uuid';

// A real, careful FHIR R4 cardinality reference — array-typed (0..*/1..*) properties, keyed by
// the exact dotted path from the resourceType root (e.g. "Organization.telecom"). Deliberately
// NOT a full FHIR StructureDefinition mirror — scoped to exactly what this app's own
// system-forms YAML files use today (tools/system-forms/system-provider-composition-v1.yaml,
// system-patient-profile-v1.yaml), checked against real FHIR R4 per-resource cardinality, not
// guessed. Extend this set when a new resourceType/path is authored, same discipline the
// condition-types ValueSet/clinic-specialities catalogs already use for "real curated data, not
// invented".
//
// Found and fixed this session (empirically confirmed before fixing, not assumed): every one of
// these paths was previously written as a bare object/scalar via the generic (non-component/
// coding) branch of _setValueAtPath, so a SECOND field sharing the same leaf path (e.g.
// hospital_phone + hospital_whatsapp + hospital_email + hospital_website all mapping to
// Organization.telecom.value) silently overwrote every earlier one — confirmed live with
// staff_phone/staff_email → only staff_email survived. Real, serious data loss for the exact
// "3 good onboarding journeys, HAPI-ready" build this closes the door on until fixed.
const FHIR_ARRAY_PATHS = new Set([
  // Organization (Facility) — real R4 cardinality
  'Organization.identifier', 'Organization.alias', 'Organization.type', 'Organization.telecom', 'Organization.address', 'Organization.extension',
  // Location (Facility branches/hours) — Location.address is genuinely 0..1 in R4, deliberately
  // NOT listed here; hoursOfOperation.daysOfWeek is an array WITHIN one hoursOfOperation entry.
  'Location.identifier', 'Location.telecom', 'Location.hoursOfOperation', 'Location.hoursOfOperation.daysOfWeek',
  // Practitioner (Provider) — .name is 0..* in R4 but this app only ever captures one name per
  // person; left OUT of this set deliberately so name.text/.given/.family (different leaf paths,
  // each called once) naturally converge on the same name[0] via _extractAnswers' own per-leaf-
  // path ledger, rather than needing separate "pin to index 0" logic. .name.given (WITHIN that
  // one name entry) genuinely needs array handling — a person can have more than one given name.
  'Practitioner.identifier', 'Practitioner.telecom', 'Practitioner.extension', 'Practitioner.qualification', 'Practitioner.name.given',
  // HealthcareService (Facility services)
  'HealthcareService.category', 'HealthcareService.program',
  // Consent (Facility)
  'Consent.category',
  // Appointment — participant.actor is written by BOTH appt_patient and appt_staff, a real
  // Case-A collision (two different fields, same leaf path) exactly like Organization.telecom.
  'Appointment.participant',
  // Patient — same "only one instance captured today" reasoning as Practitioner.name; .contact
  // and .name are both left out deliberately for the same convergence reason.
]);
function isArrayPath(absolutePath) {
  return FHIR_ARRAY_PATHS.has(absolutePath);
}

// Converts a completed FHIR QuestionnaireResponse back into a set of discrete FHIR resources
// (Patient, Observation, Condition, ...), using each Questionnaire item's `definition` string
// (e.g. "http://hl7.org/Observation#Observation.component.valueQuantity.value") to know which
// resource type and property path an answer belongs to. Runs entirely locally/offline — no
// external FHIR server or LLM call is involved in this step.
//
// Hardened this session (docs/SPEC-13-FHIR-WORKFLOW-DOCUMENTS-AND-CONFORMANCE.md §5.3's flagged
// risks, all real, verified against the actual code and, for the newer ones, against actual
// extractor output — not assumed):
//   1. Silent drop on an answer with no usable blueprint definition — logged + collected on
//      `.warnings` (see extract()'s own doc comment).
//   2. No stable resource identity across repeated extraction — pluggable `identityResolvers`,
//      Practitioner gets a real default (see _practitionerIdentity()).
//   3. Repeating groups collapsed entirely — a `repeats: true` group's multiple instances all
//      wrote into ONE shared cache entry, only the LAST repetition survived. Confirmed live before
//      the fix: 2 Staff members in, 1 Practitioner out.
//   4. GENUINE NESTED repeating groups (e.g. PlanDefinition.action[i].relatedAction[j], a
//      relatedAction that belongs to a SPECIFIC action, not a sibling table) weren't
//      representable at all until `yaml-to-questionnaire.js` gained real recursive field-group
//      support this session (confirmed LHC-Forms itself already supports this — see that file's
//      own header comment — this was purely a YAML-authoring/compiler gap, not a rendering one).
//      This extractor now walks a genuine STACK of enclosing repeating-group frames instead of a
//      single flat context, so two independently-repeating groups meant to share one array
//      (docs/SPEC-18-PLANDEFINITION-AUTHORING-VIA-YAML-PIPELINE.md §7 step 3's collision) is
//      solved by construction once the YAML actually nests them — no group-correspondence
//      reconciliation needed, because there's only ever one group being repeated at each level.
export class ComprehensiveLocalExtractor {
    /**
     * Executes a strict local definition-based SDC extraction operation
     * @param {Object} questionnaireBlueprint - The compiled FHIR Questionnaire
     * @param {Object} responsePayload - The human-approved QuestionnaireResponse
     * @param {Object} [options] - `identityResolvers` (resourceType -> (resource, context) => id|null)
     *   merged over the built-in defaults; `identityContext` (arbitrary data resolvers may read,
     *   e.g. { facilityId }).
     * @returns {Object[]} Fully formed, interconnected FHIR resources. Also carries a non-index
     *   `.warnings` string[] property (see class header comment) — inspect directly, not via JSON.
     */
    static extract(questionnaireBlueprint, responsePayload, options = {}) {
        console.log(`⚙️ Compiling and transforming data stream for form context: ${responsePayload.id || 'anonymous'}`);

        const identityResolvers = { ...ComprehensiveLocalExtractor.DEFAULT_IDENTITY_RESOLVERS, ...(options.identityResolvers || {}) };
        const identityContext = options.identityContext || {};
        const warnings = [];

        const blueprintMap = new Map();
        // groupLinkId -> { resourceType, tokens: string[] (path segments after the resourceType
        // root), mode: 'separate-instances' | 'array-field' | 'plain-object' }
        const groupMeta = new Map();

        function flattenItems(itemsList) {
            if (!itemsList || !Array.isArray(itemsList)) return;
            itemsList.forEach(item => {
                if (item.linkId && item.definition && !(item.item && item.item.length)) {
                    // Leaf field — a group item can also carry `definition` now (see
                    // _registerGroup below), deliberately excluded from blueprintMap so a leaf
                    // lookup never accidentally resolves to a group's own path.
                    blueprintMap.set(item.linkId, {
                        definition: item.definition,
                        type: item.type,
                        extensionUrl: item.extensionUrl, // real FHIR extension tagging — see yaml-to-questionnaire.js's own comment on this
                    });
                }
                if (item.item && Array.isArray(item.item)) {
                    if (item.linkId) {
                        ComprehensiveLocalExtractor._registerGroup(item, groupMeta);
                    }
                    flattenItems(item.item);
                }
            });
        }

        flattenItems(questionnaireBlueprint.item);

        // resourceCache is keyed by resourceType for the common case, or `${resourceType}#${n}`
        // for a 'separate-instances' repeating group's n-th repetition — the suffix is stripped
        // again when building finalizedOutputResources below, it only exists to keep repetitions
        // from overwriting each other during extraction.
        const resourceCache = {};
        const referenceTrackingTable = { Patient: null, Encounter: null };

        const targetPatientId = `local-pat-${uuidv4()}`;
        const targetEncounterId = `local-enc-${uuidv4()}`;

        referenceTrackingTable.Patient = `Patient/${targetPatientId}`;
        referenceTrackingTable.Encounter = `Encounter/${targetEncounterId}`;

        // Track active array index counts dynamically per resource path block to prevent collisions
        const dynamicArrayIndexTrackingLedger = new Map();
        // Counter key (enclosing-frame path + this group's own linkId) -> how many instances of
        // THIS group, under THIS specific parent instance, have been seen so far. Deliberately NOT
        // keyed by linkId alone (see the real bug this fixed, at its use site below).
        const groupInstanceCounters = new Map();

        function getOrCreateCacheEntry(cacheKey, resourceType) {
            if (!resourceCache[cacheKey]) {
                resourceCache[cacheKey] = {
                    resourceType: resourceType,
                    id: resourceType === 'Patient' ? targetPatientId :
                        resourceType === 'Encounter' ? targetEncounterId : `local-res-${uuidv4()}`,
                    meta: {
                        lastUpdated: new Date().toISOString(),
                        source: "clinixflow-edge-scribe"
                    }
                };
            }
            return resourceCache[cacheKey];
        }

        // `groupStack` is an array of enclosing-group frames (outermost first):
        // { groupLinkId, resourceType, tokens, mode, instanceIndex }. Empty at the top level.
        // Genuinely a stack now (risk #4) — a leaf several repeating groups deep gets a frame per
        // enclosing group, not just the innermost one.
        function extractAnswers(itemsList, groupStack) {
            if (!itemsList || !Array.isArray(itemsList)) return;

            itemsList.forEach(answeredItem => {
                const meta = answeredItem.linkId && groupMeta.get(answeredItem.linkId);
                const isGroupInstance = meta && Array.isArray(answeredItem.item);

                if (isGroupInstance) {
                    let instanceIndex = 0;
                    if (meta.mode !== 'plain-object') {
                        // Real bug found via hospital-setup-workflow.test.js's 4-step case: with a
                        // flat linkId-only key, a nested repeating group (e.g. relatedAction) kept
                        // counting up across EVERY parent instance that contributed one, instead of
                        // restarting at 0 for each parent's own array. workflow-definition-v1.draft.
                        // yaml's 2-room fixture never caught this — only one room had a populated
                        // relatedAction, so global index 0 == locally-scoped index 0 there either
                        // way. A 3rd/4th action each contributing their own single relatedAction
                        // exposed it: the extractor wrote into relatedAction[1]/[2] of their OWN
                        // array instead of [0], leaving `undefined` holes at the front. Scoping the
                        // key by the full enclosing-frame path (each frame's own linkId:instanceIndex)
                        // makes each parent instance's nested count independent, matching this
                        // function's own "genuinely nested... a frame per enclosing group" design.
                        const counterKey = [...groupStack.map(f => `${f.groupLinkId}:${f.instanceIndex}`), answeredItem.linkId].join('>');
                        instanceIndex = groupInstanceCounters.get(counterKey) || 0;
                        groupInstanceCounters.set(counterKey, instanceIndex + 1);
                    }
                    extractAnswers(answeredItem.item, [...groupStack, { groupLinkId: answeredItem.linkId, instanceIndex, ...meta }]);
                    return;
                }

                const leafMeta = blueprintMap.get(answeredItem.linkId);
                const hasAnswer = answeredItem.answer && answeredItem.answer.length > 0;

                if (hasAnswer && (!leafMeta || !leafMeta.definition)) {
                    const warning = `No blueprint definition found for answered linkId "${answeredItem.linkId}" — answer dropped.`;
                    console.warn(`⚠️ ${warning}`);
                    warnings.push(warning);
                } else if (hasAnswer && leafMeta && leafMeta.definition) {
                    const uriFragments = leafMeta.definition.split('#');

                    if (uriFragments.length < 2) {
                        const warning = `Malformed definition "${leafMeta.definition}" for linkId "${answeredItem.linkId}" (expected "resourceUrl#Resource.path") — answer dropped.`;
                        console.warn(`⚠️ ${warning}`);
                        warnings.push(warning);
                    } else {
                        const rightHandPathString = uriFragments[1];
                        const pathTokens = rightHandPathString.split('.');

                        const resourceType = pathTokens[0];
                        const propertyPathTokens = pathTokens.slice(1);

                        // Real bug found live, not hypothetical: a MultiSelect field's multiple
                        // selected answers were previously truncated to answer[0] alone — only
                        // the FIRST checked box ever survived extraction. Every answer is now
                        // extracted and written, each to its own array slot (see below).
                        const cleanValues = (answeredItem.answer || [])
                            .map((a) => ComprehensiveLocalExtractor._extractAnswerValue(a))
                            .filter((v) => v !== undefined && v !== null);
                        if (cleanValues.length > 0) {
                            // SPEC-24 §2 real bug found live (a repeating Practitioner group with a
                            // nested PractitionerRole sub-group — the real shape Provider capture
                            // needs): this used to require the frame's OWN resourceType to match
                            // the FIELD's resourceType, so a nested/sibling field belonging to a
                            // DIFFERENT resourceType than its enclosing separate-instances frame
                            // (e.g. PractitionerRole fields inside a Practitioner-typed repeating
                            // group) fell through to the un-suffixed, singleton cache key — every
                            // repetition silently clobbered the last one's PractitionerRole into a
                            // single shared resource (confirmed empirically before this fix: 2 real
                            // staff members in, 1 PractitionerRole out, holding only the second
                            // one's code). The nearest ENCLOSING separate-instances frame, of ANY
                            // resourceType, is what actually scopes "which repetition this
                            // belongs to" — searched innermost-first so a genuinely nested repeat
                            // (SPEC-18's own case) still finds its own closest boundary first, not
                            // an outer one. This doesn't change behavior for the dominant existing
                            // case (a field's own resourceType already matches its frame) since
                            // that frame is still the nearest one found.
                            const separateInstanceFrame = [...groupStack].reverse().find(f => f.mode === 'separate-instances');
                            const cacheKey = separateInstanceFrame ? `${resourceType}#${separateInstanceFrame.instanceIndex}` : resourceType;

                            const resource = getOrCreateCacheEntry(cacheKey, resourceType);

                            const { pointer, consumedTokenCount } = ComprehensiveLocalExtractor._navigateToWriteTarget(resource, groupStack, resourceType);

                            // Ledger now tracks a BASE slot per distinct linkId (not one fixed
                            // slot) plus a running nextSlot counter, so a multi-answer field claims
                            // as many consecutive slots as it has values, and the next DIFFERENT
                            // linkId sharing this same leaf path starts right after them — the
                            // real fix for the empirically-confirmed staff_phone/staff_email
                            // (Organization.telecom.value ×4, Practitioner.identifier.value ×9,
                            // etc.) sibling-collision data loss, generalizing the exact allocation
                            // idea component/coding already proved, not a new mechanism.
                            const combinationTrackingKey = `${resourceType}.${rightHandPathString}`;
                            if (!dynamicArrayIndexTrackingLedger.has(combinationTrackingKey)) {
                                dynamicArrayIndexTrackingLedger.set(combinationTrackingKey, { linkIdBase: new Map(), nextSlot: 0 });
                            }
                            const ledgerEntry = dynamicArrayIndexTrackingLedger.get(combinationTrackingKey);
                            let baseSlot = ledgerEntry.linkIdBase.get(answeredItem.linkId);
                            if (baseSlot === undefined) {
                                baseSlot = ledgerEntry.nextSlot;
                                ledgerEntry.linkIdBase.set(answeredItem.linkId, baseSlot);
                                ledgerEntry.nextSlot += cleanValues.length;
                            }

                            cleanValues.forEach((cleanValue, valueIndex) => {
                                ComprehensiveLocalExtractor._setValueAtPath(resourceType, propertyPathTokens, consumedTokenCount, pointer, cleanValue, baseSlot + valueIndex, leafMeta.extensionUrl);
                            });
                        }
                    }
                }

                if (answeredItem.item && Array.isArray(answeredItem.item)) {
                    extractAnswers(answeredItem.item, groupStack);
                }
            });
        }

        extractAnswers(responsePayload.item, []);

        // Identity resolution pass — runs BEFORE the reference-linking pass below, so anything
        // that references e.g. Practitioner/<id> picks up the resolved, stable id rather than the
        // random one assigned above. Runs per cache entry (so each 'separate-instances' repetition
        // gets independently resolved), looking up the resolver by the entry's own resourceType,
        // not its (possibly suffixed) cache key.
        Object.keys(resourceCache).forEach(cacheKey => {
            const resource = resourceCache[cacheKey];
            const resolver = identityResolvers[resource.resourceType];
            if (!resolver) return;
            const resolvedId = resolver(resource, identityContext);
            if (resolvedId) resource.id = resolvedId;
        });

        const finalizedOutputResources = [];

        Object.keys(resourceCache).forEach(cacheKey => {
            const resource = resourceCache[cacheKey];
            const type = resource.resourceType;

            if (type === 'Observation') {
                if (!resource.status) resource.status = 'final';
                resource.subject = { reference: referenceTrackingTable.Patient };
                resource.encounter = { reference: referenceTrackingTable.Encounter };
            }

            if (type === 'Condition' || type === 'MedicationRequest') {
                resource.subject = { reference: referenceTrackingTable.Patient };
            }

            // ─── NEW: AUTOMATED ADMINISTRATIVE ONBOARDING REFERENCE LINKS ───
            if (type === 'Location' && resourceCache.Organization) {
                // Automatically tie the physical office branch to the parent corporate entity
                resource.managingOrganization = { reference: `Organization/${resourceCache.Organization.id}` };
            }
            if (type === 'PractitionerRole' && resourceCache.Organization) {
                // SPEC-24 §2 real bug found alongside the cache-key fix above: this used to read
                // the bare `resourceCache.Practitioner` key, which only ever existed for a
                // singleton (non-repeating) Practitioner — once a repeating Staff group correctly
                // produces `Practitioner#0`, `Practitioner#1`, ... (the fix above), this lookup
                // always missed and silently left EVERY PractitionerRole unlinked. A PractitionerRole
                // belongs to the Practitioner from the SAME repetition — its own cacheKey carries
                // that same "#N" suffix (both are nested under the identical enclosing
                // separate-instances frame) — so that's looked up first, falling back to the
                // unqualified singleton key for a non-repeating capture flow (e.g. a single
                // "add myself" instance) where no suffix was ever assigned.
                const instanceSuffix = cacheKey.includes('#') ? cacheKey.slice(cacheKey.indexOf('#')) : '';
                const practitioner = resourceCache[`Practitioner${instanceSuffix}`] || resourceCache.Practitioner;
                if (practitioner) resource.practitioner = { reference: `Practitioner/${practitioner.id}` };
                resource.organization = { reference: `Organization/${resourceCache.Organization.id}` };
            }

            finalizedOutputResources.push(resource);
        });

        finalizedOutputResources.warnings = warnings;

        console.log(`  ➔ Comprehensive conversion complete. Extracted ${finalizedOutputResources.length} interdependent resources.${warnings.length ? ` ${warnings.length} warning(s) — see .warnings.` : ''}`);
        return finalizedOutputResources;
    }

    // Unwraps a FHIR answer node's typed value (valueDecimal/valueInteger/valueBoolean/valueDate),
    // falling back to valueString for everything else.
    static _extractAnswerValue(fhirAnswerNode) {
        if (!fhirAnswerNode) return null;
        if (fhirAnswerNode.valueDecimal !== undefined) return fhirAnswerNode.valueDecimal;
        if (fhirAnswerNode.valueInteger !== undefined) return fhirAnswerNode.valueInteger;
        if (fhirAnswerNode.valueBoolean !== undefined) return fhirAnswerNode.valueBoolean;
        if (fhirAnswerNode.valueDate !== undefined) return fhirAnswerNode.valueDate;
        return fhirAnswerNode.valueString || null;
    }

    // The real FHIR extension.value[x] key for an already-coerced JS value — mirrors
    // _extractAnswerValue's own type coercion above (decimal/integer/boolean fall through to
    // string) so a real extension's value type matches whatever the answer's own FHIR-typed
    // answer node actually carried, not a guess.
    static _fhirValueKey(value) {
        if (typeof value === 'boolean') return 'valueBoolean';
        if (typeof value === 'number') return Number.isInteger(value) ? 'valueInteger' : 'valueDecimal';
        return 'valueString';
    }

    /**
     * Classifies a group item (anything with its own `item[]`) into the metadata a leaf write
     * needs: which resourceType it belongs to, which path segments (after the resourceType root)
     * it represents, and how repetitions of it should be handled.
     *
     * Two ways a group gets classified, in priority order:
     *   1. It carries an explicit `definition` (real as of this session — `yaml-to-
     *      questionnaire.js`'s `type: "group"` fields now compile one) — tokens come directly
     *      from that path. A group with a real sub-path is, by construction, always a structure
     *      WITHIN its enclosing resource, never a separate top-level resource — so `repeats: true`
     *      here always means 'array-field', never 'separate-instances'. `repeats: false` means
     *      'plain-object' (a nested non-repeating sub-structure — supported for completeness even
     *      though no real case in this codebase needs it yet).
     *   2. No `definition` (the legacy shape every group in this system used before this session —
     *      system-provider-composition-v1.yaml's Staff/Location/etc.) — falls back to the
     *      original heuristic: inspect its DIRECT leaf children's own paths and see whether they
     *      share a common prefix beyond the resourceType root. Diverge immediately (Staff-shaped)
     *      → 'separate-instances'. Converge on a segment (PlanDefinition.action-shaped, when
     *      authored flat rather than nested) → 'array-field'. A single-leaf-field group trivially
     *      "agrees with itself" and would misclassify as array-field — requires 2+ fields before
     *      that mode applies (found live testing this session against exactly that shape).
     */
    static _registerGroup(groupItem, groupMeta) {
        if (groupItem.definition) {
            const frag = groupItem.definition.split('#');
            if (frag.length < 2) return;
            const tokens = frag[1].split('.');
            groupMeta.set(groupItem.linkId, {
                resourceType: tokens[0],
                tokens: tokens.slice(1),
                mode: groupItem.repeats ? 'array-field' : 'plain-object',
            });
            return;
        }

        if (!groupItem.repeats) return; // a legacy non-repeating group needs no special handling at all

        const leafDefs = (groupItem.item || [])
            .filter(child => child.definition && !(child.item && child.item.length))
            .map(child => child.definition);
        if (leafDefs.length === 0) return;

        const parsed = leafDefs
            .map(def => def.split('#'))
            .filter(f => f.length >= 2)
            .map(f => f[1].split('.'));
        if (parsed.length === 0) return;

        const resourceType = parsed[0][0];
        const tails = parsed.map(tokens => tokens.slice(1));
        const first = tails[0];

        let commonPrefixLength = 0;
        if (tails.length > 1) {
            for (let i = 0; i < first.length; i++) {
                if (tails.every(t => t[i] === first[i])) commonPrefixLength++;
                else break;
            }
        }

        groupMeta.set(groupItem.linkId, {
            resourceType,
            tokens: commonPrefixLength > 0 ? first.slice(0, commonPrefixLength) : [],
            mode: commonPrefixLength > 0 ? 'array-field' : 'separate-instances',
        });
    }

    /**
     * Walks `groupStack`'s frames belonging to `resourceType` (outermost first), navigating
     * `resource` through each frame's own token path — for 'array-field' frames, the last token
     * of that frame's incremental segment is treated as an array, indexed by the frame's own
     * `instanceIndex`; for 'plain-object' frames, plain nested-object navigation; 'separate-
     * instances' frames contribute nothing here (they only affect which resource this already is,
     * handled via cacheKey before this is called). Each frame's `tokens` are absolute (from the
     * resourceType root), matching how nested-group `path` is authored in YAML — the incremental
     * segment for a given frame is just its tokens with however many the previous frame already
     * consumed stripped off the front, no parent-child linkage needed beyond stack order.
     * Returns the object a leaf write should target, plus how many of the leaf's own path tokens
     * the frames already consumed (the caller writes only the remainder).
     */
    static _navigateToWriteTarget(resource, groupStack, resourceType) {
        let pointer = resource;
        let consumed = 0;

        groupStack
            .filter(frame => frame.resourceType === resourceType && frame.mode !== 'separate-instances')
            .forEach(frame => {
                const segment = frame.tokens.slice(consumed);
                consumed = frame.tokens.length;
                if (segment.length === 0) return;

                segment.forEach((token, idx) => {
                    const isBoundary = idx === segment.length - 1 && frame.mode === 'array-field';
                    if (isBoundary) {
                        if (!Array.isArray(pointer[token])) pointer[token] = [];
                        if (!pointer[token][frame.instanceIndex]) pointer[token][frame.instanceIndex] = {};
                        pointer = pointer[token][frame.instanceIndex];
                    } else {
                        if (!pointer[token]) pointer[token] = {};
                        pointer = pointer[token];
                    }
                });
            });

        return { pointer, consumedTokenCount: consumed };
    }

    /**
     * Writes assignedValue onto targetObj, walking `fullPathTokens` from `startIndex` (the part
     * `_navigateToWriteTarget` didn't already consume via groupStack navigation) — `fullPathTokens`
     * is passed in full (not pre-sliced) so the REAL absolute FHIR path can be reconstructed at
     * each segment for the FHIR_ARRAY_PATHS lookup below, even though only the tail is actually
     * walked on `targetObj`.
     *
     * "component"/"coding" are FHIR list properties this extractor has always positionally
     * populated by NAME alone (not resourceType-aware) — kept exactly as before, unchanged, since
     * real production YAMLs (system-encounter-composition-v1.yaml and several samples) already
     * depend on this shape and it isn't broken. FHIR_ARRAY_PATHS below is the real, resourceType-
     * aware generalization of the SAME idea for every other array-typed FHIR property this app's
     * Facility/Provider/Patient composition YAMLs actually use — same "isArrayType ->
     * dynamicIndexOffset selects which slot" mechanism, just driven by a real cardinality table
     * instead of two hardcoded names.
     *
     * REAL BUG, confirmed live before fixing (not assumed): every non-component/coding path
     * previously always took the plain-object branch, so (a) a second field sharing the same leaf
     * path silently overwrote the first (staff_phone/staff_email -> Practitioner.telecom.value,
     * confirmed only staff_email survived), and (b) even a genuinely-array FHIR property (telecom,
     * identifier, address, type, ...) was written as a bare object, not a JSON array — structurally
     * invalid for a real HAPI FHIR server regardless of the collision issue. Both fixed together
     * here, since they're the same root cause (array-typed properties never being treated as
     * arrays outside the two hardcoded names).
     */
    static _setValueAtPath(resourceType, fullPathTokens, startIndex, targetObj, assignedValue, dynamicIndexOffset = 0, extensionUrl = undefined) {
        let activePointer = targetObj;

        for (let i = startIndex; i < fullPathTokens.length; i++) {
            let currentKey = fullPathTokens[i];
            const isLastNode = (i === fullPathTokens.length - 1);

            const absolutePath = `${resourceType}.${fullPathTokens.slice(0, i + 1).join('.')}`;
            const isArrayType = currentKey === 'component' || currentKey === 'coding' || isArrayPath(absolutePath);
            const targetArrayIndex = isArrayType ? dynamicIndexOffset : 0;

            if (isLastNode) {
                if (isArrayType) {
                    if (!Array.isArray(activePointer[currentKey])) activePointer[currentKey] = [];
                    // Real FHIR extension shape ({url, value[x]}), not a bare value — "any field
                    // not found in the FHIR spec needed for ABDM capture goes into extension
                    // fields" (explicit instruction). Only applies when the YAML field actually
                    // declared an extensionUrl; an `extension` path with none stays the old bare-
                    // value behavior (there's no real prior case of this, but failing safe rather
                    // than guessing a URL is the honest choice).
                    if (currentKey === 'extension' && extensionUrl) {
                        activePointer[currentKey][targetArrayIndex] = { url: extensionUrl, [ComprehensiveLocalExtractor._fhirValueKey(assignedValue)]: assignedValue };
                    } else {
                        activePointer[currentKey][targetArrayIndex] = currentKey === 'coding' ? { code: assignedValue } : assignedValue;
                    }
                } else {
                    activePointer[currentKey] = assignedValue;
                }
            } else {
                if (isArrayType) {
                    if (!Array.isArray(activePointer[currentKey])) activePointer[currentKey] = [];
                    if (!activePointer[currentKey][targetArrayIndex]) activePointer[currentKey][targetArrayIndex] = {};
                    activePointer = activePointer[currentKey][targetArrayIndex];
                } else {
                    if (isLastNode === false && fullPathTokens[i + 1] === 'coding' && !activePointer[currentKey]) {
                        activePointer[currentKey] = {};
                    }
                    if (!activePointer[currentKey]) activePointer[currentKey] = {};
                    activePointer = activePointer[currentKey];
                }
            }
        }
    }

    // Identity resolution (docs/SPEC-13-FHIR-WORKFLOW-DOCUMENTS-AND-CONFORMANCE.md §5.3,
    // docs/SPEC-18-PLANDEFINITION-AUTHORING-VIA-YAML-PIPELINE.md's confirmed "start with the roles
    // defined in the virtual-room" direction) — resource types get a deterministic id from this
    // map instead of a fresh random uuid per extraction, so re-running extraction on an amended
    // QuestionnaireResponse updates the existing resource rather than spawning a duplicate.
    // Deliberately pluggable rather than a hardcoded scheme — different resource types need
    // different anchors (Organization is a facility singleton, doesn't need this at all;
    // Observation/Condition are event-shaped and SHOULD get a new resource per new answer, not
    // this treatment).
    static DEFAULT_IDENTITY_RESOLVERS = {
        Practitioner: (resource, context) => ComprehensiveLocalExtractor._practitionerIdentity(resource, context),
    };

    /**
     * The originally-intended anchor was (facility, virtual-room speciality-folder + role-file,
     * practitioner) — clinuxflow-api/data/clinic-specialities.json (compiled from
     * config/clinic-specialities/virtual-rooms/), the real catalog `stores/cubo.js`'s
     * virtualRoom picker already reads from. Verified this session: `section_staff` in
     * system-provider-composition-v1.yaml does not currently capture a field referencing that
     * catalog's `folder`/`file` at all — staff_role/staff_specialty are a separate, coarser
     * clinical-vocabulary choice list, not tied to clinic-specialities.json's identifiers. So the
     * full virtual-room-anchored key isn't constructible from today's real captured data, not
     * just an oversight here.
     *
     * UPDATE — (1) below is now done: FHIR_ARRAY_PATHS (this file's own header) fixed the sibling-
     * collision bug, so staff_email/staff_license/staff_hprid each now land in their own real
     * array slot instead of clobbering each other. Still NOT switching this resolver to email,
     * though — real ContactPoint entries need a `.system` ('email'/'phone'/'url') to reliably tell
     * WHICH telecom[N] is the email one; today's Staff form captures the values but never tags
     * which is which, so finding "the email" would mean guessing by array position (fragile,
     * depends on which fields happened to be filled). A new, still-open gap, not silently worked
     * around here.
     *
     * Scoped to what's actually reliable right now: `Practitioner.name.text`, combined with
     * `context.facilityId` if the caller supplies one. Known, accepted limitation — a name is not
     * truly unique — kept deliberately rather than silently pretending a better key already works.
     * Upgrade path, in order: (1) DONE — sibling-collision fix; (2) add `system` tagging to
     * Staff-form telecom fields (or a Staff-form field referencing clinic-specialities.json's
     * folder/file) so a real unique anchor becomes extractable; (3) switch this resolver to key
     * off that instead.
     */
    static _practitionerIdentity(resource, context) {
        const name = resource?.name?.text;
        if (!name) return null;
        const facilityKey = context.facilityId || 'unscoped-facility';
        return `practitioner-${ComprehensiveLocalExtractor._stableHash(`${facilityKey}::${name.trim().toLowerCase()}`)}`;
    }

    // Small, dependency-free deterministic string hash (FNV-1a-style) — not cryptographic, only
    // needs to be stable across repeated calls with the same input, which is all identity
    // resolution requires.
    static _stableHash(str) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16);
    }
}
