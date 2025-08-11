// server.js
// Water Damage Lead System – durable bridging, Spaces mirroring, Zapier, transcripts
// Includes staff greeting before bridge (configurable delay)

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// -------- Paths / App --------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// -------- Feature Flags / Prompts (optional) --------
const USE_RECORDED_PROMPTS = String(process.env.USE_RECORDED_PROMPTS || 'false').toLowerCase() === 'true';
const GREETING_AUDIO_URL = process.env.GREETING_AUDIO_URL || '';
const MENU_AUDIO_URL = process.env.MENU_AUDIO_URL || '';
const HUMAN_GREETING_AUDIO_URL = process.env.HUMAN_GREETING_AUDIO_URL || '';
// Staff greeting length before bridging (ms)
const HUMAN_BRIDGE_GREETING_MS = Number(process.env.HUMAN_BRIDGE_GREETING_MS || 1200);

// -------- Telnyx & Routing --------
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER || '';
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || '2755388541746808609';
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || '';
const HUMAN_PHONE_NUMBER = process.env.HUMAN_PHONE_NUMBER || '';

function telnyxHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${TELNYX_API_KEY}`
  };
}

// -------- DigitalOcean Spaces (S3 compatible) --------
const SPACES_KEY = process.env.SPACES_KEY || '';
const SPACES_SECRET = process.env.SPACES_SECRET || '';
const SPACES_REGION = process.env.SPACES_REGION || 'nyc3';
const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com';
const SPACES_BUCKET = process.env.SPACES_BUCKET || '';
const SPACES_CDN_BASE = process.env.SPACES_CDN_BASE || '';

const S3 = new S3Client({
  region: SPACES_REGION,
  endpoint: `https://${SPACES_ENDPOINT}`,
  forcePathStyle: false,
  credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET }
});

// -------- Transcription (AssemblyAI - optional) --------
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || '';
const SAVE_TRANSCRIPTS_TO_SPACES = true; // save .txt to spaces
const TRANSCRIPT_FOLDER = 'transcripts';

// -------- Database (SQLite) with queue --------
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
console.log('Database path:', dbPath);

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
      -- durable mapping fields
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

// -------- Utilities --------
function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }
function b64(json) { return Buffer.from(JSON.stringify(json), 'utf8').toString('base64'); }
function parseB64(s) { try { return JSON.parse(Buffer.from(s || '', 'base64').toString('utf8')); } catch { return null; } }

// -------- Telnyx Call Control helpers --------
async function answerAndIntro(callId) {
  try {
    const answer = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({})
    });
    if (!answer.ok) { console.error('Failed to answer:', await answer.text()); return; }

    await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/record_start`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ format: 'mp3', channels: 'dual' })
    }).catch(() => {});

    if (USE_RECORDED_PROMPTS && GREETING_AUDIO_URL) {
      await playbackAudio(callId, GREETING_AUDIO_URL);
      await waitMs(400);
    }
    await playIVRMenu(callId);
  } catch (e) { console.error('answerAndIntro error:', e); }
}

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
  if (!r.ok) console.error('gather_using_speak failed:', await r.text());
}

async function gatherUsingAudio(callId, audioUrl, { min = 1, max = 1, timeoutMs = 12000, term = '#' } = {}) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_audio`, {
    method: 'POST', headers: telnyxHeaders(),
    body: JSON.stringify({
      audio_url: audioUrl,
      minimum_digits: min, maximum_digits: max, timeout_millis: timeoutMs, terminating_digit: term
    })
  });
  if (!r.ok) console.error('gather_using_audio failed:', await r.text());
}

async function playIVRMenu(callId) {
  if (USE_RECORDED_PROMPTS && MENU_AUDIO_URL) {
    await gatherUsingAudio(callId, MENU_AUDIO_URL, { min: 1, max: 1, timeoutMs: 12000, term: '#' });
  } else {
    await gatherUsingSpeak(callId,
      "Thanks for calling our flood and water damage restoration team. " +
      "Press 1 to be connected to a representative now. " +
      "Press 2 to leave details and we’ll call you back. " +
      "You can also press 0 to reach a representative.",
      { min: 1, max: 1, timeoutMs: 12000, term: '#' }
    );
  }
}

