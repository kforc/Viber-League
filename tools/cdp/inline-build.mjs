// Dev-only: fold the Vite build into ONE portable HTML file.
//
// `dist/` is a normal multi-file build; this collapses it into
// `Viber-League.html` at the repo root so the game can be opened straight off
// the filesystem (or handed to someone) with no server and no sibling assets.
//
//   node tools/cdp/inline-build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'dist');
const outFile = path.join(root, 'Viber-League.html');

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

// Pull the built asset names out of the emitted HTML rather than guessing the
// content hashes — they change on every build.
const jsHref = html.match(/<script[^>]+src="\.\/([^"]+)"/)?.[1];
const cssHref = html.match(/<link[^>]+href="\.\/([^"]+)"/)?.[1];
if (!jsHref || !cssHref) throw new Error('could not find the built assets in dist/index.html');

const js = fs.readFileSync(path.join(dist, jsHref), 'utf8');
const css = fs.readFileSync(path.join(dist, cssHref), 'utf8');

// `</script>` inside the bundle would close the tag early; the escape is
// equivalent inside a JS string/regex context and inert everywhere else.
const safeJs = js.replaceAll('</script', '<\\/script');

/*
 * Every replacement below is passed as a FUNCTION, never as a string.
 *
 * In a string replacement `$&`, `` $` ``, `$'`, `$$` and `$n` are magic — and
 * the minified Three.js bundle really does contain `$&&($[_].dispose()…)`
 * (twice). As a string replacement that `$&` expands to the matched text,
 * splicing a literal `</body>` into the middle of the JavaScript and producing
 * `SyntaxError: Unexpected token '<'` at boot. A function replacement is
 * returned verbatim, so `$` stays a `$`.
 */
const out = html
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>\s*/, () => '')
  .replace(/<link[^>]*rel="stylesheet"[^>]*>\s*/, () => '')
  .replace('</head>', () => `  <style>\n${css}\n  </style>\n  </head>`)
  .replace('</body>', () => `  <script type="module">\n${safeJs}\n  </script>\n  </body>`);

fs.writeFileSync(outFile, out);

/*
 * Verify the embed actually round-trips. Length alone is not enough — the `$&`
 * bug produced a file of exactly the right size with a corrupted script body —
 * so the script text is read back out and compared to what went in.
 */
const embedded = out.match(/<script type="module">\n([\s\S]*)\n  <\/script>/)?.[1];
if (embedded !== safeJs) {
  console.error('SCRIPT CORRUPTED during inlining');
  if (embedded) {
    let i = 0;
    while (i < embedded.length && embedded[i] === safeJs[i]) i++;
    console.error(`  first difference at byte ${i}:`);
    console.error('  expected:', JSON.stringify(safeJs.slice(Math.max(0, i - 40), i + 40)));
    console.error('  actual:  ', JSON.stringify(embedded.slice(Math.max(0, i - 40), i + 40)));
  }
  process.exit(1);
}

// A single file must not reach for anything on disk.
const external = [...out.matchAll(/(?:src|href)="(?!data:|#)([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('http'));

const kb = Math.round(out.length / 1024);
console.log(`wrote ${outFile} ${kb} kB`);
if (external.length) {
  console.error('EXTERNAL REFS REMAIN:', external);
  process.exit(1);
}
console.log(`script body verified (${Math.round(js.length / 1024)} kB), no external references`);
