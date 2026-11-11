import { defineConfig } from 'tsup';

export default defineConfig({
  // `cli` key → output file name: dist/cli.js (matches "bin" in package.json)
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Makes dist/cli.js directly executable (`heph` on PATH after `npm link`)
  banner: { js: '#!/usr/bin/env node' },
});
