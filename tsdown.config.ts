import { defineConfig } from 'tsdown'

/**
 * Two bundles from one package.
 *
 * The host bundle is self-contained: `lib/types/*.js` (emitted by `tsc`) is
 * bundled into `lib/index.js` with no workspace globs, project references, or
 * monorepo plugins, so the package installs from a git clone.
 *
 * The browser bundle keeps React and every `@deepseek-ai/*` package external:
 * the host's module system provides them, and bundling a second copy would give
 * the page its own React. `prepare` runs `tsc` first, which also typechecks.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    fixedExtension: false,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    deps: { neverBundle: [/^react(\/|$)/, /^@deepseek-ai\//] },
  },
])
