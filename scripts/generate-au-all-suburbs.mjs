import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const raw = require('aus-postcode-suburbs/lib/resources/aus_postcodes.json');

function titleCase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Of|And|The)\b/g, (m) => m.toLowerCase());
}

const seen = new Map();
for (const row of raw) {
  const lat = Number(row.Lat_precise ?? row.lat);
  const lng = Number(row.Long_precise ?? row.long);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  if (lat === 0 && lng === 0) continue;

  const locality = String(row.locality || '').trim();
  const state = String(row.state || '').trim().toUpperCase();
  const postcode = String(row.postcode || '').trim();
  if (!locality || !state || !postcode) continue;

  const key = `${locality.toUpperCase()}|${state}|${postcode}`;
  if (seen.has(key)) continue;

  const name = titleCase(locality);
  const id = `${name} ${state} ${postcode}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  seen.set(key, {
    id,
    name,
    state,
    postcode,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
  });
}

const list = [...seen.values()].sort(
  (a, b) =>
    a.state.localeCompare(b.state)
    || a.name.localeCompare(b.name)
    || a.postcode.localeCompare(b.postcode),
);

const outDir = path.join(root, 'src', 'data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'auAllSuburbs.json'), JSON.stringify(list));

const ts = `/** Auto-generated AU suburb master (locality + postcode + lat/lng). Source: Matthew Proctor via aus-postcode-suburbs. */
import raw from './auAllSuburbs.json';

export type AuSuburbRecord = {
  id: string;
  name: string;
  state: string;
  postcode: string;
  lat: number;
  lng: number;
};

export const AU_ALL_SUBURBS: readonly AuSuburbRecord[] = raw as AuSuburbRecord[];
`;
fs.writeFileSync(path.join(outDir, 'auAllSuburbs.ts'), ts);

console.log('count', list.length);
console.log('bytes', fs.statSync(path.join(outDir, 'auAllSuburbs.json')).size);
console.log(
  'outer melbourne sample',
  list.filter((x) => /craigieburn|point cook|pakenham|sunbury|frankston|docklands/i.test(x.name)).slice(0, 10),
);