// -------- Spaces: mirror recording (mp3) --------
async function mirrorRecordingToSpaces(call_id, telnyxUrl) {
  if (!SPACES_BUCKET || !SPACES_CDN_BASE) return telnyxUrl;
  try {
    const resp = await fetch(telnyxUrl);
    if (!resp.ok) throw new Error(`download ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const key = `recordings/${call_id}.mp3`;
    await S3.send(new PutObjectCommand({
      Bucket: SPACES_BUCKET, Key: key, Body: buf, ContentType: 'audio/mpeg', ACL: 'public-read',
      CacheControl: 'public, max-age=31536000, immutable'
    }));
    const cdnUrl = `${SPACES_CDN_BASE.replace(/\/+$/,'')}/${key}`;
    console.log('Uploaded recording to Spaces:', cdnUrl);
    return cdnUrl;
  } catch (e) {
    console.error('mirrorRecordingToSpaces error:', e);
    return telnyxUrl;
  }
}

// -------- Transcription (AssemblyAI) -> optional save to Spaces & db --------
async function transcribeAndStore(call_id, audioUrl) {
  if (!ASSEMBLYAI_API_KEY || !audioUrl) return;

  try {
    // 1) Create transcript job
    const createRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'Authorization': ASSEMBLYAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl })
    });
    const createJson = await createRes.json();
    const transcriptId = createJson.id;
    if (!transcriptId) { console.error('AssemblyAI create error:', createJson); return; }

    // 2) Poll
    let status = 'queued', text = '';
    for (let i = 0; i < 60; i++) {
      await waitMs(5000);
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { 'Authorization': ASSEMBLYAI_API_KEY }
      });
      const pollJson = await pollRes.json();
      status = pollJson.status;
      if (status === 'completed') { text = pollJson.text || ''; break; }
      if (status === 'error') { console.error('AssemblyAI error:', pollJson.error); break; }
    }
    if (!text) return;

    // 3) Save transcript to Spaces as .txt
    let transcriptUrl = null;
    if (SAVE_TRANSCRIPTS_TO_SPACES && SPACES_BUCKET && SPACES_CDN_BASE) {
      const key = `${TRANSCRIPT_FOLDER}/${call_id}.txt`;
      await S3.send(new PutObjectCommand({
        Bucket: SPACES_BUCKET, Key: key, Body: Buffer.from(text, 'utf8'),
        ContentType: 'text/plain; charset=utf-8', ACL: 'public-read', CacheControl: 'public, max-age=31536000'
      }));
      transcriptUrl = `${SPACES_CDN_BASE.replace(/\/+$/,'')}/${key}`;
    }

    await upsertFields(call_id, {
      transcript: text,
      transcript_url: transcriptUrl || null
    });
  } catch (e) {
    console.error('transcribeAndStore error:', e);
  }
}

// -------- State (only for timers; mapping is in DB) --------
const humanTimeouts = new Map(); // key: customerCallId -> timeoutId
function clearHumanTimeout(customerCallId) {
  const t = humanTimeouts.get(customerCallId);
  if (t) { clearTimeout(t); humanTimeouts.delete(customerCallId); }
}

// -------- Webhooks --------
app.use(express.json());

app.post('/webhooks/calls', async (req, res) => {
  const { data } = req.body || {};
  const event = data?.event_type;
  const callId = data?.payload?.call_control_id || data?.call_control_id;
  const clientState = parseB64(data?.payload?.client_state || data?.client_state);
  if (event && callId) console.log('Webhook:', event, 'CallID:', callId);

  try {
    switch (event) {
      case 'call.initiated': await onCallInitiated(data, clientState); break;
      case 'call.answered': await onCallAnswered(data, clientState); break;
      case 'call.hangup': await onCallHangup(data, clientState); break;
      case 'call.recording.saved': await onRecordingSaved(data, clientState); break;
      case 'call.dtmf.received': await onDTMF(data); break;
      case 'call.bridged': console.log('Telnyx confirms bridge for:', callId); break;

      case 'call.speak.started':
      case 'call.speak.ended':
      case 'call.gather.ended':
        break;

      default:
        if (event) console.log('Unhandled event:', event);
    }
  } catch (e) {
    console.error('Webhook error:', e);
  }

  res.status(200).send('OK');
});

// -------- Handlers --------
async function onCallInitiated(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const dir = data.payload?.direction || data.direction; // 'incoming' or 'outgoing'
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
    // Outbound leg (likely human rep)
    let linked_customer_call_id = clientState?.customer_call_id || null;
    await upsertCall({
      call_id, direction: 'outbound', from_number, to_number,
      status: 'initiated', start_time, call_type: 'human_representative',
      linked_customer_call_id, human_dial_started_at: start_time
    });
  }
}

async function onCallAnswered(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  await upsertFields(call_id, { status: 'answered' });

  // Determine if this is the human leg
  let isHumanLeg = false;
  let customerCallId = clientState?.customer_call_id || null;

  const rec = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  if (rec?.call_type === 'human_representative') isHumanLeg = true;
  if (!customerCallId && rec?.linked_customer_call_id) customerCallId = rec.linked_customer_call_id;

  if (isHumanLeg && customerCallId) {
    await upsertFields(call_id, { human_answered_at: new Date().toISOString() });
    clearHumanTimeout(customerCallId);

    // Check the customer leg is still active
    const cust = await dbGet('SELECT * FROM calls WHERE call_id = ?', [customerCallId]);
    if (!cust || cust.status === 'completed') {
      await speakToCall(call_id, "Sorry, the caller disconnected just now. Thank you.");
      try { await fetch(`https://api.telnyx.com/v2/calls/${call_id}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {}
      return;
    }

    // *** STAFF GREETING, then BRIDGE ***
    try {
      if (USE_RECORDED_PROMPTS && HUMAN_GREETING_AUDIO_URL) {
        await playbackAudio(call_id, HUMAN_GREETING_AUDIO_URL);
      } else {
        await speakToCall(call_id, "Customer is on the line. Connecting you now.");
      }
    } catch { /* non-fatal */ }

    // Bridge after short, configurable delay (do not wait for speak end webhooks)
    setTimeout(async () => {
      try {
        // re-check that customer still not completed
        const custNow = await dbGet('SELECT status FROM calls WHERE call_id = ?', [customerCallId]);
        if (!custNow || custNow.status === 'completed') return;

        const bridge = await fetch(`https://api.telnyx.com/v2/calls/${customerCallId}/actions/bridge`, {
          method: 'POST', headers: telnyxHeaders(),
          body: JSON.stringify({ call_control_id: call_id })
        });

        if (bridge.ok) {
          await upsertFields(customerCallId, {
            call_type: 'human_connected',
            notes: 'Connected to human representative',
            pending_human_call_id: null
          });
        } else {
          console.error('Bridge failed:', await bridge.text());
          await speakToCall(call_id, "We’re having an issue connecting you. Sorry about that.");
          await speakToCall(customerCallId, "We’re having technical difficulties. Please call back in a few minutes.");
        }
      } catch (err) {
        console.error('Bridge error after greeting:', err);
      }
    }, HUMAN_BRIDGE_GREETING_MS);
  }
}

