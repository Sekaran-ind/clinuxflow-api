import { defineConfig } from 'vitest/config';

// Mirrors wrangler.toml's [[rules]] type = "Text" for *.yaml — Wrangler's esbuild bundler
// imports these as raw text (e.g. src/index.js's `import defaultBlueprintYaml from
// '../data/vitals-room.yaml'`), but Vitest's Vite-based transform has no idea what a .yaml
// import means and tries to parse it as JS by default. This does the same "import as raw
// string" transform for the test environment, only for src/index.test.js's benefit (it's the
// one test file that imports the real src/index.js, YAML import and all).
export default defineConfig({
    plugins: [
        {
            name: 'yaml-as-raw-text',
            transform(code, id) {
                if (id.endsWith('.yaml') || id.endsWith('.yml')) {
                    return { code: `export default ${JSON.stringify(code)};`, map: null };
                }
            },
        },
    ],
});
