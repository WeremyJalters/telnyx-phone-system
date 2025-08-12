// server.js
// Water Damage Lead System — durable bridging, Spaces mirroring, Zapier, AssemblyAI transcripts
// Reflowed for clarity; preserves previous behavior.

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ------------------------------- Paths / App ---------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------ Feature Flags --------------------------------
const USE_RECORDED_PROMPTS = String(process.env.USE_RECORDED_PROMPTS || 'false').toLowerCase() === 'true';
const GREETING_AUDIO_URL = process.env.GREETING_AUDIO_URL || '';
const MENU_AUDIO_URL = process.env.MENU_AUDIO_URL || '';
const HUMAN_GREETING_AUDIO_URL = process.env.HUMAN_GREETING_AUDIO_URL || '';
const HUMAN_BRIDGE_GREETING_MS = Number(process.env.HUMAN_BRIDGE_GREETING_MS || 3000); // staff greeting before bridge

// --------------------------- Telnyx / Routing --------------------------------
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER || '';
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || '2755388541746808609';
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').trim();
const HUMAN_PHONE_NUMBER = process.env.HUMAN_PHONE_NUMBER || '';

function telnyxHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${TELNYX_API_KEY}`
  };
}

// ----------------------- DigitalOcean Spaces (S3) -----------------------------
const SPACES_KEY = process.env.SPACES_KEY || '';
const SPACES_SECRET = process.env.SPACES_SECRET || '';
const SPACES_REGION = process.env.SPACES_REGION || 'nyc3';
const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com';
const SPACES_BUCKET = process.env.SPACES_BUCKET || '';
const SPACES_CDN_BASE = (process.env.SPACES_CDN_BASE || '').trim();

const S3 = new S3Client({
  region: SPACES_REGION,
  endpoint: `https://${SPACES_ENDPOINT}`,
  forcePathStyle: false,
  credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET }
});

// ------------------------------- AssemblyAI ----------------------------------
const AAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || process.env.ASSEMBLYAI_API_KEY || '';
// Optional: secret to verify webhooks (Bearer or HMAC)
const AAI_WEBHOOK_SECRET = process.env.ASSEMBLYAI_WEBHOOK_SECRET || '';

function aaiEnabled() {
  return !!AAI_API_KEY;
}

// --------------------------- Database (SQLite) --------------------------------
class DatabaseQueue {
  constructor() { this.q = []; this.processing = false; }
  execute(op) { return new Promise((resolve, reject) => { this.q.push({ op, resolve, reject }); this._run(); }); }
  async _run() {
    if (this.processing) return;
    this.processing = true;
    while (this.q.length) {
      const { op, resolve, reject } = this.q.shift();
      try { resolve(await op()); } catch (e) { reject(e); }
    }
    this.processing = false;
    if (this.q.length) this._run();
  }
}
const dbQueue = new DatabaseQueue();
const dbPath = process.env.DATABASE_PATH || join(__dirname, 'call_records.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) console.error('Error opening database:', err);
  else console.log('Connected to SQLite at:', dbPath);
});

db.serialize(() => {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = FULL;');
  db.exec('PRAGMA cache_size = 1000;');
  db.exec('PRAGMA temp_store = memory;');
  db.exec('PRAGMA busy_timeout = 30000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA locking_mode = EXCLUSIVE;');
  console.log('Database PRAGMA settings applied');
});

const dbRun = (sql, params = []) =>
  dbQueue.execute(() => new Promise((res, rej) => {
    db.run(sql, params, function (err) { err ? rej(err) : res({ changes: this.changes, lastID: this.lastID }); });
  }));
const dbAll = (sql, params = []) =>
  dbQueue.execute(() => new Promise((res, rej) => {
    db.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
  }));
const dbGet = (sql, params = []) =>
  dbQueue.execute(() => new Promise((res, rej) => {
    db.get(sql, params, (err, row) => err ? rej(err) : res(row));
  }));

