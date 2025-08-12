// server.js
// Water Damage Lead System – Telnyx → Spaces → Zapier + AssemblyAI (webhook + polling fallback)

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Node 18+ includes global fetch.

////////////////////////////////////////////////////////////////////////////////////////
// Config
////////////////////////////////////////////////////////////////////////////////////////
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const Config = {
  PORT: Number(process.env.PORT || 3000),

  // Feature flags / prompts
  USE_RECORDED_PROMPTS: String(process.env.USE_RECORDED_PROMPTS || 'false').toLowerCase() === 'true',
  GREETING_AUDIO_URL: process.env.GREETING_AUDIO_URL || '',
  MENU_AUDIO_URL: process.env.MENU_AUDIO_URL || '',
  HUMAN_GREETING_AUDIO_URL: process.env.HUMAN_GREETING_AUDIO_URL || '',
  HUMAN_BRIDGE_GREETING_MS: Number(process.env.HUMAN_BRIDGE_GREETING_MS || 3000),

  // Telnyx
  TELNYX_API_KEY: process.env.TELNYX_API_KEY || '',
  TELNYX_PHONE_NUMBER: process.env.TELNYX_PHONE_NUMBER || '',
  TELNYX_CONNECTION_ID: process.env.TELNYX_CONNECTION_ID || '2755388541746808609',
  WEBHOOK_BASE_URL: (process.env.WEBHOOK_BASE_URL || '').replace(/\/+$/,''),
  HUMAN_PHONE_NUMBER: process.env.HUMAN_PHONE_NUMBER || '',

  // Spaces (S3)
  SPACES_KEY: process.env.SPACES_KEY || '',
  SPACES_SECRET: process.env.SPACES_SECRET || '',
  SPACES_REGION: process.env.SPACES_REGION || 'nyc3',
  SPACES_ENDPOINT: process.env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com',
  SPACES_BUCKET: process.env.SPACES_BUCKET || '',
  SPACES_CDN_BASE: (process.env.SPACES_CDN_BASE || '').replace(/\/+$/,''),

  // AssemblyAI
  AAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || '',
  AAI_WEBHOOK_SECRET: process.env.ASSEMBLYAI_WEBHOOK_SECRET || '',

  // Zapier
  ZAPIER_WEBHOOK_URL: process.env.ZAPIER_WEBHOOK_URL || '',

  // DB
  DATABASE_PATH: process.env.DATABASE_PATH || join(__dirname, 'call_records.db'),
};

const app = express();

////////////////////////////////////////////////////////////////////////////////////////
// Utilities
////////////////////////////////////////////////////////////////////////////////////////
const aaiEnabled = () => !!Config.AAI_API_KEY;

function telnyxHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${Config.TELNYX_API_KEY}`
  };
}

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }
function b64(json) { return Buffer.from(JSON.stringify(json), 'utf8').toString('base64'); }
function parseB64(s) { try { return JSON.parse(Buffer.from(s || '', 'base64').toString('utf8')); } catch { return null; } }

// Safely map any call_id to a key segment for Spaces (avoid ":" and friends)
function safeKeySegment(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]/g, '_');
}

// Optional HMAC-ish verification that some AAI deployments send
function verifyAAISignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return true;
  const [algo, sig] = (signatureHeader || '').split('=', 2);
  if (algo !== 'sha256' || !sig) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody, 'utf8');
  const digest = hmac.digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest)); } catch { return false; }
}

////////////////////////////////////////////////////////////////////////////////////////
// S3 / Spaces
////////////////////////////////////////////////////////////////////////////////////////
const S3 = new S3Client({
  region: Config.SPACES_REGION,
  endpoint: `https://${Config.SPACES_ENDPOINT}`,
  forcePathStyle: false,
  credentials: { accessKeyId: Config.SPACES_KEY, secretAccessKey: Config.SPACES_SECRET }
});

async function putPublicObject(key, body, contentType, cache = 'public, max-age=31536000') {
  if (!Config.SPACES_BUCKET) return null;
  await S3.send(new PutObjectCommand({
    Bucket: Config.SPACES_BUCKET, Key: key, Body: body,
    ContentType: contentType, ACL: 'public-read', CacheControl: cache
  }));
  return `${Config.SPACES_CDN_BASE}/${key}`;
}

