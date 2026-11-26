import { defineConfig } from 'tsdown'

/**
 * Two bundles from one package.
 *
 * The host bundle is self-contained: `.build/js/*.js` (emitted by `tsc`) is
 * bundled into `lib/index.js` with no workspace globs, project references, or
 * monorepo plugins, so the package installs from a git clone.
 *
 * The browser bundle keeps React and every `@deepseek-ai/*` package external:
 * the host's module system provides them, and bundling a second copy would give
 * the page its own React. `prepare` runs `tsc` first, which also typechecks.
 */
export default defineConfig([
  {
    entry: ['./.build/js/index.js'],
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
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    deps: { neverBundle: [/^react(\/|$)/, /^@deepseek-ai\//] },
    // The host loads this file as a classic script and runs it through its
    // lazy-CJS module table: the bundle must register a factory rather than
    // be an ES module. `require` inside the factory resolves against the
    // host's module table, which is where react and the ui-* packages live.
    banner: {
      js: `window.__ModuleLoader__.load({id:"@liuhuoz/dsh-claude-mem",factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
    },
    footer: {
      js: 'return module.exports;}});',
    },
  },
])