async function initDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT UNIQUE,
      direction TEXT,
      from_number TEXT,
      to_number TEXT,
      status TEXT,
      start_time DATETIME,
      end_time DATETIME,
      duration INTEGER,
      recording_url TEXT,
      transcript TEXT,
      transcript_url TEXT,
      call_type TEXT,
      customer_info TEXT,
      contractor_info TEXT,
      notes TEXT,
      customer_zip_code TEXT,
      customer_name TEXT,
      lead_quality TEXT,
      zapier_sent BOOLEAN DEFAULT FALSE,
      zapier_sent_at DATETIME,
      pending_human_call_id TEXT,
      linked_customer_call_id TEXT,
      human_dial_started_at DATETIME,
      human_answered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_calls_call_id ON calls(call_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_calls_pending_human ON calls(pending_human_call_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_calls_linked_customer ON calls(linked_customer_call_id)`);
  const count = await dbGet('SELECT COUNT(*) as count FROM calls');
  console.log('Existing calls in DB:', count?.count || 0);
}

// upsert helpers
async function upsertCall(obj) {
  const cols = Object.keys(obj);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter(c => c !== 'call_id').map(c => `${c}=COALESCE(excluded.${c}, ${c})`).join(', ');
  const sql = `INSERT INTO calls (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(call_id) DO UPDATE SET ${updates}`;
  return dbRun(sql, cols.map(c => obj[c]));
}
async function upsertFields(call_id, fields) { return upsertCall({ call_id, ...fields }); }

// ------------------------------- Utilities -----------------------------------
function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }
function b64(json) { return Buffer.from(JSON.stringify(json), 'utf8').toString('base64'); }
function parseB64(s) { try { return JSON.parse(Buffer.from(s || '', 'base64').toString('utf8')); } catch { return null; } }
function safeKeySegment(s) { return String(s || '').replace(/[^\w\-.:]/g, '_'); }

// ------------------------- Telnyx Call Helpers --------------------------------
async function playbackAudio(callId, audioUrl) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
    method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ audio_url: audioUrl })
  });
  if (!r.ok) console.error('playback_start failed:', await r.text());
}

async function speakToCall(callId, message) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
    method: 'POST', headers: telnyxHeaders(),
    body: JSON.stringify({ payload: message, voice: 'female', language: 'en-US' })
  });
  if (!r.ok) console.error('speak failed:', await r.text());
}

async function gatherUsingSpeak(callId, payload, { min = 1, max = 1, timeoutMs = 12000, term = '#' } = {}) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_speak`, {
    method: 'POST', headers: telnyxHeaders(),
    body: JSON.stringify({
      payload, voice: 'female', language: 'en-US',
      minimum_digits: min, maximum_digits: max, timeout_millis: timeoutMs, terminating_digit: term
    })
  });
  if (!r.ok) console.error(`gather_using_speak failed:`, await r.text());
}

async function gatherUsingAudio(callId, audioUrl, { min = 1, max = 1, timeoutMs = 12000, term = '#' } = {}) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_audio`, {
    method: 'POST', headers: telnyxHeaders(),
    body: JSON.stringify({ audio_url: audioUrl, minimum_digits: min, maximum_digits: max, timeout_millis: timeoutMs, terminating_digit: term })
  });
  if (!r.ok) console.error('gather_using_audio failed:', await r.text());
}

async function playIVRMenu(callId) {
  if (USE_RECORDED_PROMPTS && MENU_AUDIO_URL) {
    await gatherUsingAudio(callId, MENU_AUDIO_URL, { min: 1, max: 1, timeoutMs: 12000, term: '#' });
  } else {
    const menuText = "Thanks for calling our flood and water damage restoration team. " +
      "Press 1 to be connected to a representative now. " +
      "Press 2 to leave details and we'll call you back. " +
      "You can also press 0 to reach a representative.";
    await gatherUsingSpeak(callId, menuText, { min: 1, max: 1, timeoutMs: 12000, term: '#' });
  }
}

async function answerAndIntro(callId) {
  try {
    const answer = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({})
    });
    if (!answer.ok) { console.error('Failed to answer:', await answer.text()); return; }

    // Start recording (dual channels so agents/callers separated)
    await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/record_start`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ format: 'mp3', channels: 'dual' })
    }).catch((e) => console.error('record_start failed:', e));

    if (USE_RECORDED_PROMPTS && GREETING_AUDIO_URL) {
      await playbackAudio(callId, GREETING_AUDIO_URL);
      await waitMs(400);
    }
    await playIVRMenu(callId);
  } catch (e) {
    console.error('answerAndIntro error:', e);
  }
}