////////////////////////////////////////////////////////////////////////////////////////
// Database (SQLite) with queued access
////////////////////////////////////////////////////////////////////////////////////////
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

const db = new sqlite3.Database(
  Config.DATABASE_PATH,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => err ? console.error('Error opening DB:', err) : console.log('Connected to SQLite at:', Config.DATABASE_PATH)
);

db.serialize(() => {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA cache_size = 1000;');
  db.exec('PRAGMA temp_store = memory;');
  db.exec('PRAGMA busy_timeout = 30000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA locking_mode = NORMAL;');
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

function normalizedColumns(obj) {
  const order = [
    'call_id','direction','from_number','to_number','status','start_time','end_time','duration',
    'recording_url','transcript','transcript_url','call_type','customer_info','contractor_info',
    'notes','customer_zip_code','customer_name','lead_quality','zapier_sent','zapier_sent_at',
    'pending_human_call_id','linked_customer_call_id','human_dial_started_at','human_answered_at','created_at'
  ];
  const cols = [], vals = [];
  for (const k of order) if (Object.prototype.hasOwnProperty.call(obj, k)) { cols.push(k); vals.push(obj[k]); }
  return { cols, vals };
}

async function upsertCall(obj) {
  if (!obj.call_id) throw new Error('upsertCall requires call_id');
  const { cols, vals } = normalizedColumns(obj);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter(c => c !== 'call_id').map(c => `${c}=COALESCE(excluded.${c}, ${c})`).join(', ');
  const sql = `INSERT INTO calls (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(call_id) DO UPDATE SET ${updates}`;
  return dbRun(sql, vals);
}
async function upsertFields(call_id, fields) { return upsertCall({ call_id, ...fields }); }

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

////////////////////////////////////////////////////////////////////////////////////////
// Telnyx helpers
////////////////////////////////////////////////////////////////////////////////////////
async function playbackAudio(callId, audioUrl) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
    method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ audio_url: audioUrl })
  });
  if (!r.ok) console.error('playback_start failed:', await r.text());
}

async function speakToCall(callId, message) {
  try {
    const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
      method: 'POST', headers: telnyxHeaders(),
      body: JSON.stringify({ payload: message, voice: 'female', language: 'en-US' })
    });
    if (!r.ok) console.error('speak failed:', await r.text());
  } catch (e) {
    console.error('speak exception:', e);
  }
}

async function gatherUsingSpeak(callId, payload, { min = 1, max = 1, timeoutMs = 12000, term = '#' } = {}) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_speak`, {
    method: 'POST', headers: telnyxHeaders(),
    body: JSON.stringify({
      payload, voice: 'female', language: 'en-US',
      minimum_digits: min, maximum_digits: max, timeout_millis: timeoutMs, terminating_digit: term
    })
  });
  if (!r.ok) console.error('gather_using_speak failed:', await r.text());
}

async function gatherUsingAudio(callId, audioUrl, { min = 1, max = 1, timeoutMs = 12000, term = '#' } = {}) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_audio`, {
    method: 'POST', headers: telnyxHeaders(),
    body: JSON.stringify({
      audio_url: audioUrl, minimum_digits: min, maximum_digits: max, timeout_millis: timeoutMs, terminating_digit: term
    })
  });
  if (!r.ok) console.error('gather_using_audio failed:', await r.text());
}

