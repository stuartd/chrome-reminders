import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Expected Manifest V3.');
for (const file of new Set([
  manifest.background.service_worker, manifest.action.default_popup, manifest.options_page,
  ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(script => script.js), 'app.js', 'app.css'
])) await access(new URL(file, root));
createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' });
for (const file of (await readdir(root)).filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', new URL(file, root).pathname], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('Manifest, public key, packaged files, and JavaScript syntax checked.');
