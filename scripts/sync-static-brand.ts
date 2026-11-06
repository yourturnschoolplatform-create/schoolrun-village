import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import appConfig from '../app.config.js';

const htmlTemplate = await readFile(resolve('index.template.html'), 'utf8');
const escapedAppName = appConfig.appName.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[character] ?? character);

const html = htmlTemplate.replaceAll('{{APP_NAME}}', escapedAppName);
const manifest = {
  name: appConfig.appName,
  short_name: appConfig.appName,
  description: `${appConfig.appName} is building a safer, school-scoped way for verified parents to share the school run.`,
  lang: 'en-AU',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f6f6f1',
  theme_color: '#0f5e5a',
  icons: [
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icons/maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
  ],
};

await Promise.all([
  writeFile(resolve('index.html'), html),
  writeFile(resolve('public/manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`),
]);

console.log(`Synced static brand metadata for ${appConfig.appName}.`);