// ---------------------- Spaces: mirror Telnyx recording ----------------------
async function mirrorRecordingToSpaces(call_id, telnyxUrl) {
  if (!SPACES_BUCKET || !SPACES_CDN_BASE) return telnyxUrl;
  try {
    const resp = await fetch(telnyxUrl);
    if (!resp.ok) throw new Error(`download ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const key = `recordings/${safeKeySegment(call_id)}.mp3`;
    await S3.send(new PutObjectCommand({
      Bucket: SPACES_BUCKET,
      Key: key,
      Body: buf,
      ContentType: 'audio/mpeg',
      ACL: 'public-read',
      CacheControl: 'public, max-age=31536000, immutable'
    }));
    return `${SPACES_CDN_BASE.replace(/\/+$/,'')}/${key}`;
  } catch (e) {
    console.error('mirrorRecordingToSpaces error:', e);
    return telnyxUrl;
  }
}

// ---------------------- AssemblyAI: store transcript -------------------------
async function storeTranscript(call_id, transcriptId, transcriptText) {
  // Minimal Spaces upload: just a tiny .txt so Airtable has a link
  let transcriptUrl = null;
  try {
    if (SPACES_BUCKET && SPACES_CDN_BASE) {
      const key = `transcripts/${safeKeySegment(call_id)}.txt`;
      await S3.send(new PutObjectCommand({
        Bucket: SPACES_BUCKET,
        Key: key,
        Body: Buffer.from(transcriptText || '', 'utf8'),
        ContentType: 'text/plain; charset=utf-8',
        ACL: 'public-read',
        CacheControl: 'public, max-age=31536000'
      }));
      transcriptUrl = `${SPACES_CDN_BASE.replace(/\/+$/, '')}/${key}`;
    }
  } catch (e) {
    console.error('Spaces transcript upload failed:', e);
  }

  await upsertFields(call_id, {
    transcript: transcriptText || '',
    transcript_url: transcriptUrl || null,
    notes: transcriptId ? `AssemblyAI transcript ${transcriptId}` : null
  });

  // done — Zapier will be sent based on recording handler; Airtable gets " Transcript URL" (below)
}

// Optional HMAC verification (AAI-Signature). If the service uses a different scheme,
// we also accept a simple Bearer secret.
function verifyAAISignature(rawBody, signatureHeader, secret) {
  if (!rawBody || !signatureHeader || !secret) return false;
  try {
    // Attempt "t=...,v1=..." style (Stripe-like) if present
    const map = {};
    signatureHeader.split(',').forEach(p => { const [k, v] = p.split('='); if (k && v) map[k.trim()] = v.trim(); });
    const payload = map.t ? `${map.t}.${rawBody}` : rawBody;
    const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    const provided = map.v1 || signatureHeader;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

// Polling fallback if webhook not accepted
async function pollAAIUntilDone(transcriptId, call_id) {
  for (let i = 0; i < 60; i++) {
    await waitMs(5000);
    try {
      const r = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}`, {
        headers: { 'Authorization': AAI_API_KEY }
      });
      const j = await r.json();
      if (j.status === 'completed') {
        let text = j.text || '';
        if ((!text || text.trim().length < 5) && Array.isArray(j.utterances)) {
          text = j.utterances.map(u => {
            const sp = (typeof u.speaker === 'number') ? `Speaker ${u.speaker}` : (u.speaker || 'Speaker');
            return `${sp}: ${u.text || ''}`;
          }).join('\n');
        }
        await storeTranscript(call_id, transcriptId, text);
        console.log('✅ AAI transcript stored (poll) for', call_id);
        return;
      }
      if (j.status === 'error') {
        console.error('AAI polling error:', j.error);
        await upsertFields(call_id, { notes: `AAI error: ${j.error || 'unknown'}` });
        return;
      }
    } catch (e) {
      console.error('AAI poll exception:', e);
    }
  }
}

