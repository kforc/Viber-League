// tools/build-site.mjs
// Build the deployable site/ directory from the canonical sources:
//   Viber-League.html  -> site/index.html
//   docs/media/*.png   -> site/docs/media/*.png
// Run before `wrangler deploy` (the npm `deploy:cf` script does both).
// site/ is gitignored — it is build output, not source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const site = path.join(root, 'site');
const siteMedia = path.join(site, 'docs', 'media');
const srcMedia = path.join(root, 'docs', 'media');

// Fresh build: drop the previous media tree and index.html so a removed
// source file does not linger, but keep the site/ root itself.
fs.rmSync(siteMedia, { recursive: true, force: true });
fs.rmSync(path.join(site, 'index.html'), { force: true });

fs.mkdirSync(siteMedia, { recursive: true });
fs.copyFileSync(path.join(root, 'Viber-League.html'), path.join(site, 'index.html'));
for (const f of fs.readdirSync(srcMedia)) {
  if (f.toLowerCase().endsWith('.png')) {
    fs.copyFileSync(path.join(srcMedia, f), path.join(siteMedia, f));
  }
}

const fmt = (n) => `${(n / 1024).toFixed(1)} kB`;
const walk = (d) => {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

console.log('site/ ready for deploy:');
let total = 0;
const files = walk(site).sort();
for (const p of files) {
  const s = fs.statSync(p);
  total += s.size;
  console.log(' ', path.relative(site, p), fmt(s.size));
}
console.log(`total: ${fmt(total)} across ${files.length} files`);
