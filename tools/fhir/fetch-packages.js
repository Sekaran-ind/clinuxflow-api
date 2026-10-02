// Copied from clinuxflow-fhir-api (scripts/fetch-packages.js): downloads and sha256-verifies the
// packages pinned in fhir-packages.json into .fhir-packages/ (gitignored). Build-time only.
// Downloads the FHIR packages pinned in fhir-packages.json into .fhir-packages/, verifies each
// sha256, and extracts it. Idempotent: a package already present with the right hash is skipped.
//
//   npm run fetch:packages
//
// FHIR_PACKAGE_CACHE=<dir> points at a pre-populated cache instead (offline builds).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_CACHE, packageDir, readLock } from './lib/fhir-packages.js';

const lock = readLock();
mkdirSync(PACKAGE_CACHE, { recursive: true });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

for (const pkg of lock.packages) {
    const tgz = join(PACKAGE_CACHE, `${pkg.id}#${pkg.version}.tgz`);
    const dir = packageDir(pkg);

    if (!existsSync(tgz) || sha256(readFileSync(tgz)) !== pkg.sha256) {
        const url = `${lock.registry}/${pkg.id}/${pkg.version}`;
        process.stdout.write(`fetching ${url} ... `);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const actual = sha256(buf);
        if (actual !== pkg.sha256) throw new Error(`${pkg.id}#${pkg.version}: sha256 ${actual} does not match the pinned ${pkg.sha256}`);
        writeFileSync(tgz, buf);
        console.log(`${(buf.length / 1e6).toFixed(1)} MB, sha256 ok`);
    } else {
        console.log(`${pkg.id}#${pkg.version}: cached, sha256 ok`);
    }

    if (!existsSync(join(dir, 'package', 'package.json'))) {
        mkdirSync(dir, { recursive: true });
        // bsdtar/GNU tar both handle .tgz; available on macOS, Linux and Windows 10+.
        execFileSync('tar', ['-xzf', tgz, '-C', dir]);
    }
}
