import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../scripts/deterministic-zip.mjs';

const checker = fileURLToPath(new URL('../check-public-tree.mjs', import.meta.url));
// Denylisted words are assembled from fragments so this test file itself stays clean.
const word = (...parts) => parts.join('');

async function tree(files) {
  const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'tree-check-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
function run(root, ...args) {
  const result = spawnSync(process.execPath, [checker, ...args.length ? args : [root]], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}
async function check(files, ...args) {
  const root = await tree(files);
  try { return run(root, ...args.map(arg => arg === '<root>' ? root : arg)); } finally { await rm(root, { recursive: true, force: true }); }
}

test('a clean tree passes and the Emscripten virtual home directory is the only /home path allowed', async () => {
  const result = await check({ 'src/a.mjs': 'export const home = "/home/web_user";\n', 'README.md': '# Plain document\n' });
  assert.equal(result.status, 0, result.output);
});

test('private keys, personal addresses, local paths and the local project name are findings', async () => {
  const marker = '-----BEGIN ' + 'PRIVATE KEY-----';
  assert.match((await check({ 'a.txt.md': marker })).output, /private-key/);
  assert.match((await check({ 'a.md': 'mail ' + word('someone', '@', 'gmail.com') })).output, /personal-email/);
  assert.match((await check({ 'a.mjs': 'const p = "/home/' + word('some', 'one') + '/work";' })).output, /home-path/);
  assert.match((await check({ 'a.md': 'see ' + word('.cache', '/dir') })).output, /cache-path/);
  assert.match((await check({ 'a.md': 'folder ' + word('Co', 'dex') })).output, /local-project-path/);
});

test('content terms are findings outside the allowlist and accepted inside it', async () => {
  const flagged = word('nsf', 'w');
  assert.equal((await check({ 'src/other.mjs': `const level = '${flagged}';` })).status, 1);
  assert.equal((await check({ 'src/extensions/metadata.mjs': `const level = '${flagged}';` })).status, 0);
  assert.match((await check({ 'docs/x.md': 'uses ' + word('man', 'gadex') })).output, /content-term/);
  assert.match((await check({ 'docs/x.md': 'uses ' + word('Cloud', 'flare') })).output, /content-term/);
});

test('logs, screenshots, binaries, generated folders and oversized files are findings', async () => {
  assert.match((await check({ 'run.log': 'x' })).output, /log-file/);
  assert.match((await check({ 'notes.txt': 'x' })).output, /log-file/);
  assert.match((await check({ 'img/a.png': 'x' })).output, /raster/);
  assert.match((await check({ 'a.jar': 'x' })).output, /binary/);
  assert.match((await check({ 'node_modules/x/index.js': 'x' })).output, /forbidden-directory/);
  assert.match((await check({ 'ui/index.html': 'x' })).output, /forbidden-directory/);
  assert.match((await check({ 'big.mjs': 'a'.repeat(5 * 1024 * 1024 + 1) })).output, /size/);
  assert.equal((await check({ 'AMO/screenshots/01.png': 'x', 'THIRD_PARTY_LICENSES/x/LICENSE.txt': 'text' })).status, 0);
});

test('package mode rejects shipped source, tests, source maps and developer notes, and scans inside JAR files', async () => {
  const jar = createZip([{ name: 'a/B.class', data: Buffer.from('compiled /home/' + word('some', 'one') + '/src/B.java') }], { epochSeconds: 1792540800 });
  const root = await tree({ 'manifest.json': '{}', 'test/a.mjs': 'x', 'ui/app.js.map': '{}', 'DEVELOPER-SNAPSHOT.md': 'x' });
  await writeFile(join(root, 'host.jar'), jar);
  try {
    const result = run(root, '--package', root);
    assert.equal(result.status, 1);
    for (const rule of ['package-content', 'source-map', 'home-path']) assert.match(result.output, new RegExp(rule));
    assert.match(result.output, /host\.jar!\/a\/B\.class/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the allowlist is documented', () => {
  const result = spawnSync(process.execPath, [checker, '--list-allowlist'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Content-term allowlist/);
  assert.match(result.stdout, /web_user/);
});
