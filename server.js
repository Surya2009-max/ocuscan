/* ══════════════════════════════════════════════════════════════
   OcuScan Pro — Railway Backend (TAMPER-PROOF architecture)
   
   SECURITY MODEL:
   - Server owns ALL session state & correct answers
   - Client only sends raw user input (which letter/number/direction chosen)
   - Server validates every answer against its own stored question
   - Client CANNOT forge results — it never computes correct/incorrect
   - Sessions expire after 4 hours; each has a secret token
══════════════════════════════════════════════════════════════ */

const express      = require('express');
const cors         = require('cors');
const PDFDocument  = require('pdfkit');
const path         = require('path');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { randomBytes } = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// Railway (like Heroku/Render/most PaaS) sits exactly one reverse-proxy hop in
// front of this container and sets X-Forwarded-For on every request. Without
// this line, Express ignores that header entirely and req.ip resolves to
// Railway's internal proxy address — THE SAME for every visitor — which
// silently breaks per-user rate limiting (everyone shares one bucket) and
// triggers express-rate-limit's ERR_ERL_UNEXPECTED_X_FORWARDED_FOR validation
// error on every single request. Trusting exactly 1 hop (not `true`, which
// would trust an unbounded chain and let a client forge its own IP) restores
// accurate per-visitor req.ip.
app.set('trust proxy', 1);

/* ════════════════════════════════════════════════════════════════
   SUPABASE — Anonymous research storage (no PII, no name)
   Project: ocuscan-research (ap-south-1, free tier) — LIVE
   Set these env vars in Railway (do NOT hardcode real values here —
   this file is shared/version-controlled):
     SUPABASE_URL      = <set in Railway dashboard → Variables>
     SUPABASE_ANON_KEY = <set in Railway dashboard → Variables>
   Table: vision_screenings — already created with RLS (insert-only via anon key).
   NOTE: if real values were ever committed to this file, rotate the
   anon key in the Supabase dashboard immediately — a committed key
   must be treated as compromised even after removal from source.
════════════════════════════════════════════════════════════════ */
let supabase = null;
(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log('[supabase] SUPABASE_URL/SUPABASE_ANON_KEY not set — research data stored in memory only.');
    return;
  }
  try {
    const { createClient } = await import('@supabase/supabase-js').catch(() => require('@supabase/supabase-js'));
    supabase = createClient(url, key, {
      auth: { persistSession: false },
      global: { headers: { 'X-Client-Info': 'ocuscan-server/1.0' } }
    });
    console.log('[supabase] Connected — anonymous research data will be stored.');
  } catch(e) {
    console.warn('[supabase] Could not load client:', e.message);
  }
})();

// ── PERF-08: Redis-backed rate limiter (hot-swaps when REDIS_URL is set) ──
let rateLimitStore;
(async () => {
  if (process.env.REDIS_URL) {
    try {
      const { RedisStore } = await import('rate-limit-redis').catch(() => require('rate-limit-redis'));
      const { createClient } = await import('redis').catch(() => require('redis'));
      const rlRedis = createClient({ url: process.env.REDIS_URL });
      rlRedis.on('error', e => console.error('[RL-Redis]', e.message));
      await rlRedis.connect();
      rateLimitStore = new RedisStore({ sendCommand: (...args) => rlRedis.sendCommand(args) });
      console.log('[rate-limit] Redis store active — limits survive restarts across instances');
    } catch (e) {
      console.warn('[rate-limit] Redis store unavailable, using memory:', e.message);
    }
  }
})();

// FIX 02 — CORS allowlist from env (comma-separated); fallback to localhost only
// LOCAL-DEV: 'null' is included because a page opened directly from disk
// (file:///.../index.html) sends the literal Origin header value "null" —
// without it, the browser blocks every fetch() from the double-clicked file.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,null')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const RAILWAY_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || null;

// FIX 06 — Security headers (helmet first)
// LOCAL-DEV: helmet's default Cross-Origin-Resource-Policy: same-origin header
// blocks the browser from accepting responses to a page loaded from a
// different origin (e.g. a file:// page, whose origin is "null") even when
// CORS itself allows it. crossOriginResourcePolicy:false disables that header
// so the local frontend can actually read the API's responses.
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' is required: the app's UI is wired via inline onclick=""
      // attributes and inline <script> blocks throughout index.html (by design,
      // not an oversight) — without both scriptSrc AND scriptSrcAttr allowing
      // inline execution, literally every button in the app is inert.
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      connectSrc: ["'self'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:", "cdn.jsdelivr.net"],
    }
  }
}));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (RAILWAY_DOMAIN && origin.includes(RAILWAY_DOMAIN)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

// FIX 03 — Rate limiting (Redis-backed when available, memory fallback)
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, store: rateLimitStore });
const strictLimiter  = rateLimit({ windowMs:  5 * 60 * 1000, max: 20,  standardHeaders: true, legacyHeaders: false, store: rateLimitStore,
  message: { ok: false, error: 'Too many requests — please wait a moment.' }
});

app.use(generalLimiter);
app.use('/api/session/create', strictLimiter);
app.use('/api/pdf',            strictLimiter);

app.get('/', (req, res) => res.json({ ok: true, service: 'OcuScan Pro API' }));
app.use(express.json({ limit: '2mb' }));

/* ════════════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════════════ */
// SCI-03: Sloan letter set — validated optotypes with equal legibility weighting.
// Replaces the previous set which included easy-to-guess letters (E, F, L, P, T).
// Sloan: C D H K N O R S V Z — used in ETDRS charts and clinical practice.
const OPTOTYPES = ['C','D','H','K','N','O','R','S','V','Z'];

const SNELLEN = [
  { label:'6/60', logMAR:1.00, multiplier:10, rows:1 },
  { label:'6/36', logMAR:0.78, multiplier:6,  rows:1 },
  { label:'6/24', logMAR:0.60, multiplier:4,  rows:1 },
  { label:'6/18', logMAR:0.48, multiplier:3,  rows:2 },
  { label:'6/12', logMAR:0.30, multiplier:2,  rows:2 },
  { label:'6/9',  logMAR:0.15, multiplier:1.5,rows:3 },
  { label:'6/6',  logMAR:0.00, multiplier:1,  rows:3 },
];

const POWER_MAP = {
  '6/6':'Plano (0.00D)','6/9':'-0.25D to -0.75D','6/12':'-0.75D to -1.50D',
  '6/18':'-1.50D to -2.50D','6/24':'-2.50D to -3.50D','6/36':'-3.50D to -5.00D','6/60':'-5.00D or greater',
};

const NEAR_LEVELS = [
  {label:'6/60',  logMAR:1.0},
  {label:'6/38',  logMAR:0.8},
  {label:'6/24',  logMAR:0.6},
  {label:'6/19',  logMAR:0.5},
  {label:'6/15',  logMAR:0.4},
  {label:'6/12',  logMAR:0.3},
  {label:'6/9',   logMAR:0.2},
  {label:'6/7.5', logMAR:0.1},
  {label:'6/6',   logMAR:0.0},
];

const MIN_RING_DEVICE_PX = 10;
const MAX_RING_CSS_PX = 160;
const ACUITY_DEFOCUS = [[0,0],[0.15,0.5],[0.30,1.1],[0.48,2.0],[0.60,3.0],[0.78,4.25],[1.0,5.5]];

const NEAR_DIRS = ['up','right','down','left'];

/* ════════════════════════════════════════════════════════════════
   SESSION STORE
   ENG-01: Redis-backed when REDIS_URL is set; in-memory fallback
   for local dev. Set REDIS_URL=redis://... in Railway/env vars.
════════════════════════════════════════════════════════════════ */

// ── Redis client (optional) ───────────────────────────────────
let redisClient = null;
const SESSION_TTL = 4 * 60 * 60; // 4 hours in seconds

(async () => {
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = await import('redis').catch(() => require('redis'));
      redisClient = createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', e => console.error('[Redis] error:', e.message));
      await redisClient.connect();
      console.log('[sessions] Redis connected — using Redis session store');
    } catch (e) {
      console.warn('[sessions] Redis unavailable, falling back to in-memory:', e.message);
      redisClient = null;
    }
  } else {
    console.log('[sessions] No REDIS_URL — using in-memory session store (not suitable for production multi-instance)');
  }
})();

// ── In-memory fallback ────────────────────────────────────────
const memSessions = new Map();