async function onCallHangup(data, clientState) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const end_time = new Date().toISOString();

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
        // Only play this if they didn't already bridge
        await speakToCall(customerCallId, "Sorry, our representative couldn’t take the call. Please leave your name, phone, address, and details after the beep.");
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
    await upsertFields(call_id, { recording_url: finalUrl });
    await dbRun('COMMIT');
  } catch (e) {
    try { await dbRun('ROLLBACK'); } catch {}
  }

  // best-effort transcription
  transcribeAndStore(call_id, finalUrl).catch(() => {});

  const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  if (call?.status === 'completed' && call?.recording_url) await scheduleZapierWebhook(call_id);
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
      await speakToCall(callId,
        "Please describe your water or flood damage situation after the beep. Include your address and details of the damage. " +
        "When you're done, you can simply hang up."
      );
      break;
    default:
      await speakToCall(callId, "Invalid selection. Please try again.");
      await waitMs(600);
      await playIVRMenu(callId);
  }
}

// -------- Human leg dial & mapping (DB-based) --------
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
      console.error('Failed to call human rep:', await resp.text());
      await speakToCall(customerCallId, "I’m sorry, we couldn’t reach our representative. Please leave a detailed message after the tone.");
      return;
    }

    const json = await resp.json();
    const humanCallId = json?.data?.call_control_id;
    if (!humanCallId) {
      await speakToCall(customerCallId, "I’m sorry, we couldn’t reach our representative.");
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

      console.log(`Human leg timeout; hanging up human and asking customer to leave VM. human: ${humanCallId}`);
      try { await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() }); } catch {}
      await speakToCall(customerCallId, "I’m sorry, our representative is unavailable. Please leave your name, phone number, address, and details about the water damage after the beep.");
      await upsertFields(customerCallId, { pending_human_call_id: null });
    }, 35000);
    humanTimeouts.set(customerCallId, t);

  } catch (e) {
    console.error('connectToHuman error:', e);
    await speakToCall(customerCallId, "We’re having trouble connecting. Please call back in a few minutes or leave a message.");
  }
}

