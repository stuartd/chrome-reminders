import { readFile, writeFile } from 'node:fs/promises';
const clientId = process.argv[2];
if (!clientId || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
  console.error('Usage: npm run configure -- YOUR_CLIENT_ID.apps.googleusercontent.com');
  process.exit(1);
}
const path = new URL('../extension/manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
manifest.oauth2 = {
  client_id: clientId,
  scopes: ['https://www.googleapis.com/auth/calendar.events.readonly']
};
await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
console.log('Calendar client configured. Reload the extension in chrome://extensions, then click Connect Google Calendar.');