// Robust create that tries both endpoint forms and falls back to polling if webhook rejected
async function createAAIJob(call_id, audioUrl) {
  if (!aaiEnabled() || !audioUrl) return null;

  // Build webhook URL (https only). If anything looks off, we simply don't set it and we'll poll.
  let webhookUrl = null;
  try {
    if (WEBHOOK_BASE_URL) {
      const u = new URL(WEBHOOK_BASE_URL);
      if (u.protocol === 'https:') {
        u.pathname = (u.pathname.replace(/\/+$/, '') + '/webhooks/assembly').replace(/\/{2,}/g, '/');
        u.searchParams.set('call_id', safeKeySegment(call_id));
        webhookUrl = u.toString();
      } else {
        console.warn(`AAI: WEBHOOK_BASE_URL must be https:// (got ${u.protocol}) — falling back to polling`);
      }
    }
  } catch (e) {
    console.warn('AAI: invalid WEBHOOK_BASE_URL — falling back to polling:', e?.message);
  }

  const baseBody = {
    audio_url: audioUrl,
    metadata: JSON.stringify({ call_id })
  };

  if (webhookUrl) baseBody.webhook_url = webhookUrl;
  if (AAI_WEBHOOK_SECRET) {
    baseBody.webhook_auth_header_name = 'Authorization';
    baseBody.webhook_auth_header_value = `Bearer ${AAI_WEBHOOK_SECRET}`;
  }

  // Try multiple endpoint spellings; some accounts still accept /transcripts
  const endpoints = [
    'https://api.assemblyai.com/v2/transcript',
    'https://api.assemblyai.com/v2/transcripts'
  ];

  const postJson = async (endpoint, body, label) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': AAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* keep raw text for logging */ }
    return { ok: r.ok, status: r.status, json: j, raw: text, endpoint, label };
  };

  console.log('AAI: creating transcript job for', call_id);
  for (const ep of endpoints) {
    // 1) try with webhook (if we built one)
    if (webhookUrl) {
      const res1 = await postJson(ep, baseBody, 'with-webhook');
      if (res1.ok && res1.json?.id) {
        console.log(`AAI create OK at ${ep} (webhook), id=${res1.json.id}`);
        return res1.json.id; // webhook will deliver transcript
      }
      const msg = (res1.json?.error || res1.json?.message || res1.raw || '').toString();
      if (/endpoint|schema|webhook/i.test(msg)) {
        console.warn(`AAI: ${ep} rejected webhook_url; will retry without webhook and poll…`);
      } else if (res1.status === 401) {
        console.error('AAI 401 Unauthorized. Check ASSEMBLYAI_API_KEY value.');
        console.error('AAI RESP:', { status: res1.status, body: res1.raw });
        return null;
      } else {
        console.warn('AAI create (webhook) failed:', { endpoint: ep, status: res1.status, body: res1.raw });
      }
    }

    // 2) try without webhook (always poll on success)
    const bodyNoHook = { ...baseBody };
    delete bodyNoHook.webhook_url;
    delete bodyNoHook.webhook_auth_header_name;
    delete bodyNoHook.webhook_auth_header_value;

    const res2 = await postJson(ep, bodyNoHook, 'no-webhook');
    if (res2.ok && res2.json?.id) {
      console.log(`AAI create OK at ${ep} (no webhook), id=${res2.json.id} — polling until done`);
      pollAAIUntilDone(res2.json.id, call_id).catch(() => {});
      return res2.json.id;
    }

    if (res2.status === 401) {
      console.error('AAI 401 Unauthorized. Check ASSEMBLYAI_API_KEY value.');
      console.error('AAI RESP:', { status: res2.status, body: res2.raw });
      return null;
    }

    // some clusters send 404/405 when a specific path form is wrong; loop will try next ep
    if (res2.status === 404 || res2.status === 405) {
      console.warn(`AAI: ${ep} returned ${res2.status}; trying next endpoint form…`);
      continue;
    }

    console.error('AAI create failed:', { endpoint: ep, status: res2.status, body: res2.raw, sent: bodyNoHook });
  }

  console.error('AAI: all create attempts failed for call', call_id);
  return null;
}


// ----------------------------- State (Timers) --------------------------------
const humanTimeouts = new Map(); // key: customerCallId -> timeoutId
const pendingBridges = new Map(); // key: humanCallId -> { customerCallId, readyToBridge }

function clearHumanTimeout(customerCallId) {
  const t = humanTimeouts.get(customerCallId);
  if (t) { clearTimeout(t); humanTimeouts.delete(customerCallId); }
}

// ------------------------------- Webhooks ------------------------------------
app.use(express.json()); // for Telnyx JSON

