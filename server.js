'use strict';
require('dotenv').config();

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'cache'));
const COOKIES_FILE = process.env.COOKIES_FILE ? path.resolve(process.env.COOKIES_FILE) : '';
const JS_RUNTIME = (process.env.JS_RUNTIME || '').trim();
const MAX_CACHE_MB = parseInt(process.env.MAX_CACHE_MB || '5000', 10);
const MAX_DURATION_SEC = parseInt(process.env.MAX_DURATION_SEC || '1200', 10);
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '2', 10));
const SEARCH_MAX = 20;
const DOWNLOAD_TIMEOUT_MS = 180000;
const SEARCH_TIMEOUT_MS = 45000;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const API_KEY = (process.env.API_KEY || '').trim();

function fatal(msg) {
  console.error('[FATAL] ' + msg);
  process.exit(1);
}

if (API_KEY.length < 24) {
  fatal('Set API_KEY in .env (min 24 chars). Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}
const API_KEY_HASH = crypto.createHash('sha256').update(API_KEY).digest();

fs.mkdirSync(CACHE_DIR, { recursive: true });
// yt-dlp rewrites the cookie file, so use a writable copy (Render secret files are read-only)
let COOKIES_RUNTIME = '';
if (COOKIES_FILE) {
  if (!fs.existsSync(COOKIES_FILE)) {
    console.warn('[WARN] COOKIES_FILE is set but not found: ' + COOKIES_FILE);
  } else {
    try {
      COOKIES_RUNTIME = path.join(os.tmpdir(), 'yt-cookies.txt');
      fs.copyFileSync(COOKIES_FILE, COOKIES_RUNTIME);
    } catch (e) {
      console.warn('[WARN] Could not copy cookies file, using original: ' + e.message);
      COOKIES_RUNTIME = COOKIES_FILE;
    }
  }
}

// ---------- Helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function baseArgs() {
  const a = ['--no-warnings', '--socket-timeout', '20', '--retries', '3'];
  if (COOKIES_RUNTIME) a.push('--cookies', COOKIES_RUNTIME);
  if (JS_RUNTIME) a.push('--js-runtimes', JS_RUNTIME);
  return a;
}

function run(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > 5000000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function explainYtdlpFailure(stderr) {
  if (/sign in to confirm|not a bot|cookies/i.test(stderr)) {
    return 'YouTube blocked this server. Refresh cookies.txt (use a throwaway account).';
  }
  if (/private video|video unavailable|removed|not available/i.test(stderr)) {
    return 'This video is unavailable.';
  }
  return 'yt-dlp failed. Check server logs.';
}

// ---------- Search ----------
const searchCache = new Map();

async function searchYouTube(q, limit) {
  const key = limit + ':' + q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.t < SEARCH_CACHE_TTL_MS) return hit.data;

  const r = await run(
    [...baseArgs(), '--flat-playlist', '--dump-json', 'ytsearch' + limit + ':' + q],
    { timeoutMs: SEARCH_TIMEOUT_MS }
  );

  const results = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!j || !j.id || !ID_RE.test(j.id)) continue;
    results.push({
      id: j.id,
      title: j.title || 'Unknown',
      artist: j.channel || j.uploader || '',
      duration: typeof j.duration === 'number' ? Math.round(j.duration) : null,
      thumbnail: 'https://i.ytimg.com/vi/' + j.id + '/hqdefault.jpg',
    });
  }

  if (!results.length && r.code !== 0) {
    console.error('[search] yt-dlp failed:', r.stderr.slice(-500));
    throw new HttpError(r.timedOut ? 504 : 502, explainYtdlpFailure(r.stderr));
  }

  searchCache.set(key, { t: Date.now(), data: results });
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  return results;
}

// ---------- Download + cache ----------
const inflight = new Map();
let active = 0;
const waiters = [];

async function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

const audioPath = (id) => path.join(CACHE_DIR, id + '.m4a');

