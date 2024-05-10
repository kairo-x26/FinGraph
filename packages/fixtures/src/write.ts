import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extraFixtures, globexIncorporation, northwindFixtures } from './index';

/** Writes the sample documents to disk so they can be uploaded by hand. */
const out = path.resolve(process.argv[2] ?? 'sample-documents');
mkdirSync(out, { recursive: true });
for (const f of [...(await northwindFixtures()), ...(await extraFixtures())]) {
  writeFileSync(path.join(out, f.filename), f.bytes);
  console.log(`${f.filename}  (${f.description})`);
}
writeFileSync(path.join(out, 'globex-articles.pdf'), await globexIncorporation());
console.log(`\nwritten to ${out}`);