app.post('/webhooks/calls', async (req, res) => {
  const { data } = req.body || {};
  const event = data?.event_type;
  const callId = data?.payload?.call_control_id || data?.call_control_id;
  const clientState = parseB64(data?.payload?.client_state || data?.client_state);

  if (event && callId) {
    console.log(`🌐 WEBHOOK: ${event} | CallID: ${callId}`);
    if (clientState) console.log(`🌐 CLIENT_STATE:`, JSON.stringify(clientState, null, 2));
  }

  try {
    switch (event) {
      case 'call.initiated': await onCallInitiated(data, clientState); break;
      case 'call.answered': await onCallAnswered(data, clientState); break;
      case 'call.hangup': await onCallHangup(data, clientState); break;
      case 'call.recording.saved': await onRecordingSaved(data, clientState); break;
      case 'call.dtmf.received': await onDTMF(data); break;
      case 'call.bridged':
        console.log(`🌉 TELNYX CONFIRMS BRIDGE for: ${callId}`);
        break;
      case 'call.speak.ended': await onSpeakEnded(data, clientState); break;
      case 'call.speak.started': break;
      case 'call.gather.ended': break;
      default: if (event) console.log(`❓ UNHANDLED EVENT: ${event} for ${callId}`);
    }
  } catch (e) {
    console.error(`WEBHOOK ERROR processing ${event} for ${callId}:`, e);
  }

  res.status(200).send('OK');
});

// AssemblyAI webhook: accept raw body (for HMAC) and tolerate empty/probes
app.post('/webhooks/assembly', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const rawBody = rawBuf.toString('utf8');
    const len = rawBuf.length;

    const signatureHeader = req.get('AAI-Signature') || '';
    const authHeader = req.get('Authorization') || '';

    if (AAI_WEBHOOK_SECRET) {
      const hmacOK = verifyAAISignature(rawBody, signatureHeader, AAI_WEBHOOK_SECRET);
      const bearerOK = authHeader === `Bearer ${AAI_WEBHOOK_SECRET}`;
      if (!hmacOK && !bearerOK) return res.status(401).send('unauthorized');
    }

    let evt = {};
    try { evt = rawBody ? JSON.parse(rawBody) : {}; } catch { evt = {}; }

    const transcriptId = evt?.id || evt?.transcript_id || null;
    const status = evt?.status || null;

    // Prefer metadata call_id; webhook query param is just a safety net
    let call_id = null;
    try { call_id = evt?.metadata ? JSON.parse(evt.metadata)?.call_id || null : null; } catch {}

    if (!call_id) {
      try {
        const urlCallId = new URL(req.originalUrl, WEBHOOK_BASE_URL || 'https://dummy.local').searchParams.get('call_id');
        if (urlCallId) call_id = urlCallId;
      } catch {}
    }

    console.log('🎧 AAI Webhook:', { len, transcriptId, status, hasMetadata: !!evt?.metadata, call_id });

    if (!transcriptId) return res.status(200).send('OK'); // ignore probes

    if (status === 'error') {
      await upsertFields(call_id || transcriptId, { notes: `AAI error: ${evt.error || 'unknown'}` });
      return res.status(200).send('OK');
    }
    if (status !== 'completed') return res.status(200).send('OK');

    // Fetch full transcript
    let result;
    try {
      const r = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}`, {
        headers: { 'Authorization': AAI_API_KEY }
      });
      result = await r.json();
      if (!r.ok) throw new Error(result?.error || `GET /transcript/${transcriptId} failed`);
    } catch (e) {
      console.error('AAI GET error:', e);
      await upsertFields(call_id || transcriptId, { notes: `AAI GET error: ${e.message}` });
      return res.status(200).send('OK');
    }

    // Resolve call_id if still missing
    if (!call_id) {
      try { call_id = result?.metadata ? JSON.parse(result.metadata)?.call_id || null : null; } catch {}
    }
    if (!call_id && result?.audio_url) {
      const m = String(result.audio_url).match(/recordings\/([^/]+)\.mp3/i);
      if (m && m[1]) call_id = m[1];
    }
    call_id = call_id || String(transcriptId);

    let text = result?.text || '';
    if ((!text || text.trim().length < 5) && Array.isArray(result?.utterances)) {
      text = result.utterances.map(u => {
        const sp = (typeof u.speaker === 'number') ? `Speaker ${u.speaker}` : (u.speaker || 'Speaker');
        return `${sp}: ${u.text || ''}`;
      }).join('\n');
    }

    await storeTranscript(call_id, transcriptId, text || '');
    console.log('✅ AAI transcript stored for', call_id);

    return res.status(200).send('OK');
  } catch (e) {
    console.error('AAI webhook handler error:', e);
    return res.status(500).send('error');
  }
});

// ------------------------------ Handlers -------------------------------------
async function onCallInitiated(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const dir = data.payload?.direction || data.direction; // incoming | outgoing
  const from_number = data.payload?.from || data.from;
  const to_number = data.payload?.to || data.to;
  const start_time = new Date().toISOString();

  if (dir === 'incoming') {
    await upsertCall({
      call_id, direction: 'inbound', from_number, to_number,
      status: 'initiated', start_time, call_type: 'customer_inquiry'
    });
    await answerAndIntro(call_id);
  } else {
    // Outbound (human rep)
    const existing = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
    if (existing) {
      await dbRun('UPDATE calls SET status = ?, start_time = ?, from_number = ?, to_number = ? WHERE call_id = ?',
        ['initiated', start_time, from_number, to_number, call_id]);
    } else {
      const linked_customer_call_id = clientState?.customer_call_id || null;
      await upsertCall({
        call_id, direction: 'outbound', from_number, to_number,
        status: 'initiated', start_time, call_type: 'human_representative',
        linked_customer_call_id, human_dial_started_at: start_time
      });
    }
  }
}

async function onCallAnswered(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  await upsertFields(call_id, { status: 'answered' });

  let isHumanLeg = false;
  let customerCallId = clientState?.customer_call_id || null;

  const rec = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  if (rec?.call_type === 'human_representative') isHumanLeg = true;
  if (!customerCallId && rec?.linked_customer_call_id) customerCallId = rec.linked_customer_call_id;

  if (isHumanLeg && customerCallId) {
    await upsertFields(call_id, { human_answered_at: new Date().toISOString() });
    clearHumanTimeout(customerCallId);

    const cust = await dbGet('SELECT * FROM calls WHERE call_id = ?', [customerCallId]);
    if (!cust || cust.status === 'completed') {
      await speakToCall(call_id, "Sorry, the caller disconnected just now. Thank you.");
      setTimeout(async () => {
        try { await fetch(`https://api.telnyx.com/v2/calls/${call_id}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {}
      }, 2000);
      return;
    }

    // Prepare to bridge after greeting
    pendingBridges.set(call_id, { customerCallId, readyToBridge: true });

    try {
      if (USE_RECORDED_PROMPTS && HUMAN_GREETING_AUDIO_URL) {
        await playbackAudio(call_id, HUMAN_GREETING_AUDIO_URL);
      } else {
        await speakToCall(call_id, "Customer is on the line. Connecting you now.");
      }

      // Fallback bridge if speak.ended not received
      setTimeout(async () => {
        const still = pendingBridges.get(call_id);
        if (still && still.readyToBridge) {
          pendingBridges.delete(call_id);
          await attemptBridge(customerCallId, call_id);
        }
      }, Math.max(4000, HUMAN_BRIDGE_GREETING_MS));
    } catch (err) {
      console.error('Greeting error:', err);
      setTimeout(() => attemptBridge(customerCallId, call_id), 2000);
    }
  }
}