// -------- Zapier (Airtable intake via webhook) --------
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || '';
console.log('Zapier webhook configured:', !!ZAPIER_WEBHOOK_URL, `(${ZAPIER_WEBHOOK_URL ? ZAPIER_WEBHOOK_URL.slice(0, 25) + '…' : ''}`);
console.log(')');

async function scheduleZapierWebhook(callId) {
  try {
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
    const shouldSend =
      (call?.call_type === 'customer_inquiry' || call?.call_type === 'human_connected') &&
      call?.status === 'completed' &&
      call?.recording_url &&
      !call?.zapier_sent;
    console.log('ZAPIER DECISION →', {
      call_id: callId,
      direction: call?.direction || null,
      status: call?.status || null,
      call_type: call?.call_type || null,
      hasRecording: !!call?.recording_url,
      zapier_sent: !!call?.zapier_sent,
      shouldSend
    });
    if (!shouldSend) return;
    setTimeout(async () => { await sendToZapier(callId); }, 3000);
  } catch (e) { console.error('scheduleZapierWebhook error:', e); }
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
      transcript_url: call.transcript_url || null,
      source: 'Water Damage Restoration Phone System',
      lead_source: 'Inbound Phone Call',
      business_phone: call.to_number
    };

    console.log('ZAPIER SEND →', `(${ZAPIER_WEBHOOK_URL ? ZAPIER_WEBHOOK_URL.slice(0, 25) + '…' : ''}`, ')', payload);
    const r = await fetch(ZAPIER_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const bodyText = await r.text();
    console.log('ZAPIER RESP →', 'status:', r.status, 'body:', bodyText);

    if (r.ok) await upsertFields(callId, { zapier_sent: true, zapier_sent_at: new Date().toISOString() });
    else setTimeout(async () => { await sendToZapier(callId); }, 30000);
  } catch (e) {
    console.error('sendToZapier error:', e);
    setTimeout(async () => { await sendToZapier(callId); }, 60000);
  }
}

// -------- Basic routes / health --------
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

// -------- Start --------
async function startServer() {
  try {
    await initDatabase();
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Water Damage Lead System running on port ${PORT}`);
      console.log(`Webhook URL: ${WEBHOOK_BASE_URL}/webhooks/calls`);
      console.log(`Telnyx number: ${TELNYX_PHONE_NUMBER || 'Not set'}`);
      console.log(`Human number: ${HUMAN_PHONE_NUMBER || 'Not set'}`);
      console.log(`Spaces bucket: ${SPACES_BUCKET || '(not set)'}`);
      console.log(`Spaces CDN base: ${SPACES_CDN_BASE || '(not set)'}`);
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
