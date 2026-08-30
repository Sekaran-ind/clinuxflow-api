import { v4 as uuidv4 } from 'uuid';

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
                        type: item.type
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
        // groupLinkId -> how many instances of it have been seen so far, across the whole response
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
                        instanceIndex = groupInstanceCounters.get(answeredItem.linkId) || 0;
                        groupInstanceCounters.set(answeredItem.linkId, instanceIndex + 1);
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

                        const cleanValue = ComprehensiveLocalExtractor._extractAnswerValue(answeredItem.answer[0]);
                        if (cleanValue !== undefined && cleanValue !== null) {
                            const separateInstanceFrame = groupStack.find(f => f.mode === 'separate-instances' && f.resourceType === resourceType);
                            const cacheKey = separateInstanceFrame ? `${resourceType}#${separateInstanceFrame.instanceIndex}` : resourceType;

                            const resource = getOrCreateCacheEntry(cacheKey, resourceType);

                            const { pointer, consumedTokenCount } = ComprehensiveLocalExtractor._navigateToWriteTarget(resource, groupStack, resourceType);
                            const remainingPath = propertyPathTokens.slice(consumedTokenCount).join('.');

                            const combinationTrackingKey = `${resourceType}.${rightHandPathString}`;
                            if (!dynamicArrayIndexTrackingLedger.has(combinationTrackingKey)) {
                                dynamicArrayIndexTrackingLedger.set(combinationTrackingKey, []);
                            }
                            const processedLinkIdsList = dynamicArrayIndexTrackingLedger.get(combinationTrackingKey);
                            let targetSlotIndex = processedLinkIdsList.indexOf(answeredItem.linkId);
                            if (targetSlotIndex === -1) {
                                processedLinkIdsList.push(answeredItem.linkId);
                                targetSlotIndex = processedLinkIdsList.length - 1;
                            }

                            ComprehensiveLocalExtractor._setValueAtPath(pointer, remainingPath, cleanValue, targetSlotIndex);
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
            if (type === 'PractitionerRole' && resourceCache.Practitioner && resourceCache.Organization) {
                // Link the medical staff member's active profile role to the practice facility
                resource.practitioner = { reference: `Practitioner/${resourceCache.Practitioner.id}` };
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
     * Writes assignedValue onto targetObj at the given dot-separated property path (already
     * relative to whatever _navigateToWriteTarget resolved — group-array navigation happens
     * before this is called now, not inside it). "component"/"coding" are FHIR list properties
     * this extractor has always positionally populated — kept as the one remaining hardcoded
     * array case, since they're leaf-level repetition (e.g. Observation.component), not a group.
     * dynamicIndexOffset selects which array slot they write into.
     *
     * KNOWN GAP, found and flagged this session, not fixed here (docs/SPEC-13-FHIR-WORKFLOW-
     * DOCUMENTS-AND-CONFORMANCE.md §5.3's revision): sibling LEAF fields within one group instance
     * that happen to share the exact same path (e.g. system-provider-composition-v1.yaml's
     * staff_phone/staff_email both mapping to `Practitioner.telecom.value`) still silently
     * overwrite each other — a different bug from group-repetition handling, still open.
     */
    static _setValueAtPath(targetObj, dotPathString, assignedValue, dynamicIndexOffset = 0) {
        const segments = dotPathString.split('.');
        let activePointer = targetObj;

        for (let i = 0; i < segments.length; i++) {
            let currentKey = segments[i];
            const isLastNode = (i === segments.length - 1);

            const isArrayType = (currentKey === 'component' || currentKey === 'coding');
            const targetArrayIndex = isArrayType ? dynamicIndexOffset : 0;

            if (isLastNode) {
                if (isArrayType) {
                    if (!Array.isArray(activePointer[currentKey])) activePointer[currentKey] = [];
                    activePointer[currentKey][targetArrayIndex] = currentKey === 'coding' ? { code: assignedValue } : assignedValue;
                } else {
                    activePointer[currentKey] = assignedValue;
                }
            } else {
                if (isArrayType) {
                    if (!Array.isArray(activePointer[currentKey])) activePointer[currentKey] = [];
                    if (!activePointer[currentKey][targetArrayIndex]) activePointer[currentKey][targetArrayIndex] = {};
                    activePointer = activePointer[currentKey][targetArrayIndex];
                } else {
                    if (isLastNode === false && segments[i + 1] === 'coding' && !activePointer[currentKey]) {
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
     * Also verified this session: the fields that WOULD otherwise be the obvious identity anchor
     * — staff_email, staff_license, staff_hprid — all collide with sibling fields at the same
     * `_setValueAtPath` target (see that method's own comment), so their extracted value cannot be
     * trusted today either.
     *
     * Scoped to what's actually reliable right now: `Practitioner.name.text`, combined with
     * `context.facilityId` if the caller supplies one. Known, accepted limitation — a name is not
     * truly unique — kept deliberately rather than silently pretending a better key already works.
     * Upgrade path, in order: (1) fix _setValueAtPath's sibling-collision gap so staff_email/
     * staff_hprid are trustworthy, (2) add a Staff-form field referencing
     * clinic-specialities.json's folder/file, (3) switch this resolver to key off that instead.
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