async function playIVRMenu(callId) {
  if (Config.USE_RECORDED_PROMPTS && Config.MENU_AUDIO_URL) {
    await gatherUsingAudio(callId, Config.MENU_AUDIO_URL, { min: 1, max: 1, timeoutMs: 12000, term: '#' });
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

    const recordResult = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/record_start`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ format: 'mp3', channels: 'dual' })
    }).catch((e) => console.error(`record_start error for ${callId}:`, e));
    if (recordResult && !recordResult.ok) console.error('record_start HTTP error:', await recordResult.text());

    if (Config.USE_RECORDED_PROMPTS && Config.GREETING_AUDIO_URL) {
      await playbackAudio(callId, Config.GREETING_AUDIO_URL);
      await waitMs(400);
    }
    await playIVRMenu(callId);
  } catch (e) { console.error(`answerAndIntro error for ${callId}:`, e); }
}

////////////////////////////////////////////////////////////////////////////////////////
// Spaces: mirror Telnyx recording
////////////////////////////////////////////////////////////////////////////////////////
async function mirrorRecordingToSpaces(call_id, telnyxUrl) {
  if (!Config.SPACES_BUCKET || !Config.SPACES_CDN_BASE) return telnyxUrl;
  try {
    const resp = await fetch(telnyxUrl);
    if (!resp.ok) throw new Error(`download ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const key = `recordings/${safeKeySegment(call_id)}.mp3`;
    const cdnUrl = await putPublicObject(key, buf, 'audio/mpeg', 'public, max-age=31536000, immutable');
    console.log('Uploaded recording to Spaces:', cdnUrl);
    return cdnUrl || telnyxUrl;
  } catch (e) {
    console.error('mirrorRecordingToSpaces error:', e);
    return telnyxUrl;
  }
}

////////////////////////////////////////////////////////////////////////////////////////
// AssemblyAI (webhook-based, with validated webhook + fallback to polling)
////////////////////////////////////////////////////////////////////////////////////////
const AAI_WEBHOOK_URL = `${Config.WEBHOOK_BASE_URL}/webhooks/assembly`;

// Store transcript: upload minimal .txt to Spaces (if configured), else fallback to AAI URL
async function storeTranscript(call_id, transcriptId, text) {
  let txtUrl = null;
  if (Config.SPACES_BUCKET && Config.SPACES_CDN_BASE) {
    const key = `transcripts/${safeKeySegment(call_id)}.txt`;
    try {
      txtUrl = await putPublicObject(key, Buffer.from(text || '', 'utf8'), 'text/plain; charset=utf-8');
    } catch (e) {
      console.error('TXT upload failed:', e);
    }
  }
  // if no Spaces URL, we can still provide a retrievable endpoint at AssemblyAI
  const fallbackUrl = `https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}`;
  const finalUrl = txtUrl || fallbackUrl;

  await upsertFields(call_id, {
    transcript: text || null,
    transcript_url: finalUrl || null,
    notes: `AAI complete (${transcriptId})`
  });

  // Optional follow-up Zap so Airtable gets the link even if initial Zap already ran
  if (Config.ZAPIER_WEBHOOK_URL && finalUrl) {
    try {
      await fetch(Config.ZAPIER_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          call_id: call_id,
          ' Transcript URL': finalUrl,
          event_type: 'transcript_ready'
        })
      });
      console.log('📤 Sent Transcript URL update to Zapier for Call', call_id);
    } catch (e) {
      console.error('Zapier transcript update error:', e);
    }
  }
}

