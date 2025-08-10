// server.js — Render-friendly tracker with server-side geolocation, file log, sessions, realtime
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
// use env first; fall back to your requested password 4750 if none set
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '4750';
const SESSION_SECRET = process.env.SESSION_SECRET || 'please_change_me';
const ANONYMIZE = String(process.env.ANONYMIZE_IPS || 'false').toLowerCase() === 'true';
const IPINFO_TOKEN = process.env.IPINFO_TOKEN || ""; // set this in Render for best geo

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- proxy/cookies/security
app.set('trust proxy', 1);                // needed on Render/Heroku-style proxies
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: true,        // Render uses HTTPS
    sameSite: 'none',    // widest compatibility
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// --- static files
app.use('/', express.static(path.join(__dirname, 'public')));

// --- file-backed store (no native DB)
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'visits.jsonl');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function writeVisit(v) {
  const line = JSON.stringify(v) + '\n';
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error('writeVisit error:', err);
    else console.log('writeVisit ok:', v.path, v.ip);
  });
}

function readVisits(q = '', limit = 500, offset = 0) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const term = (q || '').toLowerCase();
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  const data = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
                    .filter(Boolean)
                    .reverse();
  const filtered = term
    ? data.filter(v => {
        const blob = [
          v.ip || '', v.path || '', v.ua || '', v.referer || '',
          v.geo?.city || '', v.geo?.region || '', v.geo?.country || ''
        ].join(' ').toLowerCase();
        return blob.includes(term);
      })
    : data;
  return filtered.slice(offset, offset + limit);
}

// --- helpers
function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).send('Unauthorized');
}

// --- geo cache + lookup (ipinfo)
const GEO_CACHE = new Map(); // ip -> { data, ts }
function geoGet(ip){
  const v = GEO_CACHE.get(ip);
  return v && (Date.now() - v.ts < 6 * 60 * 60 * 1000) ? v.data : null; // 6h TTL
}
function geoPut(ip, data){
  GEO_CACHE.set(ip, { data, ts: Date.now() });
}
async function geolocateIp(ipRaw){
  try{
    if (!IPINFO_TOKEN) return null;      // no token, skip
    if (!ipRaw) return null;
    const ip = String(ipRaw).replace(/^::ffff:/,'');
    if (ip === '127.0.0.1' || ip === '::1') return null;

    const cached = geoGet(ip);
    if (cached) return cached;

    const r = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}?token=${encodeURIComponent(IPINFO_TOKEN)}`);
    if (!r.ok) return null;
    const j = await r.json();            // { city, region, country, loc: "lat,lon", ... }

    const out = {
      city: j.city || "",
      region: j.region || "",
      country: j.country || ""           // may be ISO code like "US"
    };
    if (j.loc && typeof j.loc === "string" && j.loc.includes(",")){
      const [lat, lon] = j.loc.split(",").map(Number);
      out.lat = lat; out.lon = lon;
    }
    geoPut(ip, out);
    return out;
  }catch{
    return null;
  }
}

// --- rate limit
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

// --- routes

// session status
app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed), anonymize: ANONYMIZE });
});

// login (single password)
app.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const password = req.body.password || '';
  if (password !== ADMIN_PASS) return res.status(401).send('Unauthorized');

  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Session error');
    req.session.authed = true;
    req.session.save((err2) => {
      if (err2) return res.status(500).send('Session save error');
      return res.redirect('/admin.html');
    });
  });
});

// logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// track
app.post('/track', trackLimiter, async (req, res) => {
  const ipRaw = getClientIp(req);
  const ip = ANONYMIZE ? '[anon]' : ipRaw;
  const ua = req.headers['user-agent'] || req.body.ua || '';
  const pathHit = req.body.path || req.body.url || (req.headers.referer || '');
  const referer = req.headers.referer || '';
  const ts = Math.floor(Date.now() / 1000);

  const geo = (!ANONYMIZE) ? await geolocateIp(ipRaw) : null;

  const visit = { ip, ua, path: pathHit, referer, ts, geo };
  console.log('TRACK', { ip: ipRaw, path: pathHit, geo: geo ? `${geo.city}, ${geo.region}, ${geo.country}` : '' });

  writeVisit(visit);
  io.to('admins').emit('visit', visit);

  res.json({ ok: true });
});

// search for admin UI
app.get('/api/search', requireAuth, (req, res) => {
  const q = req.query.q || '';
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 2000);
  const offset = parseInt(req.query.offset || '0', 10) || 0;
  const rows = readVisits(q, limit, offset);
  res.json({ rows });
});

// legacy alias
app.get('/api/hits', requireAuth, (req, res) => {
  const rows = readVisits('', 100, 0);
  res.json(rows);
});

// realtime
io.on('connection', (socket) => {
  socket.on('join-admin', () => socket.join('admins'));
});

// start
server.listen(PORT, () => {
  console.log(`IP tracker listening on ${PORT}`);
  console.log(`ANONYMIZE_IPS=${ANONYMIZE}`);
});
