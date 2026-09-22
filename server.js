const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

const DATA_DIR = process.env.DATA_DIR || '/data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const UPLOADS = path.join(DATA_DIR, 'uploads');
try { fs.mkdirSync(UPLOADS, { recursive: true }); } catch (e) {}
app.use('/uploads', express.static(UPLOADS, { maxAge: '30d' }));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

const F = {
  rsvps: path.join(DATA_DIR, 'rsvps.json'),       // legacy site-demo rsvps
  conf: path.join(DATA_DIR, 'config.json'),       // site settings
  orgs: path.join(DATA_DIR, 'organizers.json'),   // { orgId: {...} }
  tokens: path.join(DATA_DIR, 'tokens.json'),     // { token: orgId }
  events: path.join(DATA_DIR, 'events.json'),     // { eventId: {...} }
  ersvp: path.join(DATA_DIR, 'event_rsvps.json'), // { eventId: { phoneDigits: {...} } }
  album: path.join(DATA_DIR, 'album.json')        // { eventId: [ {url, ts} ] }
};

function readJSON(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; } }
function writeJSON(file, val) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(val)); fs.renameSync(tmp, file); }
let chain = Promise.resolve();
function withLock(fn) { const run = () => Promise.resolve().then(fn); chain = chain.then(run, run); return chain; }

const digits = s => String(s || '').replace(/\D/g, '');
const phoneKey = s => digits(s).slice(-9); // match with/without country code
const genId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const genToken = () => crypto.randomBytes(24).toString('hex');
function genSlug(events) { let s; do { s = crypto.randomBytes(4).toString('hex'); } while (Object.values(events).some(e => e.slug === s)); return s; }
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }

function orgAuth(req, res, next) {
  const tok = req.get('x-org-token');
  const tokens = readJSON(F.tokens, {});
  if (tok && tokens[tok]) { req.orgId = tokens[tok]; return next(); }
  return res.status(401).json({ error: 'unauthorized' });
}
function pubEvent(e) {
  return { id: e.id, slug: e.slug, model: e.model, title: e.title, names: e.names, eyebrow: e.eyebrow,
    sub: e.sub, date: e.date, time: e.time, place: e.place, saveTheDate: !!e.saveTheDate,
    whenISO: e.whenISO || '', mapUrl: e.mapUrl || '', music: e.music || null,
    photo: e.photo || '', coverPhoto: e.coverPhoto || '', fullImage: !!e.fullImage, giftUrl: e.giftUrl || '', dressCode: e.dressCode || '',
    agenda: e.agenda || null, gallery: e.gallery || null, albumUrl: e.albumUrl || '', initials: e.initials || '',
    iban: e.iban || '', ibanLabel: e.ibanLabel || '', presentes: e.presentes || null,
    ft: e.ft, fn: e.fn, pal: e.pal, motif: e.motif, anim: e.anim, frame: e.frame, layout: e.layout };
}
function counts(eventId) {
  const all = readJSON(F.ersvp, {})[eventId] || {};
  const list = Object.values(all);
  const people = list.reduce((s, r) => s + (r.attending ? (1 + (r.guests || 0)) : 0), 0);
  return { total: list.length, going: list.filter(r => r.attending).length, notGoing: list.filter(r => !r.attending).length, people: people };
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'convitta-api', v: 7 }));

