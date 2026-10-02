// SPEC-24 §3 — the real replacement for tracked PlanDefinition status on the onboarding entities:
// "done" is "passes validation against the real StructureDefinition," evaluated fresh every time,
// never a persisted actor state. A small, pure, stateless function — validate(structureDefinition,
// resource) -> { valid, errors: [{path, message}] } — no runtime, no snapshot.
//
// Deliberately scoped to what this app's own 6 real profiles (data/structure-definitions/*.json)
// actually use, not a general-purpose FHIR profile validator: plain element cardinality (min/max),
// sliced arrays (identifier/telecom/extension, discriminated by a fixed sub-value), and fixed[x]
// value checks. Real FHIRPath-based slicing discriminators, value-set binding validation, and
// invariant (constraint) evaluation are explicitly NOT built here — see next-best-action.js's own
// header for where invariant-driven sequencing is designed, not yet implemented.

// Reads a dotted FHIR path ('Organization.address.line') relative to a resource, resolving
// through arrays by returning an array of leaf values (or the single leaf value, when nothing on
// the path is itself an array) — the same "one path can genuinely have 0, 1, or N real values"
// shape every element in these profiles already has to handle.
function resolvePath(resource, pathAfterResourceType) {
  const segments = pathAfterResourceType.split('.');
  let current = [resource];
  for (const segment of segments) {
    const next = [];
    for (const node of current) {
      if (node === undefined || node === null) continue;
      const value = node[segment];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) next.push(...value);
      else next.push(value);
    }
    current = next;
  }
  return current;
}

// A slice's own discriminator values are read off ITS child elements' fixed[x] properties (e.g.
// the 'contactPhone' slice's '.system' child has fixedCode:'phone', its '.use' child has
// fixedCode:'mobile') — real ElementDefinition shape, not a separate sidecar config. Extension
// slices discriminate on `extension.url` matching the slice's own declared profile canonical
// instead (extensions don't have a 'system'/'use' pair to key off).
function fixedValueOf(el) {
  const key = Object.keys(el).find((k) => k.startsWith('fixed'));
  return key ? el[key] : undefined;
}

function sliceMatcher(sliceRootPath, sliceChildren, isExtensionSlice, extensionProfileUrl) {
  if (isExtensionSlice) {
    return (item) => item && item.url === extensionProfileUrl;
  }
  // Each child element id looks like '<basePath>:<sliceName>.<field>' — the field after the last
  // '.' is what the fixed value applies to on the sliced array item itself.
  const checks = sliceChildren
    .map((child) => {
      const field = child.path.slice(sliceRootPath.length + 1); // e.g. 'system' from 'Organization.telecom.system'
      const fixed = fixedValueOf(child);
      return fixed !== undefined ? { field, fixed } : null;
    })
    .filter(Boolean);
  return (item) => checks.every(({ field, fixed }) => item && item[field] === fixed);
}

// Groups a flat differential.element[] into { plain: [...], slicingByPath: { path: {slicingEl,
// slices: [{sliceEl, children[]}] } } } — the shape validate() actually walks. Real
// ElementDefinition ordering (a `slicing` element immediately followed by its own slice roots,
// each slice root immediately followed by ITS OWN children) is relied on, matching how every
// profile in data/structure-definitions/*.json is actually authored.
function groupElements(elements) {
  const plain = [];
  const slicingByPath = {};
  let currentSlicing = null; // { path, isExtension }
  let currentSlice = null; // { sliceEl, children }

  elements.forEach((el) => {
    if (el.slicing) {
      currentSlicing = { path: el.path, isExtension: el.path.endsWith('.extension') };
      slicingByPath[el.path] = { slicingEl: el, slices: [] };
      currentSlice = null;
      return;
    }
    if (el.sliceName) {
      currentSlice = { sliceEl: el, children: [] };
      slicingByPath[currentSlicing.path].slices.push(currentSlice);
      return;
    }
    // A child of the current slice if its path starts with the slice root's own path + '.' and
    // we're still inside a slicing block on that same base path; otherwise a plain element.
    if (currentSlicing && currentSlice && el.path.startsWith(currentSlicing.path + '.')) {
      currentSlice.children.push(el);
      return;
    }
    // Leaving the slicing block (a plain element on a different path arrived).
    currentSlicing = null;
    currentSlice = null;
    plain.push(el);
  });

  return { plain, slicingByPath };
}

function checkCardinality(errors, path, count, min, max) {
  const maxNum = max === '*' ? Infinity : Number(max);
  if (count < min) errors.push({ path, message: `${path}: expected at least ${min}, found ${count}` });
  if (count > maxNum) errors.push({ path, message: `${path}: expected at most ${max}, found ${count}` });
}

export function validate(structureDefinition, resource) {
  const errors = [];
  if (!resource || typeof resource !== 'object') {
    return { valid: false, errors: [{ path: structureDefinition?.type || '(root)', message: 'resource is missing or not an object' }] };
  }
  const resourceType = structureDefinition.type;
  const elements = structureDefinition.differential?.element || [];
  const { plain, slicingByPath } = groupElements(elements);

  plain.forEach((el) => {
    const relativePath = el.path.slice(resourceType.length + 1); // drop 'Organization.' prefix
    if (!relativePath) return; // the root element itself, nothing to check
    const values = resolvePath(resource, relativePath);
    // Cardinality per repetition of the parent, as FHIR defines it (and as clinuxflow-fhir-api's
    // validator does): Practitioner.qualification.code 1..1 means one code IN EACH qualification,
    // not one across all of them — the old aggregate count wrongly failed a practitioner with two
    // qualifications under the IG-based profiles. A child's min applies only where its parent
    // exists; direct children of the resource are checked against the resource itself.
    const segments = relativePath.split('.');
    const parents = segments.length === 1 ? [resource] : resolvePath(resource, segments.slice(0, -1).join('.'));
    const leaf = segments[segments.length - 1];
    parents.forEach((parent) => {
      const v = parent?.[leaf];
      const count = v === undefined || v === null ? 0 : Array.isArray(v) ? v.length : 1;
      checkCardinality(errors, el.path, count, el.min ?? 0, el.max ?? '*');
    });
    const fixed = fixedValueOf(el);
    if (fixed !== undefined) {
      values.forEach((v) => {
        if (v !== fixed) errors.push({ path: el.path, message: `${el.path}: expected fixed value ${JSON.stringify(fixed)}, found ${JSON.stringify(v)}` });
      });
    }
  });

  Object.entries(slicingByPath).forEach(([slicingPath, { slices }]) => {
    const relativePath = slicingPath.slice(resourceType.length + 1);
    const arrayValues = resolvePath(resource, relativePath);
    const isExtension = slicingPath.endsWith('.extension');
    slices.forEach(({ sliceEl, children }) => {
      const extensionProfileUrl = isExtension ? sliceEl.type?.[0]?.profile?.[0] : null;
      const matcher = sliceMatcher(slicingPath, children, isExtension, extensionProfileUrl);
      const matched = arrayValues.filter(matcher);
      checkCardinality(errors, sliceEl.id, matched.length, sliceEl.min ?? 0, sliceEl.max ?? '*');
    });
  });

  return { valid: errors.length === 0, errors };
}
