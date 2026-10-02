// Copied from clinuxflow-fhir-api (scripts/lib/fhir-packages.js) — clinuxflow-api builds its FHIR path dictionary
// from the same pinned official packages (fhir-packages.json) instead of @smile-cdr/fhirts.
// Keep in step with fhir-api: change it there first, then copy.
// Reads conformance resources (StructureDefinition, ValueSet, CodeSystem) out of the extracted
// FHIR packages. Build-time only.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/fhir/lib -> repo root is three levels up here (fhir-api's copy sits two levels deep).
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PACKAGE_CACHE = process.env.FHIR_PACKAGE_CACHE || join(ROOT, '.fhir-packages');

export function readLock() {
    return JSON.parse(readFileSync(join(ROOT, 'fhir-packages.json'), 'utf8'));
}

export function packageDir(pkg) {
    return join(PACKAGE_CACHE, `${pkg.id}#${pkg.version}`);
}

const CONFORMANCE_TYPES = new Set(['StructureDefinition', 'ValueSet', 'CodeSystem']);

/** @returns {{ pkg: object, resources: object[] }[]} in lock order */
export function loadPackages() {
    return readLock().packages.map((pkg) => {
        const dir = join(packageDir(pkg), 'package');
        if (!existsSync(dir)) throw new Error(`${pkg.id}#${pkg.version} is not extracted; run \`npm run fetch:packages\` first`);
        const resources = [];
        // sorted: readdir order differs between filesystems, and the build must be reproducible
        for (const file of readdirSync(dir).sort()) {
            if (!file.endsWith('.json') || file === 'package.json' || file === '.index.json') continue;
            let json;
            try {
                json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            } catch {
                continue;
            }
            if (CONFORMANCE_TYPES.has(json.resourceType)) resources.push(json);
        }
        return { pkg, resources };
    });
}

/** Loads the example instances shipped in a package's example/ folder. */
export function loadExamples(pkg) {
    const dir = join(packageDir(pkg), 'package', 'example');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .sort()
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ file: f, resource: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}