// --- replace your existing createAAIJob with this one ---
async function createAAIJob(call_id, audioUrl) {
  if (!aaiEnabled() || !audioUrl) {
    console.log('AAI: skip (missing key or audioUrl)');
    return null;
  }

  // Build and validate webhook URL (https required)
  let webhookUrl = null;
  try {
    const base = (Config.WEBHOOK_BASE_URL || '').trim();
    if (base) {
      const u = new URL(base);
      if (u.protocol === 'https:') {
        u.pathname = (u.pathname.replace(/\/+$/, '') + '/webhooks/assembly').replace(/\/{2,}/g, '/');
        u.searchParams.set('call_id', safeKeySegment(call_id));
        webhookUrl = u.toString();
      } else {
        console.warn(`AAI: WEBHOOK_BASE_URL must be https:// — got ${u.protocol}`);
      }
    }
  } catch (e) {
    console.warn('AAI: invalid WEBHOOK_BASE_URL, will fall back to polling:', e?.message);
  }

  const payload = { audio_url: audioUrl };
  if (webhookUrl) payload.webhook_url = webhookUrl;

  // Try both endpoint forms, no slash first (some regions 405 the trailing slash)
  const endpoints = [
    'https://api.assemblyai.com/v2/transcript',   // preferred
    'https://api.assemblyai.com/v2/transcript/'   // fallback
  ];

  const tryCreate = async (endpoint, body) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': Config.AAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    let j = {};
    try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json: j };
  };

  // 1) Try with webhook_url (validated). If schema error, retry without webhook.
  for (const ep of endpoints) {
    try {
      const first = await tryCreate(ep, payload);
      if (first.ok && first.json?.id) {
        if (!webhookUrl) pollAAIUntilDone(first.json.id, call_id).catch(() => {});
        return first.json.id;
      }
      // If webhook schema issue, retry once WITHOUT webhook on this same endpoint
      const msg = (first.json && (first.json.error || first.json.message || '')).toString().toLowerCase();
      const looksWebhooky = msg.includes('endpoint') || msg.includes('schema') || msg.includes('webhook');
      if (webhookUrl && looksWebhooky) {
        console.warn(`AAI: ${ep} rejected webhook_url; retrying without webhook and will poll…`);
        const second = await tryCreate(ep, { audio_url: audioUrl });
        if (second.ok && second.json?.id) {
          pollAAIUntilDone(second.json.id, call_id).catch(() => {});
          return second.json.id;
        }
        // If that failed too, try the next endpoint form
        continue;
      }

      // If 405/404 (endpoint form issue), try the next endpoint form
      if (first.status === 405 || first.status === 404) {
        console.warn(`AAI: ${ep} returned ${first.status}; trying alternate endpoint form…`);
        continue;
      }

      // Other errors: log and try the alternate form
      console.error('AAI create failed:', { endpoint: ep, status: first.status, body: first.json, sent: payload });
    } catch (e) {
      console.error('AAI create exception:', e);
      // try next endpoint form
    }
  }

  // If all attempts failed, give up gracefully
  console.error('AAI: all create attempts failed for call', call_id);
  return null;
}


////////////////////////////////////////////////////////////////////////////////////////
 // In-memory state (timeouts & bridge tracking). Mapping persists in DB.
////////////////////////////////////////////////////////////////////////////////////////
const humanTimeouts = new Map(); // customerCallId -> timeoutId
const pendingBridges = new Map(); // humanCallId -> { customerCallId, readyToBridge: true }
function clearHumanTimeout(customerCallId) {
  const t = humanTimeouts.get(customerCallId);
  if (t) { clearTimeout(t); humanTimeouts.delete(customerCallId); }
}

////////////////////////////////////////////////////////////////////////////////////////
// Webhooks
////////////////////////////////////////////////////////////////////////////////////////
app.use(express.json());

// Telnyx webhook
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
      case 'call.speak.ended': await onSpeakEnded(data, clientState); break;
      case 'call.bridged':
        console.log(`🌉 TELNYX CONFIRMS BRIDGE for: ${callId}`);
        break;
      default: /* ignore noisy 'speak.started' and 'gather.ended' */ break;
    }
  } catch (e) {
    console.error(`WEBHOOK ERROR processing ${event} for ${callId}:`, e);
  }

  res.status(200).send('OK');
});