// Prune in-memory sessions every 30 min
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL * 1000;
  const deleted = [];
  for (const [id, s] of memSessions) {
    if (s.createdAt < cutoff) { memSessions.delete(id); deleted.push(id); }
  }
  if (deleted.length) console.log(`[sessions] Purged ${deleted.length} expired in-memory sessions. Active: ${memSessions.size}`);
}, 30 * 60 * 1000);

// ── Unified session API ───────────────────────────────────────
async function saveSession(sessionId, data) {
  if (redisClient) {
    await redisClient.setEx(`ocu:session:${sessionId}`, SESSION_TTL, JSON.stringify(data));
  } else {
    memSessions.set(sessionId, data);
  }
}

async function loadSession(sessionId) {
  if (redisClient) {
    const raw = await redisClient.get(`ocu:session:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return memSessions.get(sessionId) || null;
}

async function deleteSession(sessionId) {
  if (redisClient) {
    await redisClient.del(`ocu:session:${sessionId}`);
  } else {
    memSessions.delete(sessionId);
  }
}

function genToken() {
  return randomBytes(32).toString('hex');
}

async function createSession(patientName = '') {
  const sessionId = genToken();
  const token     = genToken();
  const data = {
    token,
    patientName,
    createdAt: Date.now(),
    eye: 'OD',
    calibPPMM: null,
    calibDone: false,
    distanceCm: 60,
    snellen:  { level:0, currentLetter:null, results:[], fails:0, done:false },
    near:     { level:0, currentDir:null, correct:0, total:0, done:false },
    diopter:  { farPointCm:null, nearPointCm:null, done:false },
    results:  {},
    completed:{},
    glasses:  null,  // FEATURE-07: 'yes'|'no'|'contacts'|null
    symptoms: {},    // FEATURE-03: pre-test symptom timeline answers
  };
  await saveSession(sessionId, data);
  return { sessionId, token };
}

async function getSession(sessionId, token) {
  const s = await loadSession(sessionId);
  if (!s) return null;
  if (s.token !== token) return null;
  return s;
}

/* ════════════════════════════════════════════════════════════════
   SNELLEN HELPERS
════════════════════════════════════════════════════════════════ */
function pickSnellenLetter(exclude = null) {
  const pool = exclude ? OPTOTYPES.filter(l => l !== exclude) : [...OPTOTYPES];
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildChoices(correct) {
  const pool = [...OPTOTYPES].sort(() => Math.random() - .5);
  const choices = [correct];
  for (const l of pool) { if (!choices.includes(l)) choices.push(l); if (choices.length === 6) break; }
  return choices.sort(() => Math.random() - .5);
}

function cleanDist(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 15 && n <= 200 ? n : fallback;
}

function cleanDpr(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 1;
}

function round2(n) { return Math.round(n * 100) / 100; }

function nearGeometry(levelIdx, distCm, ppmm, dpr) {
  const lv = NEAR_LEVELS[levelIdx];
  const ringArcMin = Math.pow(10, lv.logMAR) * 5;
  const nominalPx = distCm * 10 * Math.tan((ringArcMin / 60) * Math.PI / 180) * ppmm;
  const minPx = MIN_RING_DEVICE_PX / dpr;
  const ringPx = Math.min(MAX_RING_CSS_PX, Math.max(minPx, nominalPx));
  return {
    ringPx: round2(ringPx),
    minPx: round2(minPx),
    ringArcMin: round2(ringArcMin),
    effLogMAR: round2(lv.logMAR + Math.log10(ringPx / nominalPx)),
    limited: nominalPx < minPx,
  };
}

function nearPayload(s, action) {
  const lv = NEAR_LEVELS[s.near.level];
  const dist = s.near.lastDist;
  const geo = nearGeometry(s.near.level, dist, s.calibPPMM || (96 / 25.4), s.near.dpr);
  s.near.geo = geo;
  return {
    ok: true, action, level: s.near.level, total: NEAR_LEVELS.length,
    direction: s.near.currentDir, label: lv.label, logMAR: lv.logMAR,
    ringPx: geo.ringPx, minPx: geo.minPx, ringArcMin: geo.ringArcMin, baseDist: dist,
  };
}

function acuityToDefocus(logMAR) {
  const t = ACUITY_DEFOCUS;
  if (logMAR <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (logMAR <= t[i][0]) {
      const [x0, y0] = t[i - 1], [x1, y1] = t[i];
      return y0 + ((logMAR - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return t[t.length - 1][1];
}

function ringEvidence(s) {
  const n = s.results.nearVision && s.results.nearVision[s.eye];
  if (!n || typeof n.logMAR !== 'number' || n.pixelLimited) return null;
  const reach = 100 / Math.max(20, Math.min(150, n.distanceCm || 40));
  const defocus = acuityToDefocus(n.logMAR);
  return { reach, defocus, blurred: defocus >= 0.5 };
}

function refinePowerWithRings(farPower, ev) {
  if (!ev) return { power: farPower, shift: 0, note: '' };
  let target = null;
  if (ev.blurred && Math.abs(farPower) >= ev.reach - 0.5) {
    target = -(ev.reach + ev.defocus);
  } else if (!ev.blurred && Math.abs(farPower) > ev.reach + 1.0) {
    target = -(ev.reach + 1.0);
  }
  if (target === null) {
    const note = ev.blurred ? ' Rings looked soft up close, which can also come from far-sightedness or astigmatism.' : '';
    return { power: farPower, shift: 0, note };
  }
  const blended = 0.6 * farPower + 0.4 * target;
  const shift = Math.max(-1.0, Math.min(1.0, blended - farPower));
  const power = Math.round((farPower + shift) * 4) / 4;
  const moved = power - farPower;
  const note = moved === 0 ? '' : ` Ring test adjusted this by ${moved > 0 ? '+' : '−'}${Math.abs(moved).toFixed(2)}D.`;
  return { power, shift: moved, note };
}

function calcLetterHeightPx(snellenLevel, distCm, calibPPMM) {
  const dist_mm = (distCm || 60) * 10;
  // Standard Snellen: each letter is 5 arcminutes tall at its reference distance.
  // h = dist_mm * tan(5/60 * π/180) — pinhole model, valid for small angles.
  const angle_rad = (5 / 60) * (Math.PI / 180);
  const baseH_mm = dist_mm * Math.tan(angle_rad);
  const mult = SNELLEN[snellenLevel].multiplier;
  // Use calibrated PPMM; fall back to 96 DPI (3.78 px/mm) for uncalibrated sessions
  const ppmm = calibPPMM || (96 / 25.4);
  return Math.max(12, Math.min(400, baseH_mm * mult * ppmm));
}

function snellenQuestion(s) {
  const lv  = SNELLEN[s.snellen.level];
  const letter = pickSnellenLetter();
  s.snellen.currentLetter = letter;
  const numLetters = lv.rows;
  const letters = [letter];
  while (letters.length < numLetters) {
    const l = pickSnellenLetter(letters[letters.length - 1]);
    letters.push(l);
  }
  const pxH = calcLetterHeightPx(s.snellen.level, s.distanceCm, s.calibPPMM);
  return {
    level:   s.snellen.level,
    label:   lv.label,
    logMAR:  lv.logMAR,
    letters,           // displayed to user
    choices: buildChoices(letter), // shuffled — correct one is hidden server-side
    pxH,
    arcMin:  (5 * lv.multiplier).toFixed(1),
  };
}

function finishSnellen(s) {
  const correctLevels = s.snellen.results.filter(r => r.correct).map(r => r.level);
  const bestLevel = correctLevels.length > 0 ? Math.max(...correctLevels) : 0;
  const lv = SNELLEN[bestLevel];
  const total   = s.snellen.results.length;
  const correct = s.snellen.results.filter(r => r.correct).length;
  const result = {
    label:    lv.label, logMAR: lv.logMAR, level: bestLevel,
    power:    POWER_MAP[lv.label],
    accuracy: total ? Math.round(correct / total * 100) : 0,
    dist:     s.distanceCm,
  };
  if (!s.results.snellen) s.results.snellen = {};
  s.results.snellen[s.eye] = result;
  s.completed['snellen-' + s.eye] = true;
  s.snellen.done = true;
  return result;
}

/* ════════════════════════════════════════════════════════════════
   RESULTS HELPERS
════════════════════════════════════════════════════════════════ */
function computeOHI(results) {
  const r = results; let totalW = 0, score = 0;
  if (r.snellen) {
    const od = r.snellen.OD, os = r.snellen.OS;
    if (od && os) {
      // Average both eyes for composite score (worst eye weighted slightly more)
      const worstLogMAR = Math.max(od.logMAR, os.logMAR);
      const avgLogMAR = (od.logMAR + os.logMAR) / 2;
      const effectiveLogMAR = (worstLogMAR * 0.6 + avgLogMAR * 0.4);
      score += Math.max(0, 100*(1 - effectiveLogMAR/1.0))*0.45; totalW += 0.45;
    } else {
      const a = od || os;
      if (a) { score += Math.max(0, 100*(1-a.logMAR/1.0))*0.45; totalW += 0.45; }
    }
  }
  if (r.nearVision) {
    const nod = r.nearVision.OD, nos = r.nearVision.OS;
    if (nod && nos) {
      const worst = Math.min(nod.score, nos.score), avg = (nod.score + nos.score) / 2;
      score += (worst * 0.6 + avg * 0.4) * 0.15; totalW += 0.15;
    } else {
      const n = nod || nos;
      if (n) { score += n.score * 0.15; totalW += 0.15; }
    }
  }
  if (r.contrast)  { score += r.contrast.score * 0.20;                     totalW += 0.20; }
  if (r.diopter) {
    const pctFor = p => Math.max(0, Math.min(100, 100 - Math.abs(p) / 18 * 100));
    const dod = r.diopter.OD, dos = r.diopter.OS;
    if (dod && dos) {
      const worst = Math.min(pctFor(dod.power), pctFor(dos.power)), avg = (pctFor(dod.power) + pctFor(dos.power)) / 2;
      score += (worst * 0.6 + avg * 0.4) * 0.20; totalW += 0.20;
    } else {
      const d = dod || dos;
      if (d) { score += pctFor(d.power) * 0.20; totalW += 0.20; }
    }
  }
  if (totalW < 0.1) return null;
  const ohi = Math.round(score / totalW);
  const label = ohi>=90?'Excellent':ohi>=75?'Good':ohi>=55?'Fair':'Below Average';
  return { ohi, color: ohi>=75?'green':ohi>=55?'amber':'red', label };
}

// BUG-13: helper that picks the better (lower logMAR) eye instead of blindly defaulting to OD
function bestEyeAcuity(r) {
  const od = r.snellen?.OD, os = r.snellen?.OS;
  if (od && os) return od.logMAR <= os.logMAR ? od : os;
  return od || os || null;
}

// Near Vision and Diopter became per-eye tests — same "pick the better eye
// for the headline tile, but weight the worse eye into OHI" pattern as acuity.
function bestEyeNear(r) {
  const od = r.nearVision?.OD, os = r.nearVision?.OS;
  if (od && os) return od.score >= os.score ? od : os;
  return od || os || null;
}
function bestEyeDiopter(r) {
  const od = r.diopter?.OD, os = r.diopter?.OS;
  if (od && os) return Math.abs(od.power) <= Math.abs(os.power) ? od : os;
  return od || os || null;
}

function buildScorecard(results) {
  const r = results, tiles = [];
  const acuityPcts = {'6/6':100,'6/9':84,'6/12':68,'6/18':52,'6/24':36,'6/36':20,'6/60':8};
  const acuity = bestEyeAcuity(r); // BUG-13 fix
  if (acuity)      tiles.push({pct:acuityPcts[acuity.label]||50,color:'cyan',label:'Visual Acuity',val:acuity.label,sub:`Acc: ${acuity.accuracy||'—'}%`});
  const near = bestEyeNear(r);
  if (near)        tiles.push({pct:near.score,color:'teal',label:'Near Vision',val:near.label,sub:(near.passed?'Normal reading acuity':'Reduced near acuity')+' · Best eye'});
  const diop = bestEyeDiopter(r);
  if (diop)        { const col=diop.power<-6?'red':diop.power<-.5?'amber':'green'; tiles.push({pct:Math.max(0,Math.min(100,100-Math.abs(diop.power)/18*100)),color:col,label:'Diopter',val:diop.power===0?'Plano':(diop.power>0?'+':'')+diop.power.toFixed(2)+'D',sub:diop.category+' · Best eye'}); }
  if (r.contrast)  tiles.push({pct:r.contrast.score,color:r.contrast.score>=80?'green':r.contrast.score>=50?'amber':'red',label:'Contrast Sensitivity',val:r.contrast.label,sub:`${r.contrast.passed}/${r.contrast.total} rows passed`});
  return tiles;
}

function buildRecommendations(results) {
  const r = results, acuity = bestEyeAcuity(r), recs = []; // BUG-13 fix
  if (acuity) {
    if (acuity.level<=2) recs.push({i:'👓',t:`<strong>Corrective lenses strongly indicated.</strong> Best acuity was ${acuity.label}.`});
    else if (acuity.level<=4) recs.push({i:'🔍',t:`<strong>Mild visual blur detected</strong> (${acuity.label}). Routine optometry consultation suggested.`});
    else recs.push({i:'✅',t:`<strong>Good visual acuity</strong> (${acuity.label}). Maintain annual check-ups.`});
  }
  if (r.contrast?.score < 80) recs.push({i:'🌫',t:`<strong>Reduced contrast sensitivity detected</strong> (${r.contrast.label}). May indicate early macular, glaucoma, or cataract changes. Professional evaluation recommended.`});
  if (acuity?.level < 6) recs.push({i:'👁',t:'<strong>20-20-20 Rule:</strong> Every 20 min of screen-work, look 20 feet away for 20 seconds.'}); // BUG-14: removed the identical unconditional duplicate that appeared below this line
  if (acuity && ['6/36','6/60'].includes(acuity.label)) recs.push({i:'🚨',t:'<strong>High Myopia Alert:</strong> Dilated fundus exam strongly recommended.'});
  recs.push({i:'📅',t:'Schedule a <strong>professional comprehensive eye exam</strong> at least annually.'});
  return recs;
}

function buildPowerEyes(results) {
  if (!results.snellen) return [];
  return ['OD','OS'].map(eye => {
    const r = results.snellen[eye];
    if (!r) return {eye, notTested:true};
    // BUG: power from POWER_MAP is a string like '-0.75D to -1.50D'; store it as powerRange
    // so the client can show it meaningfully instead of the raw undefined from r.power
    return {eye, power: r.power || 'See range', powerRange: r.power, label:r.label, logMAR:r.logMAR, accuracy:r.accuracy};
  });
}

function buildNearEyes(results) {
  if (!results.nearVision) return [];
  return ['OD','OS'].map(eye => {
    const r = results.nearVision[eye];
    if (!r) return {eye, notTested:true};
    return {eye, label:r.label, score:r.score, passed:r.passed};
  });
}

function buildDiopterEyes(results) {
  if (!results.diopter) return [];
  return ['OD','OS'].map(eye => {
    const r = results.diopter[eye];
    if (!r) return {eye, notTested:true};
    return {eye, power:r.power, category:r.category};
  });
}

/* ════════════════════════════════════════════════════════════════
   MIDDLEWARE: session guard (reusable)
════════════════════════════════════════════════════════════════ */
// ENG-01: requireSession is now async — uses Redis or in-memory transparently
async function requireSession(req, res, next) {
  const { sessionId, token } = req.body;
  if (!sessionId || !token) return res.status(400).json({ok:false,error:'Missing sessionId or token'});
  try {
    const s = await getSession(sessionId, token);
    if (!s) return res.status(403).json({ok:false,error:'Invalid or expired session. Please restart the test.'});
    req.session   = s;
    req.sessionId = sessionId; // expose so endpoints can call saveSession after mutation
    next();
  } catch (e) {
    console.error('[session] getSession error:', e);
    return res.status(500).json({ok:false,error:'Session store error — please try again.'});
  }
}

// Helper: persist session mutations back to store (Redis or mem)
async function persistSession(req) {
  await saveSession(req.sessionId, req.session);
}

/* ════════════════════════════════════════════════════════════════
   API ENDPOINTS
════════════════════════════════════════════════════════════════ */

app.get('/health', async (req, res) => {
  const redisOk = redisClient ? redisClient.isReady : null;
  const activeSessions = redisClient ? '(redis)' : memSessions.size;
  res.json({status:'ok', service:'OcuScan Pro API', sessionStore: redisClient ? 'redis' : 'memory', redisOk, activeSessions, ts: new Date().toISOString()});
});

/* ── Session ── */
app.post('/api/session/create', async (req, res) => {
  let { patientName, calibPPMM, calibDone } = req.body;
  if (patientName !== undefined) {
    patientName = String(patientName).trim().replace(/[^\x20-\x7E\u00A0-\u024F]/g, '');
    if (patientName.length > 80) return res.status(400).json({ok:false, error:'patientName exceeds 80 characters'});
  }
  try {
    const { sessionId, token } = await createSession(patientName || '');
    const s = await loadSession(sessionId);
    if (calibPPMM) { s.calibPPMM = calibPPMM; s.calibDone = !!calibDone; }
    await saveSession(sessionId, s);
    res.json({ok:true, sessionId, token});
  } catch (e) {
    console.error('[session/create] error:', e);
    res.status(500).json({ok:false, error:'Could not create session. Please try again.'});
  }
});

app.post('/api/session/update', requireSession, async (req, res) => {
  const s = req.session;
  let { calibPPMM, calibDone, distanceCm, eye, patientName } = req.body;
  if (patientName !== undefined) {
    patientName = String(patientName).trim().replace(/[^\x20-\x7E\u00A0-\u024F]/g, '');
    if (patientName.length > 80) return res.status(400).json({ok:false, error:'patientName exceeds 80 characters'});
    s.patientName = patientName;
  }
  if (calibPPMM  !== undefined) s.calibPPMM  = calibPPMM;
  if (calibDone  !== undefined) s.calibDone  = calibDone;
  if (distanceCm !== undefined) s.distanceCm = distanceCm;
  if (eye        !== undefined) s.eye        = eye;
  await persistSession(req);
  res.json({ok:true});
});

/* ── FEATURE-07: Glasses/contacts context ── */
app.post('/api/session/glasses', requireSession, async (req, res) => {
  const { glasses } = req.body;
  if (!['yes','no','contacts'].includes(glasses)) return res.status(400).json({ok:false,error:'Invalid value'});
  req.session.glasses = glasses;
  await persistSession(req);
  res.json({ok:true});
});

/* ── FEATURE-03: Pre-test symptom timeline ── */
app.post('/api/session/symptoms', requireSession, async (req, res) => {
  const { lastExam, recentChanges, currentCorrection } = req.body;
  req.session.symptoms = {
    lastExam:          String(lastExam||'').slice(0,100),
    recentChanges:     String(recentChanges||'').slice(0,200),
    currentCorrection: String(currentCorrection||'').slice(0,100),
    recordedAt:        new Date().toISOString(),
  };
  await persistSession(req);
  res.json({ok:true});
});

/* ══════════════════════════════════════════
   SNELLEN
══════════════════════════════════════════ */
app.post('/api/snellen/start', requireSession, async (req, res) => {
  const s = req.session;
  const { eye, distanceCm } = req.body;
  s.eye = eye || s.eye;
  if (distanceCm) s.distanceCm = distanceCm;
  s.snellen = {level:0, currentLetter:null, results:[], fails:0, done:false};
  const q = snellenQuestion(s);
  await persistSession(req);
  res.json({ok:true, question:q});
});

app.post('/api/snellen/answer', requireSession, async (req, res) => {
  const s = req.session;
  const { userAnswer, distanceCm } = req.body;
  if (distanceCm) s.distanceCm = distanceCm;

  if (!s.snellen.currentLetter) return res.status(400).json({ok:false,error:'No active question'});

  const correct = userAnswer === s.snellen.currentLetter;
  s.snellen.results.push({level: s.snellen.level, correct});
  s.snellen.currentLetter = null;

  if (correct) {
    if (s.snellen.level < SNELLEN.length - 1) {
      s.snellen.level++;
      s.snellen.fails = 0; // FIX (SCI-03): 3 misses PER ROW — the counter was never reset between rows
      const q = snellenQuestion(s);
      await persistSession(req); return res.json({ok:true, wasCorrect:true, action:'next_level', question:q});
    } else {
      const result = finishSnellen(s);
      await persistSession(req); return res.json({ok:true, wasCorrect:true, action:'finish', result});
    }
  } else {
    s.snellen.fails++;
    // SCI-03: Standard Snellen halts at 3 misses per row (was incorrectly 2)
    if (s.snellen.fails >= 3) {
      const result = finishSnellen(s);
      await persistSession(req); return res.json({ok:true, wasCorrect:false, action:'finish', result});
    } else {
      const q = snellenQuestion(s);
      await persistSession(req); return res.json({ok:true, wasCorrect:false, action:'retry', question:q});
    }
  }
});

app.post('/api/snellen/cantread', requireSession, async (req, res) => {
  const s = req.session;
  if (s.snellen.done) return res.json({ok:true, action:'finish', result: s.results.snellen[s.eye]});
  s.snellen.results.push({level: s.snellen.level, correct:false});
  s.snellen.currentLetter = null;
  const result = finishSnellen(s);
  await persistSession(req);
  res.json({ok:true, action:'finish', result});
});

/* ══════════════════════════════════════════
   NEAR VISION
══════════════════════════════════════════ */
app.post('/api/near/start', requireSession, async (req, res) => {
  const s = req.session;
  const { eye, distanceCm, dpr } = req.body;
  s.eye = eye || s.eye;
  const dist = cleanDist(distanceCm, s.distanceCm || 40);
  s.distanceCm = dist;
  s.near = {
    level:0, currentDir:NEAR_DIRS[Math.floor(Math.random() * 4)], correct:0, total:0, done:false,
    dists:[dist], lastDist:dist, dpr:cleanDpr(dpr), geo:null, bestEff:null,
  };
  const payload = nearPayload(s, 'next');
  await persistSession(req);
  res.json(payload);
});

app.post('/api/near/answer', requireSession, async (req, res) => {
  const s = req.session;
  const { userAnswer, distanceCm, dpr } = req.body;
  if (!s.near || !s.near.currentDir) {
    if (s.near?.done) return res.json({ok:true, action:'finish', result:s.results.nearVision?.[s.eye]});
    return res.status(400).json({ok:false, error:'No active question'});
  }
  const dist = cleanDist(distanceCm, s.near.lastDist);
  s.near.lastDist = dist;
  s.near.dists.push(dist);
  s.near.dpr = cleanDpr(dpr || s.near.dpr);
  s.distanceCm = dist;
  const ok = userAnswer === s.near.currentDir;
  s.near.total++; if (ok) s.near.correct++;
  s.near.currentDir = null;
  let capped = false;
  if (ok) {
    s.near.bestEff = s.near.geo ? s.near.geo.effLogMAR : NEAR_LEVELS[s.near.level].logMAR;
    s.near.level++;
    if (s.near.level < NEAR_LEVELS.length) {
      capped = nearGeometry(s.near.level, dist, s.calibPPMM || (96 / 25.4), s.near.dpr).limited;
    }
  }
  if (!ok || capped || s.near.level >= NEAR_LEVELS.length) {
    const meanDist = Math.round(s.near.dists.reduce((a, b) => a + b, 0) / s.near.dists.length * 10) / 10;
    let nearResult;
    if (s.near.level === 0) {
      nearResult = {label:'Below 6/60', level:0, passed:false, score:0, logMAR:1.2, distanceCm:meanDist, note:'Could not identify the largest ring. Professional assessment recommended.'};
    } else {
      const best   = NEAR_LEVELS[s.near.level - 1];
      const passed = capped || best.logMAR <= 0.2;
      nearResult = {
        label:best.label, level:s.near.level, passed,
        score:capped ? 100 : Math.round((s.near.level / NEAR_LEVELS.length) * 100),
        logMAR:s.near.bestEff, distanceCm:meanDist, pixelLimited:capped,
        note:capped ? 'Every ring this screen can draw at this distance was identified. Finer detail is limited by screen resolution.'
                    : (passed ? 'Normal near acuity achieved.' : 'Reduced near acuity detected.'),
      };
    }
    if (!s.results.nearVision) s.results.nearVision = {};
    s.results.nearVision[s.eye] = nearResult;
    s.completed['near-' + s.eye] = true; s.near.done = true;
    await persistSession(req);
    return res.json({ok:true, action:'finish', result:s.results.nearVision[s.eye]});
  }
  s.near.currentDir = NEAR_DIRS[Math.floor(Math.random() * 4)];
  const payload = nearPayload(s, 'next');
  await persistSession(req);
  res.json(payload);
});

/* ══════════════════════════════════════════
   DIOPTER
══════════════════════════════════════════ */
app.post('/api/diopter/start', requireSession, async (req, res) => {
  const s = req.session;
  const { eye } = req.body;
  s.eye = eye || s.eye;
  s.diopter = {farPointCm:null, nearPointCm:null, done:false};
  await persistSession(req);
  res.json({ok:true});
});

app.post('/api/diopter/blur', requireSession, async (req, res) => {
  const s = req.session;
  const { phase, distanceCm } = req.body;
  if (!distanceCm || distanceCm < 4) return res.status(400).json({ok:false,error:'No distance data'});
  if (phase === 1) {
    s.diopter.farPointCm = distanceCm;
    await persistSession(req);
    return res.json({ok:true, action:'phase2', farPointCm:distanceCm});
  }
  s.diopter.nearPointCm = distanceCm;
  const result = calcDiopter(s);
  await persistSession(req);
  return res.json({ok:true, action:'finish', result});
});

app.post('/api/diopter/cantblur', requireSession, async (req, res) => {
  const s = req.session;
  const { phase } = req.body;
  if (phase === 1) {
    // User couldn't blur at any distance — assume emmetrope / hyperope (no myopia)
    s.diopter.farPointCm = 999;
    await persistSession(req);
    return res.json({ok:true, action:'phase2'});
  }
  // Phase 2: couldn't identify near point of accommodation — treat as not measured
  s.diopter.nearPointCm = 999;
  const result = calcDiopter(s);
  await persistSession(req);
  return res.json({ok:true, action:'finish', result});
});

function calcDiopter(s) {
  const fp = s.diopter.farPointCm;
  const ev = ringEvidence(s);
  let power, category, note, rawPower = null, ringShift = 0, ringNote = '';
  if (fp >= 999) {
    power=0; category='Emmetrope (Normal Vision)'; note='No significant blur detected.';
    if (ev && ev.blurred) ringNote = ' Rings looked soft up close, which can also come from far-sightedness or astigmatism.';
  }
  else if (fp <= 5.6) { power=-18.0; category='Extreme High Myopia'; note='⚠ Dilated fundus exam strongly recommended.'; }
  else {
    rawPower = Math.round((-100/fp)*4)/4;
    const adj = refinePowerWithRings(rawPower, ev);
    power = adj.power; ringShift = adj.shift; ringNote = adj.note;
    if (power<-6)      { category='High Myopia';    note='⚠ Dilated fundus exam recommended.'; }
    else if (power<-3) { category='Moderate Myopia'; note='Regular eye exams advised.'; }
    else if (power<-.5){ category='Mild Myopia';    note='20-20-20 rule recommended.'; }
    else               { category='Near Normal';    note='Minimal refractive error.'; }
  }
  const result = {power, category, note: note + ringNote, farPointCm:fp, rawPower, ringShift};
  if (!s.results.diopter) s.results.diopter = {};
  s.results.diopter[s.eye] = result;
  s.completed['diopter-' + s.eye] = true;
  s.diopter.done = true;
  return result;
}

/* ══════════════════════════════════════════
   RESULTS + PDF + CSV
══════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════════
   FEATURE-04: CONTRAST SENSITIVITY TEST
   6 rows of 3 Sloan letters at decreasing contrast (1.0→0.05).
   Scoring: number of rows passed × ~16.7 = contrast score 0–100.
════════════════════════════════════════════════════════════════ */
const CS_ROWS = [
  { contrast: 1.00, letters: ['N','V','K'] },
  { contrast: 0.60, letters: ['D','H','C'] },
  { contrast: 0.35, letters: ['Z','O','S'] },
  { contrast: 0.20, letters: ['R','D','N'] },
  { contrast: 0.10, letters: ['K','V','H'] },
  { contrast: 0.05, letters: ['C','Z','O'] },
];

app.post('/api/contrast/start', requireSession, async (req, res) => {
  const s = req.session;
  s.contrast = { row: 0, passed: 0, done: false };
  await persistSession(req);
  res.json({ ok:true, row: 0, total: CS_ROWS.length, contrast: CS_ROWS[0].contrast });
});

app.post('/api/contrast/answer', requireSession, async (req, res) => {
  const s = req.session;
  const { canRead } = req.body;
  if (!s.contrast) return res.status(400).json({ok:false, error:'No contrast test active'});
  if (s.contrast.done) return res.json({ok:true, action:'finish', result:s.results.contrast});
  if (canRead) s.contrast.passed++;
  s.contrast.row++;
  // Stop on first row they cannot read (standard Pelli-Robson halts at first failure)
  if (!canRead || s.contrast.row >= CS_ROWS.length) {
    const score = Math.round((s.contrast.passed / CS_ROWS.length) * 100);
    const label = score >= 80 ? 'Normal' : score >= 50 ? 'Mildly reduced' : 'Significantly reduced';
    const note  = score < 80
      ? 'Reduced contrast sensitivity may indicate early macular or optic nerve changes. Professional evaluation recommended.'
      : 'Contrast sensitivity appears normal for this screen test.';
    s.results.contrast = { passed: s.contrast.passed, total: CS_ROWS.length, score, label, note };
    s.completed['contrast'] = true; s.contrast.done = true;
    await persistSession(req);
    return res.json({ ok:true, action:'finish', result: s.results.contrast });
  }
  await persistSession(req);
  const next = CS_ROWS[s.contrast.row];
  res.json({ ok:true, action:'next', row: s.contrast.row, total: CS_ROWS.length, contrast: next.contrast });
});

app.post('/api/contrast/letters', requireSession, async (req, res) => {
  const s = req.session;
  if (!s.contrast) return res.status(400).json({ok:false, error:'No contrast test active'});
  const row = CS_ROWS[s.contrast.row];
  if (!row) return res.status(400).json({ok:false, error:'Invalid row'});
  res.json({ ok:true, letters: row.letters, contrast: row.contrast });
});
/* ════════════════════════════════════════════════════════════════
   FEATURE-06: B2B API — Optometrist Intake Tool
   Set B2B_API_KEY env var to activate. Clinics embed OcuScan
   in an iframe; completed results POST back via share link.
════════════════════════════════════════════════════════════════ */
const B2B_KEY = process.env.B2B_API_KEY || null;

function requireB2B(req, res, next) {
  if (!B2B_KEY) return res.status(503).json({ok:false,error:'B2B API not configured. Set B2B_API_KEY.'});
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== B2B_KEY) return res.status(401).json({ok:false,error:'Invalid API key.'});
  next();
}

app.get('/api/b2b/widget', requireB2B, (req, res) => {
  const base = process.env.APP_URL || `http://localhost:${PORT}`;
  res.json({ok:true, widgetVersion:'1.0', embedUrl:base, tests:['snellen','near','contrast'],
    instructions:'Embed embedUrl in an iframe with allow="camera;microphone". On completion the widget calls POST /api/results/compute with the session credentials to retrieve the patient\'s scorecard, OHI, and recommendations server-side.',
    example:{iframe:`<iframe src="${base}?b2b=1" width="100%" height="700" frameborder="0" allow="camera;microphone"></iframe>`}});
});

app.post('/api/research/submit', async (req, res) => {
  // Always respond immediately — Supabase insert is fire-and-forget
  res.json({ok:true});

  // Extract ONLY anonymous numeric/categorical fields — no name, no sessionId stored
  const {
    snellenOD, snellenOS, logMarOD, logMarOS,
    ohi,
    nearLabel, diopterOD, diopterOS,
    contrastScore, glasses, calibDone, distanceCm
  } = req.body;

  if (!supabase) return; // Supabase not configured — silent skip

  try {
    const { error } = await supabase.from('vision_screenings').insert({
      ohi_score:            typeof ohi === 'number' ? ohi : null,
      snellen_od:           snellenOD     || null,
      snellen_od_logmar:    typeof logMarOD === 'number' ? logMarOD : null,
      snellen_os:           snellenOS     || null,
      snellen_os_logmar:    typeof logMarOS === 'number' ? logMarOS : null,
      near_label:           nearLabel     || null,
      diopter_od:           typeof diopterOD === 'number' ? diopterOD : null,
      diopter_os:           typeof diopterOS === 'number' ? diopterOS : null,
      contrast_score:       typeof contrastScore === 'number' ? contrastScore : null,
      glasses:              glasses       || null,
      calib_done:           typeof calibDone === 'boolean' ? calibDone : null,
      distance_cm:          typeof distanceCm === 'number' ? Math.round(distanceCm) : null,
    });
    if (error) console.error('[supabase] insert error:', error.message);
    else console.log('[supabase] Research record saved anonymously.');
  } catch(e) {
    console.error('[supabase] unexpected error:', e.message);
  }
});

app.post('/api/results/compute', requireSession, async (req, res) => {
  const s = req.session;
  res.json({
    ok:                   true,
    ohi:                  computeOHI(s.results),
    scorecard:            buildScorecard(s.results),
    recs:                 buildRecommendations(s.results),
    powerEyes:            buildPowerEyes(s.results),
    nearEyes:             buildNearEyes(s.results),
    diopterEyes:          buildDiopterEyes(s.results),
    completed:            s.completed,
    glasses:              s.glasses   || null,
    symptoms:             s.symptoms  || {},
    contrastScore:        s.results.contrast?.score        ?? null,
    contrastLabel:        s.results.contrast?.label        || null,
  });
});

app.post('/api/pdf', requireSession, async (req, res) => {
  try {
    const s   = req.session;
    const buf = await generatePDF(s, req.sessionId);
    res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="OcuScan_Report_${Date.now()}.pdf"`});
    res.send(buf);
  } catch(e) { res.status(500).json({ok:false, error:e.message}); }
});

app.post('/api/csv', requireSession, async (req, res) => {
  const s = req.session;
  const r = s.results;
  // Use last 8 chars of actual sessionId for the reference (passed via requireSession)
  const { sessionId } = req.body;
  const sessionRef = 'OSP-' + (sessionId || Date.now().toString()).slice(-8).toUpperCase();
  const rows = [
    ['PARAMETER','VALUE','UNIT'],
    ['Session Ref', sessionRef,''],
    ['Test Date', new Date().toISOString(),''],
    ['Calibration Done', s.calibDone?'YES':'NO',''],
    ['PPMM', s.calibPPMM?.toFixed(4)||'est 3.78','px/mm'],
    ['Distance (last)', s.distanceCm?.toFixed(1)||'N/A','cm'],
    // FEATURE-07: glasses context
    ['Wearing Correction', s.glasses||'not specified',''],
    // FEATURE-03: symptom timeline
    ['Last Eye Exam', s.symptoms?.lastExam||'not specified',''],
    ['Recent Changes', s.symptoms?.recentChanges||'not specified',''],
    ['Snellen OD', r.snellen?.OD?.label||'—',''],
    ['Snellen OD logMAR', r.snellen?.OD?.logMAR?.toFixed(3)||'—','logMAR'],
    ['Snellen OS', r.snellen?.OS?.label||'—',''],
    ['Snellen OS logMAR', r.snellen?.OS?.logMAR?.toFixed(3)||'—','logMAR'],
    ['Near Vision OD', r.nearVision?.OD?.label||'—',''],
    ['Near Vision OS', r.nearVision?.OS?.label||'—',''],
    ['Diopter OD', r.diopter?.OD?.power??'—','D'],
    ['Diopter OS', r.diopter?.OS?.power??'—','D'],
    ['Contrast Sensitivity Score', r.contrast?.score??'—','%'],
    ['Contrast Sensitivity Label', r.contrast?.label||'Not tested',''],
  ];
  res.set({'Content-Type':'text/csv','Content-Disposition':`attachment; filename="OcuScan_Research_${Date.now()}.csv"`});
  res.send(rows.map(r=>r.map(c=>`"${c}"`).join(',')).join('\n'));
});


/* ── PDF builder — premium one-page report ───────────────────────────────────
   Page height is split 25 / 50 / 25:
     25%  HERO      the estimated glasses power, one huge number per eye
     50%  DETAILS   the other tests (left, 61.8%) and suggestions (right, 38.2%) in small type
     25%  BRANDING  a slim masthead (1/φ² of the 25%) + a richer footer (1/φ of the 25%)
   Type ladder = 7.5pt × φⁿ  (7.5 · 12.1 · 19.6 · 31.8 · 51.4 · 83.2).  Spacing = Fibonacci (13 · 21 · 34).
   NOTE: PDFKit does not understand CSS "rgba()" strings (they silently turn black) — opacity is always set
   with fillOpacity / strokeOpacity / gradient-stop opacity instead. ── */
async function generatePDF(s, sessionId) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'OcuScan Vision Report', Author: 'OcuScan Pro', Subject: 'Vision screening report' } });
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const r   = s.results || {};
    const PHI = 1.6180339887;
    const W = doc.page.width, H = doc.page.height;
    const M = 34, G = 21, CW = W - 2 * M;                       // Fibonacci margin / gutter
    const T = n => 7.5 * Math.pow(PHI, n);                      // golden type ladder

    // ── zones: 25 / 50 / 25 ──
    const hBrand = H * 0.25, hHero = H * 0.25, hBody = H * 0.50;
    const hMast  = hBrand / (PHI * PHI), hFoot = hBrand - hMast; // golden split of the branding 25%
    const yHero  = hMast, yBody = hMast + hHero, yFoot = yBody + hBody;

    const C = { deep:'#061230', navy:'#0B1B3F', indigo:'#1B3A8F', glow:'#4F7CFF',
                gold:'#FFC83D', goldLt:'#FFE29A', goldDp:'#E8A300', mist:'#CBD5EE',
                ink:'#0B1B3F', ink2:'#4A587A', white:'#FFFFFF' };

    /* ── helpers ── */
    const keep  = t => String(t == null ? '' : t).replace(/<[^>]*>/g, '')
                        .replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, '')   // drop emoji etc. (not in the PDF font)
                        .replace(/\s+/g, ' ');
    const clean = t => keep(t).trim();
    const lin   = (x0, y0, x1, y1, stops) => { const g = doc.linearGradient(x0, y0, x1, y1); stops.forEach(([o, c, a]) => g.stop(o, c, a)); return g; };
    const fmtPower = p => p === 0 ? '0.00' : (p < 0 ? '\u2013' : '+') + Math.abs(p).toFixed(2);   // en dash = proper minus sign
    const plainPower = d => {                                   // same wording + thresholds as the results page
      const p = d && typeof d.power === 'number' ? d.power : null;
      if (p === null) return { num: '\u2014', state: 'Not tested', line: 'No result for this eye.' };
      const num = fmtPower(p);
      if (p >= -0.5) return { num, state: 'Looks sharp',            line: 'Faraway things should look clear without glasses.' };
      if (p >= -3)   return { num, state: 'Slightly short-sighted', line: 'Faraway things may look a little soft.' };
      if (p >= -6)   return { num, state: 'Short-sighted',          line: 'Faraway things look blurry without glasses.' };
      return               { num, state: 'Very short-sighted',      line: 'Faraway things look very blurry without glasses.' };
    };
    const segs = html => {                                      // "<strong>lead</strong> rest" -> [{t,b},…]
      const out = []; const re = /<strong>([\s\S]*?)<\/strong>/g; let last = 0, m;
      while ((m = re.exec(html))) { if (m.index > last) out.push({ t: keep(html.slice(last, m.index)), b: false }); out.push({ t: keep(m[1]), b: true }); last = re.lastIndex; }
      if (last < html.length) out.push({ t: keep(html.slice(last)), b: false });
      const f = out.filter(x => x.t.trim());
      if (f.length) { f[0].t = f[0].t.replace(/^\s+/, ''); f[f.length - 1].t = f[f.length - 1].t.replace(/\s+$/, ''); }
      for (let k = 1; k < f.length; k++) if (/^\s/.test(f[k].t)) { f[k].t = f[k].t.replace(/^\s+/, ''); if (!/\s$/.test(f[k - 1].t)) f[k - 1].t += ' '; }   // a wrapped line must never start with a space
      return f;
    };
    const rings = (cx, cy, radii, clip, goldIdx) => {          // iris motif — concentric rings, Fibonacci radii
      doc.save(); doc.rect(clip.x, clip.y, clip.w, clip.h).clip();
      radii.forEach((rad, i) => {
        const g = i === goldIdx;
        doc.circle(cx, cy, rad).lineWidth(g ? 1 : 0.7).strokeColor(g ? C.gold : C.white).strokeOpacity(g ? 0.3 : 0.09).stroke();
      });
      doc.restore();
    };
    const logoMark = (x, y, size) => {
      doc.save();
      doc.roundedRect(x, y, size, size, size * 0.28).fill(lin(x, y, x + size, y + size, [[0, C.goldLt], [1, C.goldDp]]));
      const cx = x + size / 2, cy = y + size / 2, ew = size * 0.30, eh = size * 0.20;
      doc.lineWidth(size * 0.075).lineJoin('round').strokeColor(C.navy)
         .moveTo(cx - ew, cy).bezierCurveTo(cx - ew * 0.5, cy - eh * 1.7, cx + ew * 0.5, cy - eh * 1.7, cx + ew, cy)
         .bezierCurveTo(cx + ew * 0.5, cy + eh * 1.7, cx - ew * 0.5, cy + eh * 1.7, cx - ew, cy).stroke();
      doc.circle(cx, cy, size * 0.095).fill(C.navy);
      doc.restore();
    };
    const fadeLine = (x, y, w, h, color, aMid) => doc.rect(x, y, w, h).fill(lin(x, 0, x + w, 0, [[0, color, 0], [0.5, color, aMid], [1, color, 0]]));

    const ref     = 'OSP-' + (sessionId || Date.now().toString()).slice(-8).toUpperCase();
    const dateStr = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    doc.rect(0, 0, W, H).fill(C.white);

    /* ═════════ TOP FIELD: masthead (branding) + hero (25%) — one continuous gradient ═════════ */
    doc.rect(0, 0, W, yBody).fill(lin(0, 0, W, yBody, [[0, C.deep], [0.55, C.navy], [1, C.indigo]]));
    const gcx = W / 2, gcy = yHero + hHero * 0.5;
    const glow = doc.radialGradient(gcx, gcy, 0, gcx, gcy, W * 0.56); glow.stop(0, C.glow, 0.32).stop(1, C.glow, 0);
    doc.rect(0, 0, W, yBody).fill(glow);
    rings(gcx, gcy, [144, 233, 377], { x: 0, y: yHero + 2, w: W, h: hHero - 4 }, 1);   // halo behind the numbers; clipped to the hero so it never touches the masthead text

    // masthead
    const mkS = 30, mkY = (hMast - mkS) / 2;
    logoMark(M, mkY, mkS);
    doc.font('Helvetica-Bold').fontSize(T(1)).fillColor(C.white).text('OcuScan ', M + mkS + 13, mkY + 2, { continued: true, lineBreak: false })
       .fillColor(C.gold).text('Pro', { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(T(0)).fillColor(C.mist).text('VISION SCREENING REPORT', M + mkS + 13, mkY + 2 + T(1) + 3, { characterSpacing: 1.6, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white).text(dateStr, W - M - 220, mkY + 4, { width: 220, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(T(0)).fillColor(C.mist).text('Ref ' + ref, W - M - 220, mkY + 4 + 14, { width: 220, align: 'right', lineBreak: false });
    fadeLine(M, hMast - 0.4, CW, 0.8, C.white, 0.22);

    // hero
    doc.font('Helvetica-Bold').fontSize(T(0)).fillColor(C.gold)
       .text('ESTIMATED GLASSES POWER', 0, yHero + G, { width: W, align: 'center', characterSpacing: 2.4, lineBreak: false });
    const colW = CW / 2;
    ['OD', 'OS'].forEach((eye, i) => {
      const x0 = M + i * colW;
      const t  = plainPower(r.diopter && r.diopter[eye]);
      const has = t.num !== '\u2014';
      doc.font('Helvetica-Bold').fontSize(T(1)).fillColor(C.white)
         .text(i === 0 ? 'RIGHT EYE' : 'LEFT EYE', x0, yHero + 45, { width: colW, align: 'center', characterSpacing: 2.4, lineBreak: false });
      let fs = has ? T(5) : T(4); const maxW = colW - 2 * G;                      // 'not tested' placeholder is smaller than a real result
      doc.font('Helvetica-Bold');
      while (fs > 30 && doc.fontSize(fs).widthOfString(t.num) > maxW) fs -= 1;     // very large powers shrink to fit, never overflow
      const ny = yHero + 72 + (T(5) - fs) * 0.42;
      doc.fillColor(has ? lin(0, ny + fs * 0.14, 0, ny + fs * 0.92, [[0, C.goldLt], [1, C.goldDp]]) : C.mist)
         .fontSize(fs).text(t.num, x0, ny, { width: colW, align: 'center', lineBreak: false });
      const sy = yHero + 152;
      doc.font('Helvetica-Bold').fontSize(T(1)).fillColor(C.white).text(t.state, x0, sy, { width: colW, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(C.mist).text(t.line, x0 + G, sy + T(1) + 5, { width: colW - 2 * G, align: 'center', lineBreak: false });
    });
    doc.rect(W / 2 - 0.4, yHero + 52, 0.8, hHero - 86).fill(lin(0, yHero + 52, 0, yHero + hHero - 34, [[0, C.white, 0], [0.5, C.white, 0.32], [1, C.white, 0]]));
    doc.rect(0, yBody - 1.5, W, 1.5).fill(lin(0, 0, W, 0, [[0, C.goldDp, 0], [0.5, C.gold, 1], [1, C.goldDp, 0]]));

    /* ═════════ DETAILS (50%): other tests (61.8%) · suggestions (38.2%) ═════════ */
    const LW = (CW - G) * 0.618, RW = (CW - G) - LW;
    const rx = M + LW + G;
    const padT = 29, padB = G, noteH = 22;
    const bodyTop = yBody + padT, bodyBottom = yFoot - padB - noteH;
    const blockH = (bodyBottom - bodyTop) / 3;

    const snl = e => r.snellen && r.snellen[e], nr = e => r.nearVision && r.nearVision[e], ct = r.contrast;
    const eyeCells = (getter, main, note) => ['OD', 'OS'].map((e, i) => {
      const v = getter(e);
      return { label: i === 0 ? 'Right eye' : 'Left eye', value: v ? main(v) : '\u2014', note: v ? note(v) : 'Not tested', off: !v };
    });
    const blocks = [
      { cap: 'DISTANCE SIGHT', sub: 'Smallest line read on the eye chart',
        cells: eyeCells(snl, v => v.label, v => (v.accuracy != null ? v.accuracy : '\u2014') + '% of letters correct') },
      { cap: 'READING SIGHT', sub: 'Smallest print read up close',
        cells: eyeCells(nr, v => v.label, v => v.passed ? 'Read every line up close' : 'Could not read the smallest lines') },
      { cap: 'CONTRAST', sub: 'Seeing faint shades against a background',
        cells: [ ct ? { label: 'Both eyes', value: clean(ct.label), note: ct.passed + ' of ' + ct.total + ' rows read clearly', off: false, wide: true }
                    : { label: 'Both eyes', value: '\u2014', note: 'Not tested', off: true, wide: true } ] },
    ];
    blocks.forEach((b, i) => {
      const y0 = bodyTop + i * blockH;
      doc.font('Helvetica-Bold').fontSize(T(0)).fillColor(C.ink).text(b.cap, M, y0, { characterSpacing: 1.6, lineBreak: false });
      doc.font('Helvetica').fontSize(T(0)).fillColor(C.ink2).text(b.sub, M, y0 + 11.5, { width: LW, lineBreak: false });
      const cw = b.cells[0].wide ? LW : LW / 2;
      b.cells.forEach((c, k) => {
        const cx = M + k * cw + (k ? 14 : 0);
        doc.font('Helvetica').fontSize(T(0)).fillColor(C.ink2).text(c.label, cx, y0 + 33, { width: cw - 10, lineBreak: false });
        const big = c.wide ? T(2) : T(3);
        const inner = cw - (k ? 14 : 0) - 10;
        let vs = big; doc.font('Helvetica-Bold');
        while (vs > 14 && doc.fontSize(vs).widthOfString(c.value) > inner) vs -= 0.5;            // long labels shrink, never wrap or collide
        const vy = y0 + 44 + (c.wide ? 8 : 0);
        doc.font('Helvetica-Bold').fontSize(vs).fillColor(c.off ? '#A9B3CB' : C.ink)
           .text(c.value, cx, vy + (big - vs) * 0.45, { width: inner, lineBreak: false });
        doc.font('Helvetica').fontSize(T(0)).fillColor(C.ink2).text(c.note, cx, vy + big + 5, { width: inner, lineBreak: false, ellipsis: true });
      });
      if (b.cells.length === 2) doc.rect(M + LW / 2 - 2, y0 + 36, 0.7, 62).fill(lin(0, y0 + 36, 0, y0 + 98, [[0, C.ink2, 0], [0.5, C.ink2, 0.35], [1, C.ink2, 0]]));
      if (i < 2) fadeLine(M, y0 + blockH - 9, LW, 0.8, C.ink2, 0.4);
    });

    // suggestions panel — sized to its content, with a floor of 61.8% of the column height
    const panelMax = bodyBottom - bodyTop, head = G + 28;
    let recs = [];
    try { recs = buildRecommendations(r).map(x => segs(x.t)).filter(x => x.length).slice(0, 5); } catch (_) {}
    const tx = rx + G + 12, tw = RW - 2 * G - 12, availList = panelMax - head - G;
    const measure = (fs, list) => list.reduce((sum, sg) => {
      doc.font('Helvetica-Bold').fontSize(fs);
      return sum + doc.heightOfString(sg.map(x => x.t).join(' '), { width: tw, lineGap: fs * 0.22 });
    }, 0);
    const minGap = 10;
    let fs = 9.5;                                                              // as large as the panel allows (still small print), never below 7pt
    while (fs > 7 && measure(fs, recs) + minGap * (recs.length - 1) > availList) fs -= 0.5;
    while (recs.length > 3 && measure(fs, recs) + minGap * (recs.length - 1) > availList) recs.pop();
    const textH  = measure(fs, recs);
    const gap    = Math.min(26, Math.max(minGap, (availList - textH) / Math.max(1, recs.length - 1)));
    const panelH = Math.min(panelMax, Math.max(panelMax * 0.618, head + textH + gap * (recs.length - 1) + G));
    doc.roundedRect(rx, bodyTop, RW, panelH, 13).fill(lin(rx, bodyTop, rx + RW * 0.5, bodyTop + panelH, [[0, '#F5F7FD'], [1, '#E3E9F7']]));
    doc.roundedRect(rx, bodyTop, RW, panelH, 13).lineWidth(0.6).strokeColor('#D3DBEE').stroke();
    doc.font('Helvetica-Bold').fontSize(T(0)).fillColor(C.ink).text('WHAT WE SUGGEST', rx + G, bodyTop + G, { characterSpacing: 1.6, lineBreak: false });
    doc.rect(rx + G, bodyTop + G + 14, 21, 2).fill(lin(rx + G, 0, rx + G + 21, 0, [[0, C.goldLt], [1, C.goldDp]]));
    let ry = bodyTop + head;
    recs.forEach((sg, idx) => {
      doc.circle(rx + G + 2.5, ry + fs * 0.45, 2.2).fill(C.goldDp);
      sg.forEach((p, k) => {
        doc.font(p.b ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(C.ink)
           .text(p.t, k === 0 ? tx : undefined, k === 0 ? ry : undefined, { width: tw, lineGap: fs * 0.22, continued: k < sg.length - 1 });
      });
      if (idx < recs.length - 1) fadeLine(rx + G, doc.y + gap / 2 - 0.4, RW - 2 * G, 0.8, C.ink2, 0.28);
      ry = doc.y + gap;
    });

    // test conditions — context a doctor needs, one quiet line
    const note = [ s.distanceCm ? 'Tested at ' + Math.round(s.distanceCm) + ' cm' : null,
                   s.calibDone ? 'Screen size calibrated' : 'Screen size estimated, so results may be a little less exact' ].filter(Boolean).join('   \u00B7   ');
    doc.font('Helvetica').fontSize(T(0)).fillColor(C.ink2).text(note, M, yFoot - 21, { width: CW, lineBreak: false });

    /* ═════════ BRANDING FOOTER (1/φ of the 25%) ═════════ */
    doc.rect(0, yFoot, W, hFoot).fill(lin(0, yFoot, W, yFoot + hFoot, [[0, '#1B202B'], [0.6, C.navy], [1, '#16358A']]));
    rings(W - 30, yFoot + 44, [34, 55, 89, 144], { x: 0, y: yFoot + 2, w: W, h: 80 }, 2);   // clipped above the disclaimer
    doc.rect(0, yFoot, W, 2).fill(lin(0, 0, W, 0, [[0, C.goldDp], [0.5, C.goldLt], [1, C.goldDp]]));
    logoMark(M, yFoot + 24, 44);
    doc.font('Helvetica-Bold').fontSize(T(2)).fillColor(C.white).text('OcuScan ', M + 57, yFoot + 25, { continued: true, lineBreak: false })
       .fillColor(C.gold).text('Pro', { lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.mist).text('A free eye check you can do on your own screen.', M + 57, yFoot + 25 + T(2) + 4, { width: 320, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.gold).text('ocuscan1@gmail.com', W - M - 200, yFoot + 33, { width: 200, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(T(0)).fillColor(C.mist).text('Surya Productions', W - M - 200, yFoot + 47, { width: 200, align: 'right', lineBreak: false });
    fadeLine(M, yFoot + 83, CW, 0.7, C.white, 0.3);
    doc.font('Helvetica').fontSize(7).fillColor(C.mist).text(
      'OcuScan Pro is a screening tool, not a medical exam or diagnosis. Results can be affected by screen set-up, lighting and distance. ' +
      'Please see an eye doctor to confirm your results, and before you buy glasses.   \u00A9 ' + new Date().getFullYear() + ' Surya Productions.',
      M, yFoot + 92, { width: CW, lineGap: 2.2 });

    doc.end();
  });
}

/* ════════════════════════════════════════════════════════════════
   FEATURE-01: LONGITUDINAL TRACKING
   Passphrase-based — no account, no email, no PII required.
   User picks any passphrase; results are saved under a hashed key.
   SHA-256 of passphrase = storage key (passphrase never stored).
   ─────────────────────────────────────────────────────────────────
   POST /api/history/save    → saves snapshot under passphrase hash
   POST /api/history/load    → returns all snapshots for passphrase
   POST /api/history/delete  → removes all history for passphrase
════════════════════════════════════════════════════════════════ */
const { createHash } = require('crypto');
const historyStore = new Map(); // mirrors Redis pattern

function passphraseKey(passphrase) {
  // Hash so raw passphrase is never stored — treat like a password
  return 'ocu:history:' + createHash('sha256').update(passphrase.trim().toLowerCase()).digest('hex').slice(0,32);
}

async function loadHistory(passphrase) {
  const key = passphraseKey(passphrase);
  if (redisClient) {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : [];
  }
  return historyStore.get(key) || [];
}

async function saveHistory(passphrase, entries) {
  const key = passphraseKey(passphrase);
  const str = JSON.stringify(entries);
  if (redisClient) {
    // Keep history for 2 years
    await redisClient.setEx(key, 2 * 365 * 24 * 60 * 60, str);
  } else {
    historyStore.set(key, entries);
  }
}

app.post('/api/history/save', requireSession, async (req, res) => {
  const s = req.session;
  const { passphrase } = req.body;
  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length < 4) {
    return res.status(400).json({ok:false, error:'Passphrase must be at least 4 characters.'});
  }
  if (!s.completed || Object.keys(s.completed).length === 0) {
    return res.status(400).json({ok:false, error:'Complete at least one test before saving.'});
  }

  const ohi = computeOHI(s.results);
  const entry = {
    date:       new Date().toISOString(),
    ohiScore:   ohi?.ohi   ?? null,
    ohiLabel:   ohi?.label ?? null,
    snellenOD:  s.results.snellen?.OD?.label    ?? null,
    snellenOS:  s.results.snellen?.OS?.label    ?? null,
    logMarOD:   s.results.snellen?.OD?.logMAR   ?? null,
    logMarOS:   s.results.snellen?.OS?.logMAR   ?? null,
    nearLabelOD: s.results.nearVision?.OD?.label ?? null,
    nearLabelOS: s.results.nearVision?.OS?.label ?? null,
    diopterOD:   s.results.diopter?.OD?.power    ?? null,
    diopterOS:   s.results.diopter?.OS?.power    ?? null,
    glasses:    s.glasses                       ?? null,
    calibDone:  s.calibDone,
  };

  const history = await loadHistory(passphrase);
  history.unshift(entry); // newest first
  // Cap at 50 entries per passphrase
  if (history.length > 50) history.length = 50;
  await saveHistory(passphrase, history);

  res.json({ok:true, entryCount: history.length, saved: entry});
});

app.post('/api/history/load', async (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length < 4) {
    return res.status(400).json({ok:false, error:'Passphrase must be at least 4 characters.'});
  }
  const history = await loadHistory(passphrase);
  res.json({ok:true, entries: history, count: history.length});
});

app.post('/api/history/delete', async (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase || typeof passphrase !== 'string') {
    return res.status(400).json({ok:false, error:'Passphrase required.'});
  }
  const key = passphraseKey(passphrase);
  if (redisClient) await redisClient.del(key);
  else historyStore.delete(key);
  res.json({ok:true, message:'History deleted.'});
});

const server = app.listen(PORT, () => console.log(`[OcuScan] Server on port ${PORT}`));

// FIX 09 — Graceful shutdown on SIGTERM (Railway deploys/restarts)
process.on('SIGTERM', () => {
  console.log('[OcuScan] SIGTERM received — shutting down gracefully');
  server.close(() => {
    console.log('[OcuScan] All connections closed. Exiting.');
    process.exit(0);
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => { console.error('[OcuScan] Force exit after timeout'); process.exit(1); }, 10000);
});
