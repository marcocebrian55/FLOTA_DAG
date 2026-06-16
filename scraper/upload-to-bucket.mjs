// Sube el JSON del scraper al bucket privado de Supabase (flota-data).
// Usa la SERVICE-ROLE key (salta RLS) — NUNCA la subas al repo ni al navegador.
// Uso (PowerShell):
//   $env:SUPABASE_SERVICE_KEY="<service_role key de Supabase → Settings → API>"
//   node scraper/upload-to-bucket.mjs
import { readFileSync } from 'node:fs';

const SUPABASE_URL = 'https://yrsynnhkgiwgiqckalxn.supabase.co';
const BUCKET = 'flota-data';
const FILE = process.argv[2] || 'cicar-prices.json';        // ruta local
const DEST = process.argv[3] || 'cicar-prices.json';        // nombre en el bucket

const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!KEY) {
  console.error('Falta SUPABASE_SERVICE_KEY. Cógela en Supabase → Project Settings → API → service_role.');
  process.exit(1);
}

const body = readFileSync(new URL(FILE, import.meta.url));

const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${DEST}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${KEY}`,
    apikey: KEY,
    'Content-Type': 'application/json',
    'x-upsert': 'true', // sobreescribe si ya existe
  },
  body,
});

const text = await res.text();
if (!res.ok) {
  console.error(`ERROR ${res.status}: ${text}`);
  process.exit(1);
}
console.log(`OK · subido ${FILE} → ${BUCKET}/${DEST} (${body.length} bytes)`);
console.log(text);
