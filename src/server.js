import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SheetsClient, normalizePhone, memberState, formatDhakaDate } from './sheets.js';
import { WhatsAppManager } from './wa.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const sheets = new SheetsClient();
const activityFile = path.join(process.cwd(), 'data', 'activity.json');
const activity = [];
await fs.mkdir(path.dirname(activityFile), { recursive: true });
try { activity.push(...JSON.parse(await fs.readFile(activityFile, 'utf8'))); } catch {}
async function persistActivity() { await fs.writeFile(activityFile, JSON.stringify(activity.slice(0, 500), null, 2)); }
let membersCache = [];
let lastSync = null;
let lastExpiryCheck = null;
let syncError = null;

// --- DUPLICATE PREVENTION FIX v2 ---
// Track phone numbers currently being processed for addition to prevent race conditions
// when WhatsApp sends multiple join events for the same user in rapid succession.
const pendingAdditions = new Set();
const recentlyAdded = new Map(); // phone -> timestamp (ms)
const ADD_COOLDOWN_MS = 30_000; // 30 seconds: ignore duplicate join events for same phone

// Clean up old entries periodically to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [phone, ts] of recentlyAdded) {
    if (now - ts > ADD_COOLDOWN_MS * 2) recentlyAdded.delete(phone);
  }
}, 60_000);
// --- FIX END ---

const record = event => { activity.unshift({ ...event, at: event.at || new Date().toISOString() }); if (activity.length > 500) activity.pop(); persistActivity().catch(() => {}); };
const wa = new WhatsAppManager({ onEvent: async event => {
  record(event);
  if (event.type === 'join') await handleJoin(event).catch(error => record({ type: 'error', message: error.message }));
} });

async function syncMembers() {
  try { membersCache = await sheets.readMembers(); lastSync = new Date().toISOString(); syncError = null; return membersCache; }
  catch (error) { syncError = error.message; record({ type: 'sheets_error', message: error.message }); throw error; }
}

async function handleJoin({ phone, jid }) {
  if (!phone) return;

  // --- DUPLICATE PREVENTION v2 ---
  // 1) If already processing this phone right now, skip.
  if (pendingAdditions.has(phone)) {
    record({ type: 'pending_add_skipped', phone, jid });
    return;
  }
  // 2) If we successfully added this phone very recently, skip
  //    (catches sequential dupes after the pending lock is released).
  const lastAdd = recentlyAdded.get(phone);
  if (lastAdd && (Date.now() - lastAdd) < ADD_COOLDOWN_MS) {
    record({ type: 'recent_add_skipped', phone, jid, msAgo: Date.now() - lastAdd });
    return;
  }
  // 3) Lock immediately before any async work.
  pendingAdditions.add(phone);
  // --- FIX END ---

  try {
    // Always fetch latest member list from sheet before deciding.
    const members = await syncMembers();
    const existing = members.find(member => normalizePhone(member.Phone) === phone);

    if (existing) {
      const state = memberState(existing);
      if (state === 'REMOVED' || state === 'EXPIRED') {
        const joining = formatDhakaDate(new Date());
        const expire = formatDhakaDate(new Date(Date.now() + 10 * 86400000));
        await sheets.updateMember({ phone, joining, expire });
        record({ type: 'member_rejoined', phone, joining, expire });
        await syncMembers();
        return;
      }
      record({ type: 'duplicate_join', phone, jid });
      return;
    }

    // Genuinely new member — add them.
    const joining = formatDhakaDate(new Date());
    const expire = formatDhakaDate(new Date(Date.now() + 10 * 86400000));
    await sheets.addMember({ name: jid?.split('@')[0] || phone, phone, joining, expire });
    record({ type: 'member_added', phone, joining, expire });
    await syncMembers();

    // --- DUPLICATE PREVENTION v2 ---
    // Remember we just added this phone so fast-sequential dupes are dropped.
    recentlyAdded.set(phone, Date.now());
    // --- FIX END ---
  } catch (error) {
    record({ type: 'add_member_error', phone, message: error.message });
  } finally {
    pendingAdditions.delete(phone);
  }
}

async function expiryCheck() {
  const members = await syncMembers();
  const result = { checked: members.length, expired: 0, removed: 0, skipped: 0, errors: [] };
  for (const member of members) {
    const state = memberState(member);
    if (state !== 'EXPIRED') {
      if (state === 'PERMANENT' || state === 'REMOVED' || state === 'INVALID_EXPIRY' || state === 'NO_EXPIRY') result.skipped++;
      continue;
    }
    result.expired++;
    try {
      const removal = await wa.remove(normalizePhone(member.Phone));
      if (removal?.alreadyAbsent) {
        result.skipped++;
      } else {
        result.removed++;
        record({ type: 'auto_remove', phone: normalizePhone(member.Phone), name: member.Name, expire: member.Expire, result: 'success' });
      }
      // Update Google Sheet Expire column to 'Removed' so future checks skip this row
      await sheets.updateMemberExpiry(normalizePhone(member.Phone), 'Removed').catch(err => {
        record({ type: 'sheets_error', message: `Sheet update to Removed failed for ${member.Phone}: ${err.message}` });
      });
    } catch (error) {
      result.errors.push({ phone: member.Phone, message: error.message });
      record({ type: 'auto_remove', phone: normalizePhone(member.Phone), name: member.Name, expire: member.Expire, result: 'failed', message: error.message });
    }
  }
  lastExpiryCheck = new Date().toISOString(); return result;
}

