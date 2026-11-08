import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import appConfig from '../app.config.js';

const htmlTemplate = await readFile(resolve('index.template.html'), 'utf8');
const escapedAppName = appConfig.appName.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[character] ?? character);

const html = htmlTemplate.replaceAll('{{APP_NAME}}', escapedAppName);
const description = `${appConfig.appName} — Safe Rides, Share & Save. A joyful carpool and kids marketplace for verified Australian parents.`;
const manifest = {
  name: appConfig.appName,
  short_name: 'SchoolRun',
  description,
  lang: 'en-AU',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#F8FAFC',
  theme_color: '#FF6B6B',
  icons: [
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icons/maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
  ],
};

const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

await Promise.all([
  writeFile(resolve('index.html'), html),
  writeFile(resolve('public/manifest.webmanifest'), manifestJson),
  writeFile(resolve('public/manifest.json'), manifestJson),
]);

console.log(`Synced static brand metadata for ${appConfig.appName}.`);
