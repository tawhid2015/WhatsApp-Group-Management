const DEFAULT_SHEET_URL = 'https://script.google.com/macros/s/AKfycbxx1RFPT4dWqYtxd-PR-0lI_yX4xW6DhODyUPk4LCMwVrmcIALcWZeTZXIx_2k7ibK0/exec';

// Safe fetch for write operations — NO retries to avoid duplicate data.
// Apps Script cold-start can take 10-20s, so timeout is longer (30s).
// If it times out we don't know whether the server processed it or not,
// so retrying could create duplicates.
async function writeFetch(url, opts = {}) {
  const response = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Sheets write failed (${response.status})`);
  return response;
}

// Retry fetch with exponential backoff for transient errors
// Handles: Apps Script cold-start 404s, network timeouts, 429 rate limits, 5xx server errors
async function retryFetch(url, opts = {}, retries = 4, baseDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
      if (response.ok) return response;
      const status = response.status;
      lastError = new Error(`Sheets request failed (${status})`);
      // Don't retry on client errors (except 404 cold-start and 429 rate limit)
      if (status !== 404 && status !== 429 && status < 500) throw lastError;
      if (attempt === retries) break;
    } catch (err) {
      lastError = err;
      // Network-level failures (timeout, DNS, reset) — always retry
      if (attempt === retries) break;
    }
    const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
    await new Promise(r => setTimeout(r, delay));
  }
  throw lastError;
}

export class SheetsClient {
  constructor({ baseUrl = process.env.SHEET_API_URL || DEFAULT_SHEET_URL, sheetName = process.env.SHEET_NAME || 'Sheet1' } = {}) {
    this.baseUrl = baseUrl;
    this.sheetName = sheetName;
  }

  async readMembers() {
    const url = new URL(this.baseUrl);
    url.searchParams.set('path', this.sheetName);
    url.searchParams.set('action', 'read');
    const response = await retryFetch(url, { headers: { accept: 'application/json' } });
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Sheets returned an unexpected response');
    return data;
  }

  async addMember({ name, phone, joining, expire }) {
    const url = new URL(this.baseUrl);
    for (const [key, value] of Object.entries({ path: this.sheetName, action: 'write', Name: name, Phone: phone, Joining: joining, Expire: expire })) {
      url.searchParams.set(key, value);
    }
    const response = await writeFetch(url, { headers: { accept: 'application/json' } });
    return response.json().catch(() => ({}));
  }

  async updateMember({ phone, joining, expire }) {
    const url = new URL(this.baseUrl);
    url.searchParams.set('path', this.sheetName);
    url.searchParams.set('action', 'update');
    url.searchParams.set('Phone', phone);
    if (expire !== undefined) url.searchParams.set('Expire', expire);
    if (joining !== undefined) url.searchParams.set('Joining', joining);
    const response = await writeFetch(url, { headers: { accept: 'application/json' } });
    return response.json().catch(() => ({}));
  }

  async updateMemberExpiry(phone, expire = 'Removed') {
    return this.updateMember({ phone, expire });
  }
}

export function formatDhakaDate(date = new Date()) {
  const d = new Date(date.getTime() + 6 * 3600000);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = months[d.getUTCMonth()];
  const day = d.getUTCDate();
  const yr = d.getUTCFullYear();
  let hr = d.getUTCHours();
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = hr >= 12 ? 'PM' : 'AM';
  hr = hr % 12 || 12;
  const strHr = String(hr).padStart(2, '0');
  return `${m} ${day}, ${yr} at ${strHr}:${min} ${ampm}`;
}

export function normalizePhone(value) {
  let phone = String(value ?? '').replace(/[^\d]/g, '').replace(/^00/, '');
  // Keep Bangladesh numbers in one form so 013... and 88013... match.
  if (phone.startsWith('880') && phone.length === 13) phone = `0${phone.slice(3)}`;
  // Google Sheets may coerce a leading-zero Bangladesh number to 10 digits.
  if (phone.length === 10 && phone.startsWith('1')) phone = `0${phone}`;
  return phone;
}

export function isPermanent(value) {
  return String(value ?? '').trim().toLowerCase() === 'permanent';
}

export function isRemoved(value) {
  return String(value ?? '').trim().toLowerCase() === 'removed';
}

function parseSheetLocalDate(value) {
  const text = String(value).trim().replace(/\s+at\s+/i, ' ');
  // Sheet timestamps are Bangladesh local time unless an explicit timezone/offset is supplied.
  const match = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) return new Date(text);
  const [, monthName, day, year, rawHour, minute, rawSecond = '0', meridiem] = match;
  const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(monthName.slice(0, 3).toLowerCase());
  let hour = Number(rawHour) % 12; if (meridiem.toUpperCase() === 'PM') hour += 12;
  // Asia/Dhaka is UTC+06:00; parse the sheet's displayed local wall-clock time correctly.
  return new Date(Date.UTC(Number(year), month, Number(day), hour - 6, Number(minute), Number(rawSecond)));
}

export function parseExpiry(value) {
  if (!value || isPermanent(value) || isRemoved(value)) return null;
  const date = parseSheetLocalDate(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function memberState(member, now = new Date()) {
  if (isPermanent(member.Expire)) return 'PERMANENT';
  if (isRemoved(member.Expire)) return 'REMOVED';
  const expiry = parseExpiry(member.Expire);
  if (expiry === undefined) return 'INVALID_EXPIRY';
  if (expiry === null) return 'NO_EXPIRY';
  return expiry <= now ? 'EXPIRED' : 'ACTIVE';
}
