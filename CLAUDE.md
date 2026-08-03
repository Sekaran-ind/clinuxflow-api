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
