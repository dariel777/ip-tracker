require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'changeme';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'password';
const ANONYMIZE_IPS = process.env.ANONYMIZE_IPS === 'true';

app.set('trust proxy', 1);

// Database setup
const db = new Database('db.sqlite');
db.prepare(`CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  path TEXT,
  ua TEXT,
  ts INTEGER
)`).run();

// Middleware
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Serve static files from public
app.use(express.static(path.join(__dirname, 'public')));

// API to check session status
app.get('/api/session', (req, res) => {
  res.json({ authed: !!req.session.authed });
});

// Login route
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

// Track endpoint
app.post('/track', (req, res) => {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (ip && typeof ip === 'string' && ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }
  if (ANONYMIZE_IPS && ip) {
    ip = ip.replace(/\d+$/, '0');
  }
  const pathReq = req.body.path || '';
  const ua = req.headers['user-agent'] || '';
  const ts = Math.floor(Date.now() / 1000);

  db.prepare(`INSERT INTO hits (ip, path, ua, ts) VALUES (?, ?, ?, ?)`)
    .run(ip, pathReq, ua, ts);

  res.json({ status: 'ok' });
});

// Admin data API
app.get('/api/hits', (req, res) => {
  if (!req.session.authed) return res.status(403).send('Forbidden');
  const rows = db.prepare(`SELECT * FROM hits ORDER BY ts DESC LIMIT 100`).all();
  res.json(rows);
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin.html');
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`IP tracker listening on ${PORT}`);
  console.log(`ANONYMIZE_IPS=${ANONYMIZE_IPS}`);
});