// AssemblyAI webhook: accept raw text for optional HMAC header verification
app.post('/webhooks/assembly', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const rawBody = req.body || '';
    const signatureHeader = req.get('AAI-Signature') || '';
    const authHeader = req.get('Authorization') || '';

    // Optional security: allow either HMAC or static bearer (if configured)
    if (Config.AAI_WEBHOOK_SECRET) {
      const hmacOK = verifyAAISignature(rawBody, signatureHeader, Config.AAI_WEBHOOK_SECRET);
      const bearerOK = authHeader === `Bearer ${Config.AAI_WEBHOOK_SECRET}`;
      if (!hmacOK && !bearerOK) return res.status(401).send('unauthorized');
    }

    // Parse webhook JSON
    let evt;
    try { evt = JSON.parse(rawBody); } catch { evt = {}; }

    const transcriptId = evt?.id || evt?.transcript_id || null;
    const status = evt?.status || null;
    let call_id = null;
    try { call_id = evt?.metadata ? JSON.parse(evt.metadata)?.call_id || null : null; } catch {}

    console.log('🎧 AAI Webhook:', { transcriptId, status, hasMetadata: !!evt?.metadata, call_id });

    if (!transcriptId) return res.status(200).send('OK'); // nothing to do
    if (status === 'error') {
      await upsertFields(call_id || transcriptId, { notes: `AAI error: ${evt.error || 'unknown'}` });
      return res.status(200).send('OK');
    }
    if (status !== 'completed') return res.status(200).send('OK');

    // Fetch the full transcript result via GET
    let result;
    try {
      const r = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}`, {
        headers: { 'Authorization': Config.AAI_API_KEY }
      });
      result = await r.json();
      if (!r.ok) throw new Error(result?.error || `GET /transcript/${transcriptId} failed`);
    } catch (e) {
      console.error('AAI GET error:', e);
      await upsertFields(call_id || transcriptId, { notes: `AAI GET error: ${e.message}` });
      return res.status(200).send('OK');
    }

    // Prefer call_id from metadata; else from audio_url key; else fallback to transcriptId
    if (!call_id) {
      try { call_id = result?.metadata ? JSON.parse(result.metadata)?.call_id || null : null; } catch {}
    }
    if (!call_id && result?.audio_url) {
      const m = String(result.audio_url).match(/recordings\/([^/]+)\.mp3/i);
      if (m && m[1]) call_id = m[1];
    }
    call_id = call_id || String(transcriptId);

    // Build transcript text; if empty, synthesize from utterances
    let transcriptText = result?.text || '';
    if ((!transcriptText || transcriptText.trim().length < 5) && Array.isArray(result?.utterances)) {
      transcriptText = result.utterances
        .map(u => {
          const sp = (typeof u.speaker === 'number') ? `Speaker ${u.speaker}` : (u.speaker || 'Speaker');
          return `${sp}: ${u.text || ''}`;
        })
        .join('\n');
    }

    await storeTranscript(call_id, transcriptId, transcriptText || '');
    console.log('✅ AAI transcript stored for', call_id);

    return res.status(200).send('OK');
  } catch (e) {
    console.error('AAI webhook handler error:', e);
    return res.status(500).send('error');
  }
});

////////////////////////////////////////////////////////////////////////////////////////
// Event Handlers (behavior-preserving)
////////////////////////////////////////////////////////////////////////////////////////
async function onSpeakEnded(data) {
  const call_id = data?.payload?.call_control_id || data?.call_control_id;
  const b = pendingBridges.get(call_id);
  if (b && b.readyToBridge) {
    pendingBridges.delete(call_id);
    await attemptBridge(b.customerCallId, call_id);
  }
}

async function attemptBridge(customerCallId, humanCallId) {
  try {
    const custNow = await dbGet('SELECT * FROM calls WHERE call_id = ?', [customerCallId]);
    if (!custNow || custNow.status === 'completed') {
      await speakToCall(humanCallId, "Sorry, the caller disconnected. Thank you.");
      setTimeout(async () => { try { await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {} }, 2000);
      return;
    }

    const r = await fetch(`https://api.telnyx.com/v2/calls/${customerCallId}/actions/bridge`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ call_control_id: humanCallId })
    });

    if (r.ok) {
      await upsertFields(customerCallId, { call_type: 'human_connected', notes: 'Connected to human representative', pending_human_call_id: null });
      console.log(`✅ BRIDGE SUCCESS: ${customerCallId} <-> ${humanCallId}`);
    } else {
      console.error('BRIDGE FAILED:', await r.text());
      await speakToCall(humanCallId, "We're having an issue connecting you. Sorry about that.");
      await speakToCall(customerCallId, "We're having technical difficulties. Please call back in a few minutes.");
      setTimeout(async () => { try { await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {} }, 3000);
    }
  } catch (e) {
    console.error('BRIDGE EXCEPTION:', e);
    try { await speakToCall(humanCallId, "We're having technical difficulties. Sorry about that."); } catch {}
  }
}

