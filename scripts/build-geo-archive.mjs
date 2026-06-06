/**
 * Build the local GEO (GOES magnetometer) archive from NCEI's daily HDF5 files.
 *
 * NCEI serves the GOES-R magnetometer as daily netCDF4/HDF5 (1-min), not parseable by
 * the app's stack — so this standalone Node script (plain Node, h5wasm for HDF5) does
 * the heavy one-time download + parse, writing a compact hourly archive the app reads.
 *
 * Per day it picks the satellite by era (GOES-18 for 2022+, GOES-16 for 2021; GOES-19
 * as fallback), reads Hp (b_epn[:,1]) + |H| (b_total), hourly-averages, and persists
 * incrementally. Resumable: re-running skips days already archived.
 *
 *   node scripts/build-geo-archive.mjs [years=6]
 */
import * as hdf5 from 'h5wasm';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

const BASE = 'https://data.ngdc.noaa.gov/platforms/solar-space-observing-satellites/goes';
const OUT = path.join(process.cwd(), 'data', 'console', 'geo-archive.json');
const EPOCH = Date.UTC(2000, 0, 1, 12, 0, 0); // GOES "seconds since 2000-01-01 12:00:00"
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CONCURRENCY = 4;
const UA = { headers: { 'User-Agent': 'HelioSat-archive/1.0 (+research)' } };
let logged = 0;

await hdf5.ready;
const { FS } = hdf5;

const years = Number(process.argv[2]) || 6;
const endMs = Date.now();
const startMs = endMs - Math.round(years * 365.25) * DAY;

let rows = [];
if (existsSync(OUT)) { try { rows = JSON.parse(readFileSync(OUT, 'utf8')).rows ?? []; } catch { /* fresh */ } }
const byHour = new Map(rows.map(r => [r[0], r]));

function flush() {
  const out = [...byHour.values()].sort((a, b) => a[0] - b[0]);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ updatedAtMs: Date.now(), rows: out }));
}

// Month directory listing -> map 'YYYYMMDD' -> file URL (handles the version suffix).
const listingCache = new Map();
async function monthFiles(sat, year, month) {
  const key = `${sat}-${year}-${month}`;
  if (listingCache.has(key)) return listingCache.get(key);
  const url = `${BASE}/${sat}/l2/data/magn-l2-avg1m/${year}/${String(month).padStart(2, '0')}/`;
  const map = new Map();
  let okFetch = false;
  try {
    const res = await fetch(url, UA);
    if (res.ok) {
      okFetch = true;
      const html = await res.text();
      for (const m of html.matchAll(/href="(dn_magn-l2-avg1m_[^"]*_d(\d{8})_[^"]*\.nc)"/g)) map.set(m[2], url + m[1]);
    }
  } catch (e) { if (logged < 8) { console.log('LISTING ERR', key, e.message); logged += 1; } }
  // Only cache a *successful* listing; let failures retry next time.
  if (okFetch) listingCache.set(key, map);
  return map;
}

function parseDay(buf) {
  const name = `d_${Math.random().toString(36).slice(2)}.nc`;
  FS.writeFile(name, new Uint8Array(buf));
  let time, bepn, total;
  try {
    const f = new hdf5.File(name, 'r');
    time = f.get('time').value;
    bepn = f.get('b_epn').value; // flat, 1440*3 (He, Hp, Hn)
    total = f.get('b_total').value;
    f.close();
  } finally {
    try { FS.unlink(name); } catch { /* ignore */ }
  }
  const acc = new Map(); // hourMs -> {hpSum,hpN,tSum,tN}
  const ok = v => Number.isFinite(v) && Math.abs(v) < 9000; // drop -9999 fill / NaN
  for (let i = 0; i < time.length; i += 1) {
    const hour = Math.floor((EPOCH + time[i] * 1000) / HOUR) * HOUR;
    let a = acc.get(hour);
    if (!a) { a = { hpSum: 0, hpN: 0, tSum: 0, tN: 0 }; acc.set(hour, a); }
    const hp = bepn[i * 3 + 1];
    const tot = total[i];
    if (ok(hp)) { a.hpSum += hp; a.hpN += 1; }
    if (ok(tot)) { a.tSum += tot; a.tN += 1; }
  }
  return acc;
}

async function dayTask(d) {
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const mo = dt.getUTCMonth() + 1;
  const ymd = `${y}${String(mo).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
  const dayStart = Date.UTC(y, mo - 1, dt.getUTCDate());
  let have = 0;
  for (let h = 0; h < 24; h += 1) if (byHour.has(dayStart + h * HOUR)) have += 1;
  if (have >= 20) return 'skip';

  const prefs = y >= 2022 ? ['goes18', 'goes16', 'goes19'] : ['goes16', 'goes18'];
  let url = null;
  for (const sat of prefs) { const files = await monthFiles(sat, y, mo); if (files.has(ymd)) { url = files.get(ymd); break; } }
  if (!url) { if (logged < 8) { console.log('NO URL', ymd, 'prefs', prefs.join(',')); logged += 1; } return 'fail'; }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, UA);
      if (!res.ok) { if (logged < 8) { console.log('NC STATUS', res.status, url.slice(-44)); logged += 1; } await new Promise(r => setTimeout(r, 800)); continue; }
      const acc = parseDay(await res.arrayBuffer());
      for (const [hour, a] of acc) {
        const hp = a.hpN ? Math.round((a.hpSum / a.hpN) * 100) / 100 : null;
        const tot = a.tN ? Math.round((a.tSum / a.tN) * 100) / 100 : null;
        if (hp === null && tot === null) continue;
        byHour.set(hour, [hour, hp, tot]);
      }
      return 'fetch';
    } catch (e) { if (logged < 8) { console.log('NC ERR', url.slice(-44), e.message); logged += 1; } await new Promise(r => setTimeout(r, 800)); }
  }
  return 'fail';
}

// Build the day list, run with a small concurrency pool, flush periodically.
const days = [];
for (let d = startMs; d < endMs; d += DAY) days.push(d);
const stats = { fetch: 0, skip: 0, fail: 0 };
let idx = 0;
let done = 0;
const total = days.length;

async function worker() {
  while (idx < days.length) {
    const d = days[idx++];
    const r = await dayTask(d);
    stats[r] += 1;
    done += 1;
    if (done % 30 === 0) { flush(); console.log(`${new Date(d).toISOString().slice(0, 10)}  ${done}/${total}  fetched ${stats.fetch} skipped ${stats.skip} failed ${stats.fail}  rows ${byHour.size}`); }
  }
}

console.log(`GEO archive build: ${new Date(startMs).toISOString().slice(0, 10)} -> ${new Date(endMs).toISOString().slice(0, 10)} (${total} days), concurrency ${CONCURRENCY}`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
flush();
const all = [...byHour.values()].sort((a, b) => a[0] - b[0]);
console.log(`DONE: rows ${all.length}  coverage ${all.length ? new Date(all[0][0]).toISOString().slice(0, 10) : '-'} -> ${all.length ? new Date(all[all.length - 1][0]).toISOString().slice(0, 10) : '-'}  | fetched ${stats.fetch} skipped ${stats.skip} failed ${stats.fail}`);
