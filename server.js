const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '120kb' }));

const DATA_DIR = process.env.DATA_DIR || '/data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
const RSVP_FILE = path.join(DATA_DIR, 'rsvps.json');
const CONF_FILE = path.join(DATA_DIR, 'config.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}
function writeJSON(file, val) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(val, null, 2));
  fs.renameSync(tmp, file);
}

// Serialize writes to avoid read-modify-write races.
let chain = Promise.resolve();
function withLock(fn) {
  const run = () => Promise.resolve().then(fn);
  chain = chain.then(run, run);
  return chain;
}

function auth(req, res, next) {
  const pw = req.get('x-admin-password');
  if (pw && pw === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'convitta-api' }));

// Public: current site config (disabled models + site settings)
app.get('/api/config', (req, res) => {
  const c = readJSON(CONF_FILE, {});
  res.json({ disabled: c.disabled || [], settings: c.settings || null });
});

// Public: submit an RSVP
app.post('/api/rsvp', async (req, res) => {
  const b = req.body || {};
  const digits = String(b.phone || '').replace(/\D/g, '');
  if (!/^\d{9,15}$/.test(digits)) return res.status(400).json({ error: 'phone' });
  const rec = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    name: String(b.name || '').slice(0, 120),
    phone: String(b.phone || '').slice(0, 40),
    attending: !!b.attending,
    model: String(b.model || '').slice(0, 80),
    cat: String(b.cat || '').slice(0, 40),
    ref: 'CV-' + Math.random().toString(36).slice(2, 7).toUpperCase()
  };
  await withLock(() => {
    const all = readJSON(RSVP_FILE, []);
    all.push(rec);
    writeJSON(RSVP_FILE, all);
  });
  res.json({ ok: true, ref: rec.ref });
});

// Admin: login check
app.post('/api/login', (req, res) => {
  if ((req.body || {}).password === ADMIN_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ error: 'bad' });
});

// Admin: list / clear RSVPs
app.get('/api/rsvps', auth, (req, res) => res.json(readJSON(RSVP_FILE, [])));
app.delete('/api/rsvps', auth, async (req, res) => {
  await withLock(() => writeJSON(RSVP_FILE, []));
  res.json({ ok: true });
});

// Admin: update config (disabled models + settings) — global for all visitors
app.put('/api/config', auth, async (req, res) => {
  const b = req.body || {};
  await withLock(() => {
    const c = readJSON(CONF_FILE, {});
    if (Array.isArray(b.disabled)) c.disabled = b.disabled.filter(n => Number.isInteger(n)).slice(0, 500);
    if (b.settings && typeof b.settings === 'object') {
      c.settings = {
        name: String(b.settings.name || '').slice(0, 60),
        tagline: String(b.settings.tagline || '').slice(0, 400),
        accent: /^#[0-9a-fA-F]{6}$/.test(b.settings.accent) ? b.settings.accent : '#6E2A52'
      };
    }
    writeJSON(CONF_FILE, c);
  });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Convitta API listening on ' + PORT));