async function onCallInitiated(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const dirRaw = data.payload?.direction || data.direction; // incoming/outgoing
  const direction = dirRaw === 'incoming' ? 'inbound' : 'outbound';
  const from_number = data.payload?.from || data.from || null;
  const to_number = data.payload?.to || data.to || null;
  const start_time = new Date().toISOString();

  if (direction === 'inbound') {
    await upsertCall({ call_id, direction, from_number, to_number, status: 'initiated', start_time, call_type: 'customer_inquiry' });
    await answerAndIntro(call_id);
  } else {
    const linked_customer_call_id = clientState?.customer_call_id || null;
    const existing = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
    if (existing) {
      await upsertFields(call_id, {
        direction: existing.direction || 'outbound',
        from_number: from_number || existing.from_number || Config.TELNYX_PHONE_NUMBER || null,
        to_number: to_number || existing.to_number || Config.HUMAN_PHONE_NUMBER || null,
        status: 'initiated',
        start_time,
        call_type: existing.call_type || 'human_representative',
        linked_customer_call_id: existing.linked_customer_call_id || linked_customer_call_id
      });
    } else {
      await upsertCall({
        call_id, direction: 'outbound', from_number, to_number, status: 'initiated',
        start_time, call_type: 'human_representative', linked_customer_call_id
      });
    }
  }
}

