// Precomputes config/clinic-specialities/virtual-rooms/**/*.md + specialities.json from the
// clinixflow dev sandbox into one bundled JSON manifest this Worker can `import` directly —
// same treatment data/system-forms-library.json already gets, since Workers has no filesystem
// to run fs.readdirSync against at request time the way clinixflow's own server.js does.
//
// Run manually whenever clinixflow's virtual-rooms content changes:
//   node scripts/build-clinic-specialities.js
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// clinixflow is a sibling checkout on the same machine — the one place this content is authored
// and edited; this script's whole job is turning that into something Workers-compatible.
const CLINIXFLOW_ROOT = process.env.CLINIXFLOW_ROOT || join(apiRoot, '..', '..', 'clinixflow');
const CLINIC_SPECIALITIES_DIR = join(CLINIXFLOW_ROOT, 'config', 'clinic-specialities');
const VIRTUAL_ROOMS_DIR = join(CLINIC_SPECIALITIES_DIR, 'virtual-rooms');

const conceptMap = JSON.parse(readFileSync(join(CLINIC_SPECIALITIES_DIR, 'specialities.json'), 'utf8'));
const displayByCode = {};
(conceptMap.group || []).forEach((g) => (g.element || []).forEach((el) => { displayByCode[el.code] = el.display; }));

const markdown = {};
const folders = readdirSync(VIRTUAL_ROOMS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

const specialities = folders.map((dirent) => {
  const folder = dirent.name;
  const code = folder.split('_')[0];
  const slug = folder.slice(code.length + 1);
  const roleFiles = readdirSync(join(VIRTUAL_ROOMS_DIR, folder)).filter((f) => f.endsWith('.md'));

  const roles = roleFiles.map((file) => {
    const content = readFileSync(join(VIRTUAL_ROOMS_DIR, folder, file), 'utf8');
    markdown[`${folder}/${file}`] = content;

    let title = file.replace(/\.md$/, '').replace(/_/g, ' ');
    const m = content.split('\n')[0].match(/^#\s*Role Definition:\s*(.+?)\s*\(SNOMED/);
    if (m) title = m[1];
    return { file, title };
  }).sort((a, b) => a.file.localeCompare(b.file));

  return { code, slug, folder, display: displayByCode[code] || slug.replace(/_/g, ' '), roles };
}).sort((a, b) => Number(a.code) - Number(b.code));

writeFileSync(
  join(apiRoot, 'data', 'clinic-specialities.json'),
  JSON.stringify({ specialities, markdown }, null, 2)
);

console.log(`Wrote data/clinic-specialities.json: ${specialities.length} specialities, ${Object.keys(markdown).length} role files.`);