// Image upload (organizer) — lets the organizer use their own art (e.g. exported from Canva)
const uploadMw = multer({
  storage: multer.diskStorage({
    destination: (q, f, cb) => cb(null, UPLOADS),
    filename: (q, f, cb) => { const ext = (String(f.originalname).match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0].toLowerCase(); cb(null, genId() + ext); }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (q, f, cb) => cb(null, /^image\//.test(f.mimetype))
});
app.post('/api/upload', orgAuth, uploadMw.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

/* ---------- Legacy site-level (demo) ---------- */
app.get('/api/config', (req, res) => { const c = readJSON(F.conf, {}); res.json({ disabled: c.disabled || [], settings: c.settings || null }); });
function siteAuth(req, res, next) { const pw = req.get('x-admin-password'); if (pw && pw === ADMIN_PASSWORD) return next(); return res.status(401).json({ error: 'unauthorized' }); }
app.post('/api/login', (req, res) => { if ((req.body || {}).password === ADMIN_PASSWORD) return res.json({ ok: true }); return res.status(401).json({ error: 'bad' }); });
app.put('/api/config', siteAuth, async (req, res) => {
  const b = req.body || {};
  await withLock(() => { const c = readJSON(F.conf, {});
    if (Array.isArray(b.disabled)) c.disabled = b.disabled.filter(n => Number.isInteger(n)).slice(0, 2000);
    if (b.settings && typeof b.settings === 'object') c.settings = {
      name: String(b.settings.name || '').slice(0, 60), tagline: String(b.settings.tagline || '').slice(0, 400),
      accent: /^#[0-9a-fA-F]{6}$/.test(b.settings.accent) ? b.settings.accent : '#6E2A52' };
    writeJSON(F.conf, c); });
  res.json({ ok: true });
});

/* ---------- Admin: full management (see everything, edit, reset passwords) ---------- */
app.get('/api/admin/overview', siteAuth, (req, res) => {
  const orgs = readJSON(F.orgs, {});
  const events = Object.values(readJSON(F.events, {}));
  const er = readJSON(F.ersvp, {});
  const orgList = Object.values(orgs).map(o => ({
    id: o.id, name: o.name, phone: o.phone, createdAt: o.createdAt,
    eventCount: events.filter(e => e.orgId === o.id).length
  })).sort((a, b) => b.createdAt - a.createdAt);
  const evList = events.sort((a, b) => b.createdAt - a.createdAt).map(e => {
    const all = er[e.id] || {};
    const rsvps = Object.values(all).sort((a, b) => b.ts - a.ts);
    const org = orgs[e.orgId];
    return Object.assign(pubEvent(e), {
      orgId: e.orgId, orgName: org ? org.name : '—', orgPhone: org ? org.phone : '',
      createdAt: e.createdAt, counts: counts(e.id), rsvps: rsvps
    });
  });
  const going = evList.reduce((s, e) => s + e.counts.going, 0);
  const responses = evList.reduce((s, e) => s + e.counts.total, 0);
  res.json({ organizers: orgList, events: evList, totals: { events: evList.length, going, responses, organizers: orgList.length } });
});
app.post('/api/admin/reset-password', siteAuth, async (req, res) => {
  const b = req.body || {};
  const pw = String(b.password || '');
  if (pw.length < 4) return res.status(400).json({ error: 'weak_password' });
  let ok = false;
  await withLock(() => {
    const orgs = readJSON(F.orgs, {});
    const org = orgs[b.orgId];
    if (org) { org.salt = crypto.randomBytes(8).toString('hex'); org.hash = hashPw(pw, org.salt); writeJSON(F.orgs, orgs); ok = true; }
  });
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});
const EDITABLE = ['title','names','eyebrow','sub','date','time','place','whenISO','mapUrl','dressCode','giftUrl','initials','albumUrl','iban','ibanLabel'];
app.put('/api/admin/events/:id', siteAuth, async (req, res) => {
  const b = req.body || {};
  let out;
  await withLock(() => {
    const events = readJSON(F.events, {});
    const e = events[req.params.id];
    if (!e) { out = { err: 'not_found' }; return; }
    EDITABLE.forEach(k => { if (typeof b[k] === 'string') e[k] = b[k].slice(0, 500); });
    writeJSON(F.events, events);
    out = { event: pubEvent(e) };
  });
  if (out.err) return res.status(404).json({ error: out.err });
  res.json(out);
});
app.delete('/api/admin/events/:id', siteAuth, async (req, res) => {
  await withLock(() => {
    const events = readJSON(F.events, {});
    if (events[req.params.id]) { delete events[req.params.id]; writeJSON(F.events, events);
      const er = readJSON(F.ersvp, {}); delete er[req.params.id]; writeJSON(F.ersvp, er); }
  });
  res.json({ ok: true });
});

/* ---------- Organizer accounts ---------- */
app.post('/api/org/register', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const phone = String(b.phone || '').trim().slice(0, 40);
  const pw = String(b.password || '');
  if (!name || digits(phone).length < 9 || pw.length < 4) return res.status(400).json({ error: 'invalid' });
  let out;
  await withLock(() => {
    const orgs = readJSON(F.orgs, {});
    if (Object.values(orgs).some(o => phoneKey(o.phone) === phoneKey(phone))) { out = { err: 'phone_taken' }; return; }
    const id = genId(), salt = crypto.randomBytes(8).toString('hex');
    orgs[id] = { id, name, phone, salt, hash: hashPw(pw, salt), createdAt: Date.now() };
    writeJSON(F.orgs, orgs);
    const tokens = readJSON(F.tokens, {}); const token = genToken(); tokens[token] = id; writeJSON(F.tokens, tokens);
    out = { token, org: { id, name, phone } };
  });
  if (out.err === 'phone_taken') return res.status(409).json({ error: 'phone_taken' });
  res.json(out);
});
app.post('/api/org/login', (req, res) => {
  const b = req.body || {};
  const orgs = readJSON(F.orgs, {});
  const org = Object.values(orgs).find(o => phoneKey(o.phone) === phoneKey(b.phone));
  if (!org || org.hash !== hashPw(String(b.password || ''), org.salt)) return res.status(401).json({ error: 'bad_credentials' });
  const tokens = readJSON(F.tokens, {}); const token = genToken(); tokens[token] = org.id; writeJSON(F.tokens, tokens);
  res.json({ token, org: { id: org.id, name: org.name, phone: org.phone } });
});
app.get('/api/org/me', orgAuth, (req, res) => {
  const org = readJSON(F.orgs, {})[req.orgId];
  if (!org) return res.status(401).json({ error: 'unauthorized' });
  res.json({ org: { id: org.id, name: org.name, phone: org.phone } });
});

/* ---------- Events ---------- */
app.post('/api/events', orgAuth, async (req, res) => {
  const b = req.body || {};
  let out;
  await withLock(() => {
    const events = readJSON(F.events, {});
    const id = genId(), slug = genSlug(events);
    events[id] = { id, orgId: req.orgId, slug, createdAt: Date.now(),
      model: (b.model == null ? null : Number(b.model)),
      title: String(b.title || '').slice(0, 120),
      names: String(b.names || '').slice(0, 120),
      eyebrow: String(b.eyebrow || '').slice(0, 80),
      sub: String(b.sub || '').slice(0, 200),
      date: String(b.date || '').slice(0, 40),
      time: String(b.time || '').slice(0, 20),
      place: String(b.place || '').slice(0, 120),
      whenISO: String(b.whenISO || '').slice(0, 40),
      mapUrl: String(b.mapUrl || '').slice(0, 300),
      photo: String(b.photo || '').slice(0, 500),
      coverPhoto: String(b.coverPhoto || '').slice(0, 500),
      fullImage: !!b.fullImage,
      giftUrl: String(b.giftUrl || '').slice(0, 400),
      dressCode: String(b.dressCode || '').slice(0, 120),
      agenda: Array.isArray(b.agenda) ? b.agenda.slice(0, 8).map(a => ({ t: String(a.t||'').slice(0,20), l: String(a.l||'').slice(0,60) })) : null,
      gallery: Array.isArray(b.gallery) ? b.gallery.slice(0, 12).map(u => String(u||'').slice(0, 500)).filter(Boolean) : null,
      iban: String(b.iban || '').slice(0, 60),
      ibanLabel: String(b.ibanLabel || '').slice(0, 80),
      presentes: Array.isArray(b.presentes) ? b.presentes.slice(0, 8).map(g => ({ em: String(g.em||'🎁').slice(0,4), t: String(g.t||'').slice(0,60), d: String(g.d||'').slice(0,120) })) : null,
      albumUrl: String(b.albumUrl || '').slice(0, 400),
      initials: String(b.initials || '').slice(0, 12),
      music: (b.music && typeof b.music === 'object') ? { id: String(b.music.id||'').slice(0,40), name: String(b.music.name||'').slice(0,80), url: String(b.music.url||'').slice(0,400) } : null,
      saveTheDate: !!b.saveTheDate,
      ft: String(b.ft || '').slice(0, 60), fn: String(b.fn || '').slice(0, 60),
      motif: String(b.motif || '').slice(0, 30), anim: String(b.anim || '').slice(0, 20),
      frame: String(b.frame || '').slice(0, 20), layout: String(b.layout || '').slice(0, 20),
      pal: (b.pal && typeof b.pal === 'object') ? b.pal : null };
    writeJSON(F.events, events);
    out = events[id];
  });
  res.json({ event: pubEvent(out), slug: out.slug });
});
app.get('/api/events', orgAuth, (req, res) => {
  const events = readJSON(F.events, {});
  const mine = Object.values(events).filter(e => e.orgId === req.orgId).sort((a, b) => b.createdAt - a.createdAt);
  res.json(mine.map(e => Object.assign(pubEvent(e), { counts: counts(e.id), createdAt: e.createdAt })));
});
app.get('/api/events/:id', orgAuth, (req, res) => {
  const e = readJSON(F.events, {})[req.params.id];
  if (!e || e.orgId !== req.orgId) return res.status(404).json({ error: 'not_found' });
  const all = readJSON(F.ersvp, {})[e.id] || {};
  const rsvps = Object.values(all).sort((a, b) => b.ts - a.ts);
  res.json({ event: pubEvent(e), rsvps: rsvps, counts: counts(e.id) });
});
app.delete('/api/events/:id', orgAuth, async (req, res) => {
  await withLock(() => {
    const events = readJSON(F.events, {});
    if (events[req.params.id] && events[req.params.id].orgId === req.orgId) {
      delete events[req.params.id]; writeJSON(F.events, events);
      const er = readJSON(F.ersvp, {}); delete er[req.params.id]; writeJSON(F.ersvp, er);
    }
  });
  res.json({ ok: true });
});

/* ---------- Public event page + RSVP ---------- */
app.get('/api/public/event/:slug', (req, res) => {
  const e = Object.values(readJSON(F.events, {})).find(x => x.slug === req.params.slug);
  if (!e) return res.status(404).json({ error: 'not_found' });
  res.json({ event: pubEvent(e) });
});
app.post('/api/public/event/:slug/rsvp', async (req, res) => {
  const b = req.body || {};
  const d = digits(b.phone);
  if (!/^\d{9,15}$/.test(d)) return res.status(400).json({ error: 'phone' });
  let out;
  await withLock(() => {
    const e = Object.values(readJSON(F.events, {})).find(x => x.slug === req.params.slug);
    if (!e) { out = { err: 'not_found' }; return; }
    const er = readJSON(F.ersvp, {}); er[e.id] = er[e.id] || {};
    const k = phoneKey(b.phone);
    const ref = 'CV-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const existing = er[e.id][k];
    er[e.id][k] = { name: String(b.name || '').slice(0, 120), phone: String(b.phone || '').slice(0, 40),
      attending: !!b.attending, guests: Math.max(0, Math.min(20, parseInt(b.guests) || 0)),
      message: String(b.message || '').slice(0, 300), ts: Date.now(), ref: existing ? existing.ref : ref };
    writeJSON(F.ersvp, er);
    out = { ref: er[e.id][k].ref, updated: !!existing };
  });
  if (out.err) return res.status(404).json({ error: out.err });
  res.json({ ok: true, ref: out.ref, updated: out.updated });
});

/* ---------- Shared album: guests upload photos of the party (public, no login) ---------- */
const albumUpload = multer({
  storage: multer.diskStorage({
    destination: (q, f, cb) => cb(null, UPLOADS),
    filename: (q, f, cb) => { const ext = (String(f.originalname).match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0].toLowerCase(); cb(null, genId() + ext); }
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (q, f, cb) => cb(null, /^image\//.test(f.mimetype))
});
app.get('/api/public/event/:slug/album', (req, res) => {
  const e = Object.values(readJSON(F.events, {})).find(x => x.slug === req.params.slug);
  if (!e) return res.status(404).json({ error: 'not_found' });
  res.json({ photos: (readJSON(F.album, {})[e.id] || []) });
});
app.post('/api/public/event/:slug/album', albumUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  let out;
  await withLock(() => {
    const e = Object.values(readJSON(F.events, {})).find(x => x.slug === req.params.slug);
    if (!e) { out = { err: 'not_found' }; return; }
    const a = readJSON(F.album, {}); a[e.id] = a[e.id] || [];
    if (a[e.id].length >= 400) { out = { err: 'full' }; return; }
    const entry = { url: '/uploads/' + req.file.filename, by: String((req.body || {}).by || '').slice(0, 60), ts: Date.now() };
    a[e.id].unshift(entry); writeJSON(F.album, a);
    out = { photo: entry };
  });
  if (out.err === 'not_found') return res.status(404).json({ error: 'not_found' });
  if (out.err === 'full') return res.status(413).json({ error: 'album_full' });
  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Convitta API v2 on ' + PORT));