async function onCallAnswered(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  await upsertFields(call_id, { status: 'answered' });

  let rec = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  const customerFromState = clientState?.customer_call_id || null;

  const assumeHuman = rec?.direction === 'outbound' || !!customerFromState;
  if (assumeHuman) {
    await upsertFields(call_id, {
      call_type: rec?.call_type || 'human_representative',
      linked_customer_call_id: rec?.linked_customer_call_id || customerFromState || null,
      direction: rec?.direction || 'outbound'
    });
    rec = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  }

  let isHuman = rec?.call_type === 'human_representative';
  let customerCallId = customerFromState || rec?.linked_customer_call_id || null;
  if (!isHuman && rec?.direction === 'outbound' && customerCallId) isHuman = true;
  if (!isHuman && customerFromState) isHuman = true;

  if (isHuman && customerCallId) {
    await upsertFields(call_id, { human_answered_at: new Date().toISOString() });
    clearHumanTimeout(customerCallId);

    const cust = await dbGet('SELECT * FROM calls WHERE call_id = ?', [customerCallId]);
    if (!cust || cust.status === 'completed') {
      await speakToCall(call_id, "Sorry, the caller disconnected just now. Thank you.");
      setTimeout(async () => { try { await fetch(`https://api.telnyx.com/v2/calls/${call_id}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {} }, 2000);
      return;
    }

    pendingBridges.set(call_id, { customerCallId, readyToBridge: true });
    try {
      if (Config.USE_RECORDED_PROMPTS && Config.HUMAN_GREETING_AUDIO_URL) {
        await playbackAudio(call_id, Config.HUMAN_GREETING_AUDIO_URL);
      } else {
        await speakToCall(call_id, "Customer is on the line. Connecting you now.");
      }
      setTimeout(async () => {
        const still = pendingBridges.get(call_id);
        if (still && still.readyToBridge) {
          pendingBridges.delete(call_id);
          await attemptBridge(customerCallId, call_id);
        }
      }, Config.HUMAN_BRIDGE_GREETING_MS);
    } catch (e) {
      console.error('Greeting error:', e);
      setTimeout(() => attemptBridge(customerCallId, call_id), 2000);
    }
  }
}

async function onCallHangup(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const end_time = new Date().toISOString();

  const wasPending = pendingBridges.has(call_id);
  pendingBridges.delete(call_id);

  const rec = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  const wasCustomer = rec?.direction === 'inbound' || rec?.call_type === 'customer_inquiry';
  const wasHuman = rec?.call_type === 'human_representative';

  let duration = null;
  if (rec?.start_time) {
    duration = Math.max(0, Math.floor((Date.now() - new Date(rec.start_time).getTime()) / 1000));
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

  console.log(`🔚 CALL HANGUP ${call_id} | wasCustomer=${!!wasCustomer} wasHuman=${!!wasHuman} pendingBridge=${wasPending}`);
}

async function onRecordingSaved(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const telnyxUrl = data.payload?.recording_urls?.mp3 || data.recording_urls?.mp3;
  let finalUrl = telnyxUrl;

  try {
    await dbRun('BEGIN IMMEDIATE');
    finalUrl = await mirrorRecordingToSpaces(call_id, telnyxUrl);
    await upsertFields(call_id, { recording_url: finalUrl });
    await dbRun('COMMIT');
  } catch (e) {
    console.error(`recording update failed for ${call_id}:`, e);
    try { await dbRun('ROLLBACK'); } catch {}
  }

  // Start AssemblyAI job (webhook handles completion; or we poll if webhook invalid)
  createAAIJob(call_id, finalUrl).catch((e) => console.error('AAI create job error:', e));

  // Consider Zapier (initial record)
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

// Human dial & mapping
async function connectToHuman(customerCallId) {
  try {
    if (!Config.HUMAN_PHONE_NUMBER) {
      await speakToCall(customerCallId, "Sorry, we can't reach a representative right now.");
      return;
    }

    await upsertFields(customerCallId, { call_type: 'human_transfer', notes: 'Customer requested human representative' });

    const cs = b64({ customer_call_id: customerCallId });
    const resp = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: telnyxHeaders(),
      body: JSON.stringify({
        to: Config.HUMAN_PHONE_NUMBER,
        from: Config.TELNYX_PHONE_NUMBER,
        connection_id: Config.TELNYX_CONNECTION_ID,
        webhook_url: `${Config.WEBHOOK_BASE_URL}/webhooks/calls`,
        client_state: cs,
        machine_detection: 'disabled',
        timeout_secs: 30
      })
    });

    if (!resp.ok) {
      console.error('dial human failed:', await resp.text());
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
      from_number: Config.TELNYX_PHONE_NUMBER,
      to_number: Config.HUMAN_PHONE_NUMBER,
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
      if (row.pending_human_call_id !== humanCallId) return;

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

////////////////////////////////////////////////////////////////////////////////////////
// Zapier
////////////////////////////////////////////////////////////////////////////////////////
async function scheduleZapierWebhook(callId) {
  try {
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
    const shouldSend = !!(call?.recording_url && !call?.zapier_sent && call?.direction === 'inbound');
    if (!shouldSend) return;
    setTimeout(async () => { await sendToZapier(callId); }, 3000);
  } catch (e) { console.error('scheduleZapierWebhook error:', e); }
}

async function sendToZapier(callId) {
  try {
    if (!Config.ZAPIER_WEBHOOK_URL) { console.log('Zapier not configured'); return; }
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
      transcript_url: call.transcript_url || null,      // backward-compatible
      " Transcript URL": call.transcript_url || null,    // Airtable exact field name (note leading space)
      source: 'Water Damage Restoration Phone System',
      lead_source: 'Inbound Phone Call',
      business_phone: call.to_number
    };

    const r = await fetch(Config.ZAPIER_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const bodyText = await r.text();
    console.log(`ZAPIER RESP → status: ${r.status}, body: ${bodyText}`);

    if (r.ok) {
      await upsertFields(callId, { zapier_sent: true, zapier_sent_at: new Date().toISOString() });
    } else {
      setTimeout(async () => { await sendToZapier(callId); }, 30000);
    }
  } catch (e) {
    console.error(`Zapier error for ${callId}:`, e);
    setTimeout(async () => { await sendToZapier(callId); }, 60000);
  }
}

////////////////////////////////////////////////////////////////////////////////////////
// Static & Health
////////////////////////////////////////////////////////////////////////////////////////
app.use(express.static(join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), port: Config.PORT, nodeVersion: process.version });
});

////////////////////////////////////////////////////////////////////////////////////////
// Start
////////////////////////////////////////////////////////////////////////////////////////
async function startServer() {
  try {
    await initDatabase();
    const server = app.listen(Config.PORT, '0.0.0.0', () => {
      console.log(`Water Damage Lead System running on port ${Config.PORT}`);
      console.log(`Webhook URL (Telnyx): ${Config.WEBHOOK_BASE_URL}/webhooks/calls`);
      console.log(`Webhook URL (AAI):    ${AAI_WEBHOOK_URL}`);
      console.log(`Spaces bucket: ${Config.SPACES_BUCKET || '(not set)'} | CDN: ${Config.SPACES_CDN_BASE || '(not set)'}`);
      console.log(`Telnyx #: ${Config.TELNYX_PHONE_NUMBER || 'Not set'} | Human #: ${Config.HUMAN_PHONE_NUMBER || 'Not set'}`);
      console.log(`Recorded prompts enabled: ${Config.USE_RECORDED_PROMPTS}`);
      console.log(`Database path: ${Config.DATABASE_PATH}`);
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