app.get('/api/wa/status', (_req, res) => res.json(wa.getStatus()));
app.get('/api/wa/groups', async (_req, res) => { try { res.json(await wa.listGroups()); } catch (e) { res.status(409).json({ error: e.message }); } });
app.get('/api/wa/group-members', async (_req, res) => { try { if (!wa.sock || wa.status !== 'CONNECTED') return res.status(409).json({ error: 'WhatsApp is not connected' }); const metadata = await wa.sock.groupMetadata(wa.groupId); res.json({ id: metadata.id, subject: metadata.subject, size: metadata.participants.length, participants: metadata.participants }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/wa/qr.png', async (_req, res) => { const png = await wa.qrPng(); if (!png) return res.status(404).end(); res.type('png').set('Cache-Control', 'no-store').send(png); });
app.post('/api/wa/clear-session', async (_req, res) => { await wa.clearSession(); res.json(wa.getStatus()); });
app.get('/api/members', async (_req, res) => { try { await syncMembers(); res.json(membersCache.map(member => ({ ...member, _state: memberState(member) }))); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get('/api/activity', (_req, res) => res.json(activity));
app.delete('/api/activity', async (_req, res) => {
  activity.length = 0;
  await persistActivity();
  res.json({ success: true, message: 'Activity cleared' });
});
app.get('/api/stats', async (_req, res) => {
  try {
    const members = await syncMembers();
    const states = members.map(m => memberState(m));
    const today = new Date().toISOString().slice(0, 10);
    const todayEvents = activity.filter(e => e.at?.slice(0, 10) === today);
    res.json({
      total: members.length,
      active: states.filter(s => s === 'ACTIVE').length,
      expired: states.filter(s => s === 'EXPIRED').length,
      permanent: states.filter(s => s === 'PERMANENT').length,
      removed: states.filter(s => s === 'REMOVED').length,
      invalid: states.filter(s => ['INVALID_EXPIRY', 'NO_EXPIRY'].includes(s)).length,
      joinedToday: todayEvents.filter(e => ['join', 'member_added'].includes(e.type)).length,
      leftToday: todayEvents.filter(e => e.type === 'leave').length,
      removedToday: todayEvents.filter(e => (e.type === 'manual_remove' && e.result === 'success') || (e.type === 'auto_remove' && e.result === 'success')).length,
      lastSync,
      lastExpiryCheck,
      syncError
    });
  } catch (e) {
    res.status(502).json({ error: e.message, lastSync, syncError });
  }
});
app.post('/api/expiry/check', async (_req, res) => { try { res.json(await expiryCheck()); } catch (e) { res.status(502).json({ error: e.message }); } });
app.post('/api/members/:phone/remove', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  try {
    await wa.remove(phone);
    await sheets.updateMemberExpiry(phone, 'Removed').catch(() => {});
    record({ type: 'manual_remove', phone, result: 'success' });
    res.json({ ok: true });
  } catch (e) {
    record({ type: 'manual_remove', phone, result: 'failed', message: e.message });
    res.status(409).json({ error: e.message });
  }
});

// Health endpoint
app.get('/api/health', (_req, res) => res.json({ status: 'UP', pid: process.pid, uptime: Math.round(process.uptime()), ts: new Date().toISOString() }));

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, async () => { console.log(`WACMS listening on http://localhost:${port}`); wa.start().catch(e => record({ type: 'error', message: e.message })); });

// Keep event loop alive
setInterval(() => {}, 30000);

// Safe recurring expiry check using setTimeout (survives long-blocking callbacks)
function scheduleExpiry() {
  expiryCheck().catch(e => record({ type: 'expiry_error', message: e.message }));
  setTimeout(scheduleExpiry, Number(process.env.EXPIRY_CHECK_MS || 300000));
}
setTimeout(scheduleExpiry, Number(process.env.EXPIRY_CHECK_MS || 300000));

// Crash protection — log error and let run.sh restart us
process.on('uncaughtException', err => { console.error('UNCAUGHT EXCEPTION:', err); record({ type: 'crash', message: err.message }); process.exit(1); });
process.on('unhandledRejection', err => { console.error('UNHANDLED REJECTION:', err); record({ type: 'crash', message: err?.message || 'unhandledRejection' }); });
process.on('SIGTERM', () => { console.log('SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('SIGINT'); server.close(() => process.exit(0)); });
