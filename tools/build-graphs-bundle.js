// Combines the per-resource shard files dictionary-builder.js just wrote (data/graphs/
// <resource>.graph.json) into the single data/graphs.bundle.json src/lib/yaml-to-questionnaire.js
// statically imports at request time — Workers has no filesystem, so it can't read the shard
// files individually. Run right after dictionary-builder.js (both are chained by
// `npm run build:kernel`).
//
// This step existed only informally before (someone hand-assembled graphs.bundle.json once when
// clinuxflow-api was first set up); giving it a real script means a dictionary-builder.js re-run
// can't silently leave the bundle stale.
import fs from 'fs';
import path from 'path';

const GRAPHS_DIR = path.join(process.cwd(), 'data', 'graphs');
const OUT_PATH = path.join(process.cwd(), 'data', 'graphs.bundle.json');

if (!fs.existsSync(GRAPHS_DIR)) {
    console.error(`❌ No shard directory at ${GRAPHS_DIR} — run dictionary-builder.js first.`);
    process.exit(1);
}

const bundle = {};
const files = fs.readdirSync(GRAPHS_DIR).filter((f) => f.endsWith('.graph.json'));

for (const file of files) {
    const resourceKey = file.replace(/\.graph\.json$/, ''); // already lowercase, matches
    // yaml-to-questionnaire.js's graphBundle[currentResource.toLowerCase()] lookup
    bundle[resourceKey] = JSON.parse(fs.readFileSync(path.join(GRAPHS_DIR, file), 'utf8'));
}

fs.writeFileSync(OUT_PATH, JSON.stringify(bundle, null, 2), 'utf8');
console.log(`✅ Wrote ${OUT_PATH} (${files.length} resource shards bundled).`);