async function removeLeftovers(prefix) {
  try {
    for (const f of await fsp.readdir(CACHE_DIR)) {
      if (f.startsWith(prefix)) await fsp.unlink(path.join(CACHE_DIR, f)).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function ensureAudio(id) {
  if (inflight.has(id)) return inflight.get(id);

  const final = audioPath(id);
  const job = (async () => {
    if (await exists(final)) return final;

    await acquire();
    const tmpName = id + '.dl-' + crypto.randomBytes(4).toString('hex');
    const tmpBase = path.join(CACHE_DIR, tmpName);
    try {
      if (await exists(final)) return final;

      const args = [
        ...baseArgs(),
        '--no-playlist',
        '--match-filter', '!is_live & duration<=' + MAX_DURATION_SEC,
        '-f', 'bestaudio[ext=m4a]/bestaudio',
        '-x', '--audio-format', 'm4a',
        '--no-mtime',
        '-o', tmpBase + '.%(ext)s',
        'https://www.youtube.com/watch?v=' + id,
      ];
      const r = await run(args, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
      const out = tmpBase + '.m4a';

      if (!(await exists(out))) {
        console.error('[download] ' + id + ' failed (code ' + r.code + '):', r.stderr.slice(-500));
        if (r.timedOut) throw new HttpError(504, 'Download timed out.');
        if (r.code === 0) {
          throw new HttpError(422, 'Track skipped (too long, live, or unavailable).');
        }
        throw new HttpError(502, explainYtdlpFailure(r.stderr));
      }
      await fsp.rename(out, final);
      return final;
    } finally {
      release();
      await removeLeftovers(tmpName);
    }
  })();

  inflight.set(id, job);
  job.then(
    () => inflight.delete(id),
    () => inflight.delete(id)
  );
  return job;
}

// ---------- Cache cleanup (LRU by mtime) ----------
async function cleanCache() {
  try {
    const now = Date.now();
    const files = [];
    for (const name of await fsp.readdir(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, name);
      let st;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (name.includes('.dl-')) {
        if (now - st.mtimeMs > 3600 * 1000) await fsp.unlink(p).catch(() => {});
        continue;
      }
      if (name.endsWith('.m4a')) files.push({ p, size: st.size, t: st.mtimeMs });
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    const max = MAX_CACHE_MB * 1024 * 1024;
    if (total <= max) return;
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= max) break;
      await fsp.unlink(f.p).catch(() => {});
      total -= f.size;
    }
  } catch (e) {
    console.error('[cache] cleanup failed:', e.message);
  }
}

// ---------- Auth (single API key) ----------
const fails = new Map();
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 20;

function tooManyFails(ip) {
  const f = fails.get(ip);
  return !!f && f.n >= FAIL_MAX && Date.now() - f.t < FAIL_WINDOW_MS;
}

function noteFail(ip) {
  if (fails.size > 1000) fails.clear();
  const f = fails.get(ip);
  if (!f || Date.now() - f.t >= FAIL_WINDOW_MS) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
}

function auth(req, res, next) {
  const ip = req.ip || 'unknown';
  if (tooManyFails(ip)) return res.status(429).json({ error: 'Too many failed attempts' });

  const h = req.headers.authorization || '';
  let key = '';
  if (typeof req.headers['x-api-key'] === 'string') key = req.headers['x-api-key'];
  else if (h.startsWith('Bearer ')) key = h.slice(7);
  else if (typeof req.query.key === 'string') key = req.query.key; // HTML5 Audio / quick tests
  key = key.trim();

  if (!key) return res.status(401).json({ error: 'Missing API key' });
  const given = crypto.createHash('sha256').update(key).digest();
  if (!crypto.timingSafeEqual(given, API_KEY_HASH)) {
    noteFail(ip);
    return res.status(403).json({ error: 'Invalid API key' });
  }
  return next();
}

function validId(req) {
  const id = req.params.id;
  if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid track id');
  return id;
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get('/health', (req, res) => res.json({ ok: true }));

// GET /api/search?q=arijit&limit=10
app.get('/api/search', auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100);
  if (!q) throw new HttpError(400, 'Missing q');
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  limit = Math.min(limit, SEARCH_MAX);
  const results = await searchYouTube(q, limit);
  res.json({ results });
}));

// GET /api/prepare/:id  -> downloads into cache (optional, so player starts instantly later)
app.get('/api/prepare/:id', auth, wrap(async (req, res) => {
  const id = validId(req);
  const file = await ensureAudio(id);
  const st = await fsp.stat(file);
  res.json({ ready: true, id, size: st.size });
}));

// GET /api/stream/:id  -> audio/mp4 with Range support (ExoPlayer + HTML5 Audio)
app.get('/api/stream/:id', auth, wrap(async (req, res, next) => {
  const id = validId(req);
  const file = await ensureAudio(id);
  const now = new Date();
  fsp.utimes(file, now, now).catch(() => {});
  res.sendFile(
    file,
    {
      headers: {
        'Content-Type': 'audio/mp4',
        'Cache-Control': 'private, max-age=3600',
      },
      acceptRanges: true,
    },
    (err) => {
      if (err && !res.headersSent) next(err);
    }
  );
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: err instanceof HttpError ? err.message : 'Server error' });
});

// ---------- Start ----------
const server = app.listen(PORT, HOST, async () => {
  console.log('[music-api] listening on http://' + HOST + ':' + PORT);
  try {
    const r = await run([...baseArgs(), '--version'], { timeoutMs: 15000 });
    if (r.code === 0) console.log('[music-api] yt-dlp version ' + r.stdout.trim());
    else console.error('[music-api] yt-dlp check failed:', r.stderr.trim());
  } catch (e) {
    console.error('[music-api] yt-dlp not runnable (' + YTDLP_BIN + '):', e.message);
  }
});

cleanCache();
setInterval(cleanCache, 30 * 60 * 1000);

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
