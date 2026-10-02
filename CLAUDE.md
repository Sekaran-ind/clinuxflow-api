# clinuxflow-api

Hono backend on Cloudflare Workers for ClinixFlow — the forms compiler (YAML → FHIR
Questionnaire), the system-forms catalog, the LLM-driven scribe workflow, and the
clinic-specialities virtual-room catalog. This is the **active backend** for
`../clinux-frontend` (the Vue frontend).

Not a 1:1 port of `../../clinixflow/server.js` — this project uses Workers-native conventions
throughout (bundled static imports instead of `fs`, D1/KV instead of a local sqlite file), and its
own response shapes where they diverge from the original.

## Relationship to sibling projects

- `../clinux-frontend` — the frontend this backend serves. Keep response shapes in sync with what
  that project's `src/data/*` modules and page components expect. Notably `POST
  /api/workflow/save-to-library` returns `jsonKey`/`yamlKey` (KV keys), not the original
  clinixflow's `jsonPath`/`yamlPath` (filesystem paths) — the frontend was written to match this
  project's actual shape, not clinixflow's.
- `../clinuxflow-abdm-gateway` — a separate Worker. ABDM HFR/HPR registration endpoints are NOT
  in this project; don't add them here.
- `../../clinixflow` — the original Express/local implementation of the same product. Sandbox /
  reference only now — not kept in sync with this project.

## Running locally

```
npm install
wrangler dev --port 8787   # default port most of clinux-frontend's src/config.js expects
```

## FHIR conformance (ABDM IG)

- The FHIR path dictionary (`data/graphs/`, `data/graphs.bundle.json`, `data/form-schematics.schema.json`)
  is built by `tools/build-fhir-dictionary.js` from the official packages pinned in
  `fhir-packages.json` (HL7 R4 core, terminology, extensions, and the ABDM IG `ndhm.in` 6.5.0 —
  https://nrces.in/ndhm/fhir/r4), using clinuxflow-fhir-api's generator (copied to `tools/fhir/`;
  change it in fhir-api first). `npm run build:kernel` fetches (sha256-verified) and rebuilds.
  `@smile-cdr/fhirts` is no longer used.
- `data/ig-conformance.json` drives IG conformance of extracted resources: identifier/telecom
  slices (a YAML field's `slice:` or `fieldSlices` by id), the local identifier the IG's min-1 rule
  needs, profile URLs, and `professionalRoles` (HPR category -> SNOMED PractitionerRole.code).
  `local-extractor.js` also normalises cardinality from the official dictionary.
- `data/structure-definitions/` are clinuxflow-fhir-api's IG-based profiles (copied); canonical
  base `https://clinux.yaxb.ai/fhir`.
- Role vs entitlement: `data/entitlements.json` (account-role grants, HPR-role grants) is the
  policy `src/lib/shared/permissions.js` reads. The HPR role is an entitlement source
  (PractitionerRole extension `hpr-role`), never PractitionerRole.code.
- Provenance: `POST /api/provenance` (paid tier only) stores what devices publish; the free tier
  never writes it.

## Known-fragile spots

- `data/vitals-room.yaml` (served by `GET /api/workflow/default-blueprint`) must stay compilable
  by `POST /api/workflow/compile` — clinux-frontend's Designer page fetches and auto-compiles it
  on every fresh load. Each field's `path:` value must match `data/form-schematics.schema.json`'s
  allowed-values enum for that `resourceType` (e.g. `Condition.clinicalStatus`, not
  `Condition.clinicalStatus.coding.code`) — a mismatch here silently breaks the Designer page's
  auto-compile-on-load for every user, not just whoever is editing that form. This exact class of
  bug has bitten this file once already (three `path:` values were left as unfinished
  `# Update to match your exact grep output string` placeholders).
- `POST /api/workflow/test-scribe` calls `c.env.AI.run(...)` (Cloudflare Workers AI) — this needs a
  real account/binding proxying through even under `wrangler dev` locally. There's no offline mock
  for this specific endpoint (there is one for `test-scribe-mock`).