async function onSpeakEnded(data, clientState) {
  const call_id = data?.payload?.call_control_id || data?.call_control_id;
  const bridgeInfo = pendingBridges.get(call_id);
  if (bridgeInfo?.readyToBridge) {
    pendingBridges.delete(call_id);
    await attemptBridge(bridgeInfo.customerCallId, call_id);
  }
}

async function attemptBridge(customerCallId, humanCallId) {
  try {
    const custNow = await dbGet('SELECT * FROM calls WHERE call_id = ?', [customerCallId]);
    if (!custNow || custNow.status === 'completed') {
      await speakToCall(humanCallId, "Sorry, the caller disconnected. Thank you.");
      setTimeout(async () => {
        try { await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {}
      }, 2000);
      return;
    }

    const bridge = await fetch(`https://api.telnyx.com/v2/calls/${customerCallId}/actions/bridge`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ call_control_id: humanCallId })
    });

    if (bridge.ok) {
      await upsertFields(customerCallId, {
        call_type: 'human_connected',
        notes: 'Connected to human representative',
        pending_human_call_id: null
      });
      console.log('✅ BRIDGE SUCCESS:', `${customerCallId} <-> ${humanCallId}`);
    } else {
      const errorText = await bridge.text();
      console.error('Bridge failed:', errorText);
      await speakToCall(humanCallId, "We're having an issue connecting you. Sorry about that.");
      await speakToCall(customerCallId, "We're having technical difficulties. Please call back in a few minutes.");
      setTimeout(async () => {
        try { await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {}
      }, 3000);
    }
  } catch (err) {
    console.error('attemptBridge exception:', err);
    try { await speakToCall(humanCallId, "We're having technical difficulties. Sorry about that."); } catch {}
  }
}

