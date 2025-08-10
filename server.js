// server.js — simple, Render-friendly tracker (file log + sessions + realtime)
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
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace_me';
const ANONYMIZE = String(process.env.ANONYMIZE_IPS || 'false').toLowerCase() === 'true';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ----- Security / basics
app.set('trust proxy', 1); // required for cookies behind Render/Heroku proxies
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
    secure: true,     // Render is HTTPS
    sameSite: 'none', // widest compatibility
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// ----- Static files (your admin.html, admin.js, embed.js, test.html live here)
app.use('/', express.static(path.join(__dirname, 'public')));

// ----- Very small file-backed store (no DB)
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
                    .reverse(); // newest first
  const filtered = term
    ? data.filter(v => {
        const blob = [
          v.ip || '', v.path || '', v.ua || '', v.referer || ''
        ].join(' ').toLowerCase();
        return blob.includes(term);
      })
    : data;
  return filtered.slice(offset, offset + limit);
}

// ----- Helpers
function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).send('Unauthorized');
}

// ----- Rate limit for /track
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

// ----- Routes

// Session status (handy for admin boot)
app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed), anonymize: ANONYMIZE });
});

// Login with a single password (set ADMIN_PASSWORD in Render)
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

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Tracking endpoint (called by /public/embed.js)
app.post('/track', trackLimiter, (req, res) => {
  const ipRaw = getClientIp(req);
  const ip = ANONYMIZE ? '[anon]' : ipRaw;
  const ua = req.headers['user-agent'] || req.body.ua || '';
  const pathHit = req.body.path || req.body.url || (req.headers.referer || '');
  const referer = req.headers.referer || '';
  const ts = Math.floor(Date.now() / 1000);

  const visit = { ip, ua, path: pathHit, referer, ts };
  console.log('TRACK', { ip: ipRaw, path: pathHit });

  writeVisit(visit);
  io.to('admins').emit('visit', visit);

  res.json({ ok: true });
});

// Admin data endpoint expected by UI
app.get('/api/search', requireAuth, (req, res) => {
  const q = req.query.q || '';
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 2000);
  const offset = parseInt(req.query.offset || '0', 10) || 0;
  const rows = readVisits(q, limit, offset);
  res.json({ rows });
});

// Legacy alias (if your admin.js uses /api/hits)
app.get('/api/hits', requireAuth, (req, res) => {
  const rows = readVisits('', 100, 0);
  res.json(rows);
});

// ----- Socket.IO (realtime updates to admin)
io.on('connection', (socket) => {
  socket.on('join-admin', () => socket.join('admins'));
});

// ----- Start
server.listen(PORT, () => {
  console.log(`IP tracker listening on ${PORT}`);
  console.log(`ANONYMIZE_IPS=${ANONYMIZE}`);
});
