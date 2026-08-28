import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePhone } from './sheets.js';

export class WhatsAppManager {
  constructor({ authDir = './auth_info', groupId = process.env.MONITORED_GROUP_ID, onEvent = () => {} } = {}) {
    this.authDir = path.resolve(authDir); this.groupId = groupId; this.onEvent = onEvent;
    this.sock = null; this.qr = null; this.status = 'STARTING'; this.retries = 0; this.connecting = false; this.generation = 0;
  }
  async start() { return this.connect(); }
  async connect() {
    if (this.connecting) return; this.connecting = true; const generation = ++this.generation;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));
      const sock = makeWASocket({ version, auth: state, logger: P({ level: 'silent' }), browser: ['WACMS', 'Chrome', '1.0.0'], markOnlineOnConnect: false });
      this.sock = sock; this.status = 'CONNECTING'; this.qr = null;
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', update => this.handleConnection(update, generation));
      sock.ev.on('group-participants.update', update => this.handleParticipants(update));
    } catch (error) {
      this.status = 'ERROR'; this.onEvent({ type: 'error', message: error.message });
      this.connecting = false; this.scheduleReconnect(generation);
    }
  }
  async handleConnection({ connection, lastDisconnect, qr }, generation) {
    if (generation !== this.generation) return;
    if (qr) { this.qr = qr; this.status = 'WAITING_FOR_QR'; this.onEvent({ type: 'qr' }); }
    if (connection === 'open') { this.status = 'CONNECTED'; this.qr = null; this.retries = 0; this.connecting = false; this.onEvent({ type: 'connected' }); }
    if (connection !== 'close') return;
    this.connecting = false;
    const code = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = code === DisconnectReason.loggedOut || code === 401;
    this.status = loggedOut ? 'LOGGED_OUT' : 'DISCONNECTED'; this.onEvent({ type: loggedOut ? 'logout' : 'disconnected', code });
    if (loggedOut) { await fs.rm(this.authDir, { recursive: true, force: true }); this.retries = 0; return this.connect(); }
    this.scheduleReconnect(generation);
  }
  scheduleReconnect(generation) { if (generation !== this.generation || this.retries >= 5) return; this.retries++; this.status = 'RECONNECTING'; setTimeout(() => this.connect(), 5000); }
  async handleParticipants({ id, action, participants }) {
    if (this.groupId && id !== this.groupId) return;
    this.participantJids ||= new Map();
    for (const participant of participants || []) {
      // Baileys v7 can deliver LID objects: { id: '<lid>@lid', phoneNumber: '<phone>@s.whatsapp.net' }.
      const jid = typeof participant === 'string' ? participant : (participant?.phoneNumber || participant?.id || '');
      const phone = normalizePhone(typeof participant === 'object' ? (participant.phoneNumber || participant.id) : participant);
      if (phone && jid && action === 'add') this.participantJids.set(phone, { jid, lid: typeof participant === 'object' ? participant.id : jid });
      this.onEvent({ type: action === 'add' ? 'join' : action === 'remove' ? 'leave' : action, phone, jid, rawParticipant: participant, groupId: id, at: new Date().toISOString() });
    }
  }
  async qrPng() { return this.qr ? QRCode.toBuffer(this.qr, { type: 'png', width: 320, margin: 2 }) : null; }
  getStatus() { return { status: this.status, connected: this.status === 'CONNECTED', groupId: this.groupId || null, retries: this.retries }; }
  async listGroups() {
    if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups).map(group => ({ id: group.id, subject: group.subject, announce: Boolean(group.announce), size: group.size || group.participants?.length || 0, isCommunity: Boolean(group.isCommunity), isCommunityAnnounce: Boolean(group.isCommunityAnnounce) }));
  }
  async clearSession() { this.generation++; this.connecting = false; try { this.sock?.end(undefined); } catch {} await fs.rm(this.authDir, { recursive: true, force: true }); this.status = 'STARTING'; this.qr = null; this.retries = 0; return this.connect(); }
  async remove(phone) {
    if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
    if (!this.groupId) throw new Error('MONITORED_GROUP_ID is not configured');
    const requested = phone.includes('@') ? phone : `${normalizePhone(phone)}@s.whatsapp.net`;
    let mappedLid = null;
    try {
      const mapping = this.sock.signalRepository?.lidMapping;
      if (mapping?.getLIDForPN) mappedLid = await mapping.getLIDForPN(requested);
    } catch {}
    const metadata = await Promise.race([
      this.sock.groupMetadata(this.groupId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp group lookup timed out')), 10000))
    ]);
    const participants = metadata.participants || [];
    const wanted = normalizePhone(phone);
    // Prefer the phone JID discovered from the join event; group metadata may expose only a LID.
    const remembered = this.participantJids?.get(wanted);
    const target = participants.find(member => {
      const candidates = [member.phoneNumber, member.jid, member.id].filter(Boolean);
      return candidates.some(value => normalizePhone(String(value).replace(/@.*$/, '')) === wanted) || (remembered && candidates.includes(remembered.lid));
    });
    // If metadata only exposes a LID, use the phone JID learned from the join event.
    // If neither is known, the member is absent (or was never observed by this process).
    if (!target && !remembered?.jid) return { alreadyAbsent: true };
    const targetJid = target?.jid || target?.id || remembered?.jid || mappedLid || requested;
    await Promise.race([
      this.sock.groupParticipantsUpdate(this.groupId, [targetJid], 'remove'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp removal timed out')), 15000))
    ]);
    return { removed: true, jid: targetJid };
  }
}
