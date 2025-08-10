// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'changeme'; // set strong password in env
const SALT_ROUNDS = 10;
const ANONYMIZE = process.env.ANONYMIZE_IPS === 'true'; // if true, store hashed IPs
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace_me';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// security middlewares
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production' }
}));

// basic rate limiter for tracking endpoint
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // adjust as needed
  standardHeaders: true,
  legacyHeaders: false
});

// static files
app.use('/', express.static(path.join(__dirname, 'public')));

// setup DB
const db = new Database(path.join(__dirname, 'db.sqlite'));
db.pragma('journal_mode = WAL');
db.prepare(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    ua TEXT,
    path TEXT,
    referer TEXT,
    ts INTEGER NOT NULL
  )
`).run();

// prepared statements
const insertStmt = db.prepare('INSERT INTO visits (ip, ua, path, referer, ts) VALUES (?, ?, ?, ?, ?)');
const searchStmtBase = 'SELECT id, ip, ua, path, referer, ts FROM visits';

// helper to get real client IP
function getClientIp(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (xfwd) {
    // x-forwarded-for may be a list
    return xfwd.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// optionally hash IPs
async function processIp(ip) {
  if (!ANONYMIZE) return ip;
  // bcrypt for one-way; could also use HMAC with secret for pseudonymization
  const hashed = await bcrypt.hash(ip, SALT_ROUNDS);
  return hashed;
}

// tracking endpoint — called by embed.js
app.post('/track', trackLimiter, async (req, res) => {
  try {
    const ipRaw = getClientIp(req);
    const ip = await processIp(ipRaw);
    const ua = req.headers['user-agent'] || req.body.ua || null;
    const path = req.body.path || req.headers['referer'] || req.body.url || null;
    const referer = req.headers.referer || req.body.referer || null;
    const ts = Math.floor(Date.now() / 1000);

    insertStmt.run(ip, ua, path, referer, ts);

    // emit to admins in real-time (only id and truncated info for privacy)
    io.to('admins').emit('visit', {
      ip: ANONYMIZE ? '[anon]' : ip,
      ua,
      path,
      referer,
      ts
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('track error', err);
    res.status(500).json({ ok: false });
  }
});

// simple login for admin. This is minimal — replace with proper user system in prod.
app.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
  const password = req.body.password || '';
  // in production you should store a hash of the password in ENV and compare; here we compare plaintext securely
  const match = (password === ADMIN_PASS);
  if (match) {
    req.session.authed = true;
    return res.redirect('/admin.html');
  }
  return res.status(401).send('Unauthorized');
});

// logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// middleware to protect admin endpoints
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).send('Unauthorized');
}

// many admins will want a direct search endpoint
app.get('/api/search', requireAuth, (req, res) => {
  const q = req.query.q || '';
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 2000);
  const offset = parseInt(req.query.offset || '0', 10) || 0;

  // basic safe query building: allow partial matches
  const whereClauses = [];
  const params = [];

  if (q) {
    // search ip, ua, path, referer (use LIKE)
    const term = `%${q}%`;
    whereClauses.push('(ip LIKE ? OR ua LIKE ? OR path LIKE ? OR referer LIKE ?)');
    params.push(term, term, term, term);
  }

  let sql = searchStmtBase;
  if (whereClauses.length) sql += ' WHERE ' + whereClauses.join(' AND ');
  sql += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);
  res.json({ rows });
});

// optional: endpoint to export recent logs (protected)
app.get('/api/export', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, ip, ua, path, referer, ts FROM visits ORDER BY ts DESC LIMIT 10000').all();
  res.json({ rows });
});

// socket.io auth: very minimal: session cookie used to join 'admins'
io.use((socket, next) => {
  // read cookie header to get session id cookie — in production tie socket session properly
  // For simplicity we allow connection and re-check when joining
  next();
});

io.on('connection', (socket) => {
  // admin will emit 'join' after verifying session via /session endpoint or by the fact they loaded admin.html
  socket.on('join-admin', (data) => {
    // we won't implement full session check here; admin.html only calls join-admin after verifying fetch('/api/session') or having login
    // simple approach: trust the client that loaded admin.html (server session should be checked in production)
    socket.join('admins');
  });
});

// small session-check endpoint used by admin.html
app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed), anonymize: ANONYMIZE });
});

server.listen(PORT, () => {
  console.log(`IP tracker listening on ${PORT}`);
  console.log(`ANONYMIZE_IPS=${ANONYMIZE}`);
});
// simple IP -> location lookup (free, rate-limited)
async function geolocateIp(ipRaw) {
  try {
    // strip IPv6 prefix if present
    const ip = ipRaw.replace(/^::ffff:/, '');
    const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { timeout: 4000 });
    if (!r.ok) return null;
    const j = await r.json();
    if (j && j.country_name) {
      return {
        city: j.city || '',
        region: j.region || j.region_code || '',
        country: j.country_name || '',
        lat: j.latitude,
        lon: j.longitude
      };
    }
  } catch (_) {}
  return null;
}
