// Writes src/version.ts from package.json's version: run by `npm version` (the "version" script), so the exported
// ENGINE_VERSION always matches what is published.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
writeFileSync(
  new URL('../src/version.ts', import.meta.url),
  `/** This build's version (written from package.json by scripts/write-version.mjs). */\nexport const ENGINE_VERSION = '${version}';\n`,
);
console.log(`src/version.ts: ${version}`);