async function onCallHangup(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const end_time = new Date().toISOString();

  const wasPendingBridge = pendingBridges.has(call_id);
  if (wasPendingBridge) pendingBridges.delete(call_id);

  const rec = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  const wasCustomer = rec?.direction === 'inbound' || rec?.call_type === 'customer_inquiry';
  const wasHuman = rec?.call_type === 'human_representative';

  let duration = null;
  if (rec?.start_time) {
    const start = new Date(rec.start_time).getTime();
    duration = Math.max(0, Math.floor((Date.now() - start) / 1000));
  }
  await upsertFields(call_id, { status: 'completed', end_time, duration });

  if (wasCustomer) {
    clearHumanTimeout(call_id);
    const humanRow = await dbGet('SELECT pending_human_call_id FROM calls WHERE call_id = ?', [call_id]);
    const humanId = humanRow?.pending_human_call_id;
    if (humanId) {
      try { await fetch(`https://api.telnyx.com/v2/calls/${humanId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {}
      await upsertFields(call_id, { pending_human_call_id: null });
    }
  }

  if (wasHuman) {
    const customerCallId = rec?.linked_customer_call_id || clientState?.customer_call_id;
    if (customerCallId) {
      const cust = await dbGet('SELECT * FROM calls WHERE call_id = ?', [customerCallId]);
      if (cust && cust.status !== 'completed') {
        await speakToCall(customerCallId, "Sorry, our representative couldn't take the call. Please leave your name, phone, address, and details after the beep.");
        await upsertFields(customerCallId, { pending_human_call_id: null });
      }
    }
  }
}

async function onRecordingSaved(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const telnyxUrl = data.payload?.recording_urls?.mp3 || data.recording_urls?.mp3;
  let finalUrl = telnyxUrl;

  try {
    await dbRun('BEGIN IMMEDIATE');
    finalUrl = await mirrorRecordingToSpaces(call_id, telnyxUrl);
    await upsertFields(call_id, { recording_url: finalUrl, status: 'completed' });
    await dbRun('COMMIT');
  } catch (e) {
    try { await dbRun('ROLLBACK'); } catch {}
    console.error('Recording save DB error:', e);
  }

  // Fire AssemblyAI (webhook or polling)
  createAAIJob(safeKeySegment(call_id), finalUrl).catch((e) => console.error('AAI create job error:', e));

  // Schedule Zapier after we know we have a recording
  await scheduleZapierWebhook(call_id);
}

async function onDTMF(data) {
  const callId = data.payload?.call_control_id || data.call_control_id;
  const digit = data.payload?.digit || data.digit;
  switch (digit) {
    case '1':
    case '0':
      await speakToCall(callId, "Connecting you now. Please remain on the line while we dial our representative.");
      await connectToHuman(callId);
      break;
    case '2':
      await speakToCall(callId, "Please describe your water or flood damage situation after the beep. Include your address and details of the damage. When you're done, you can simply hang up.");
      break;
    default:
      await speakToCall(callId, "Invalid selection. Please try again.");
      await waitMs(600);
      await playIVRMenu(callId);
  }
}

async function connectToHuman(customerCallId) {
  try {
    if (!HUMAN_PHONE_NUMBER) {
      await speakToCall(customerCallId, "Sorry, we can't reach a representative right now.");
      return;
    }

    await upsertFields(customerCallId, { call_type: 'human_transfer', notes: 'Customer requested human representative' });

    const cs = b64({ customer_call_id: customerCallId });
    const resp = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: telnyxHeaders(),
      body: JSON.stringify({
        to: HUMAN_PHONE_NUMBER,
        from: TELNYX_PHONE_NUMBER,
        connection_id: TELNYX_CONNECTION_ID,
        webhook_url: `${WEBHOOK_BASE_URL}/webhooks/calls`,
        client_state: cs,
        machine_detection: 'disabled',
        timeout_secs: 30
      })
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error('Failed to dial human:', errorText);
      await speakToCall(customerCallId, "I'm sorry, we couldn't reach our representative. Please leave a detailed message after the tone.");
      return;
    }

    const json = await resp.json();
    const humanCallId = json?.data?.call_control_id;
    if (!humanCallId) {
      await speakToCall(customerCallId, "I'm sorry, we couldn't reach our representative.");
      return;
    }

    const now = new Date().toISOString();
    await upsertFields(customerCallId, { pending_human_call_id: humanCallId });
    await upsertCall({
      call_id: humanCallId,
      direction: 'outbound',
      from_number: TELNYX_PHONE_NUMBER,
      to_number: HUMAN_PHONE_NUMBER,
      status: 'initiated',
      start_time: now,
      call_type: 'human_representative',
      linked_customer_call_id: customerCallId,
      human_dial_started_at: now
    });

    clearHumanTimeout(customerCallId);
    const t = setTimeout(async () => {
      const row = await dbGet('SELECT status, pending_human_call_id FROM calls WHERE call_id = ?', [customerCallId]);
      if (!row || row.status === 'completed') return;
      const stillPending = row.pending_human_call_id === humanCallId;
      if (!stillPending) return;

      try { await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {}
      await speakToCall(customerCallId, "I'm sorry, our representative is unavailable. Please leave your name, phone number, address, and details about the water damage after the beep.");
      await upsertFields(customerCallId, { pending_human_call_id: null });
    }, 35000);

    humanTimeouts.set(customerCallId, t);
  } catch (e) {
    console.error('connectToHuman error:', e);
    await speakToCall(customerCallId, "We're having trouble connecting. Please call back in a few minutes or leave a message.");
  }
}

// --------------------------- Zapier (Airtable) --------------------------------
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || '';

async function scheduleZapierWebhook(callId) {
  try {
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);

    const shouldSend =
      call?.recording_url &&
      !call?.zapier_sent &&
      call?.direction === 'inbound';

    if (!shouldSend) return;

    setTimeout(async () => { await sendToZapier(callId); }, 3000);
  } catch (e) {
    console.error('scheduleZapierWebhook error:', e);
  }
}

async function sendToZapier(callId) {
  try {
    if (!ZAPIER_WEBHOOK_URL) return;

    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
    if (!call) return;

    const payload = {
      call_id: call.call_id,
      timestamp: new Date().toISOString(),
      customer_phone: call.from_number,
      call_duration_seconds: call.duration || 0,
      call_start_time: call.start_time,
      call_end_time: call.end_time,
      call_type: call.call_type,
      call_status: call.status,
      recording_url: call.recording_url,
      transcript_url: call.transcript_url || null,                // keep existing field
      " Transcript URL": call.transcript_url || null,             // Airtable column with leading space
      source: 'Water Damage Restoration Phone System',
      lead_source: 'Inbound Phone Call',
      business_phone: call.to_number
    };

    const r = await fetch(ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 30000
    });

    const bodyText = await r.text();
    console.log(`ZAPIER RESP → status: ${r.status}, body: ${bodyText}`);

    if (r.ok) {
      await upsertFields(callId, { zapier_sent: true, zapier_sent_at: new Date().toISOString() });
    } else {
      setTimeout(async () => { await sendToZapier(callId); }, 30000);
    }
  } catch (e) {
    console.error(`ZAPIER ERROR for ${callId}:`, e);
    setTimeout(async () => { await sendToZapier(callId); }, 60000);
  }
}

// ---------------------------- Static / Health --------------------------------
app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    port: PORT,
    nodeVersion: process.version
  });
});

// --------------------------------- Start -------------------------------------
async function startServer() {
  try {
    await initDatabase();
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Water Damage Lead System running on port ${PORT}`);
      console.log(`Webhook URL (Telnyx): ${WEBHOOK_BASE_URL}/webhooks/calls`);
      console.log(`Webhook URL (AAI):    ${WEBHOOK_BASE_URL}/webhooks/assembly`);
      console.log(`Spaces bucket: ${SPACES_BUCKET} | CDN: ${SPACES_CDN_BASE}`);
      console.log(`Telnyx #: ${TELNYX_PHONE_NUMBER} | Human #: ${HUMAN_PHONE_NUMBER}`);
      console.log(`Recorded prompts enabled: ${USE_RECORDED_PROMPTS}`);
      console.log(`Database path: ${dbPath}`);
    });

    const shutdown = (sig) => {
      console.log(`${sig} received, shutting down...`);
      db.close((err) => {
        if (err) console.error('Error closing DB:', err);
        server.close(() => process.exit(0));
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (e) {
    console.error('Failed to start server:', e);
    process.exit(1);
  }
}

startServer().catch(console.error);

export default app;
