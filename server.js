// server.js
// Water Damage Lead System w/ Telnyx + DigitalOcean Spaces + Zapier + AssemblyAI transcripts
// ESM, Node 18+ (uses built-in fetch)

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

/* -----------------------------
   Optional recorded prompts
----------------------------- */
const USE_RECORDED_PROMPTS = String(process.env.USE_RECORDED_PROMPTS || 'false').toLowerCase() === 'true';
const GREETING_AUDIO_URL = process.env.GREETING_AUDIO_URL || '';
const MENU_AUDIO_URL = process.env.MENU_AUDIO_URL || '';
const HUMAN_GREETING_AUDIO_URL = process.env.HUMAN_GREETING_AUDIO_URL || '';

/* -----------------------------
   DigitalOcean Spaces (S3)
----------------------------- */
const SPACES_REGION   = process.env.SPACES_REGION   || 'nyc3';
const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com';
const SPACES_BUCKET   = process.env.SPACES_BUCKET   || '';
const SPACES_CDN_BASE = (process.env.SPACES_CDN_BASE || '').replace(/\/+$/, '');

const S3 = new S3Client({
  region: SPACES_REGION,
  endpoint: `https://${SPACES_ENDPOINT}`,
  forcePathStyle: false,
  credentials: {
    accessKeyId: process.env.SPACES_KEY || '',
    secretAccessKey: process.env.SPACES_SECRET || ''
  }
});

/* -----------------------------
   DB (sqlite3) + small write queue
----------------------------- */
class DatabaseQueue {
  constructor() { this.q = []; this.processing = false; }
  execute(op) {
    return new Promise((resolve, reject) => {
      this.q.push({ op, resolve, reject });
      this._run();
    });
  }
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

const db = new sqlite3.Database(
  dbPath,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => err ? console.error('Error opening database:', err) : console.log('Connected to SQLite at:', dbPath)
);

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const count = await dbGet('SELECT COUNT(*) as count FROM calls');
  console.log('Existing calls in DB:', count?.count || 0);
}

/* -----------------------------
   UPSERT helpers
----------------------------- */
async function upsertCall(obj) {
  const cols = Object.keys(obj);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter(c => c !== 'call_id').map(c => `${c}=COALESCE(excluded.${c}, ${c})`).join(', ');
  const sql = `INSERT INTO calls (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(call_id) DO UPDATE SET ${updates}`;
  return dbRun(sql, cols.map(c => obj[c]));
}
async function upsertFields(call_id, fields) { return upsertCall({ call_id, ...fields }); }

/* -----------------------------
   App + state
----------------------------- */
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const activeCalls = new Map();
const pendingByCustomer = new Map(); // customerCallId -> humanCallId
const pendingByHuman    = new Map(); // humanCallId    -> customerCallId

// Extra: a tiny “wait for mapping” helper to kill races
async function waitForMapping(humanCallId, maxMs = 5000, stepMs = 150) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (pendingByHuman.has(humanCallId)) return pendingByHuman.get(humanCallId);
    await waitMs(stepMs);
  }
  return null;
}

/* -----------------------------
   Telnyx helpers
----------------------------- */
function telnyxHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
  };
}
const HUMAN_PHONE_NUMBER = process.env.HUMAN_PHONE_NUMBER || '';
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER || '';

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

/* IVR / speaking / gather */
async function answerAndIntro(callId) {
  try {
    const answer = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({})
    });
    if (!answer.ok) { console.error('Failed to answer:', await answer.text()); return; }

    await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/record_start`, {
      method: 'POST', headers: telnyxHeaders(),
      body: JSON.stringify({ format: 'mp3', channels: 'dual' })
    }).catch(() => {});

    if (USE_RECORDED_PROMPTS && GREETING_AUDIO_URL) {
      await playbackAudio(callId, GREETING_AUDIO_URL);
      await waitMs(600);
    }
    await playIVRMenu(callId);
  } catch (e) { console.error('answerAndIntro error:', e); }
}

async function playIVRMenu(callId) {
  if (USE_RECORDED_PROMPTS && MENU_AUDIO_URL) {
    await gatherUsingAudio(callId, MENU_AUDIO_URL, { min: 1, max: 1, timeoutMs: 12000, term: '#' });
  } else {
    await gatherUsingSpeak(
      callId,
      "Thanks for calling our flood and water damage restoration team. Press 1 to reach a representative now. Press 2 to leave details and we’ll call you back. You can also press 0 to reach a representative.",
      { min: 1, max: 1, timeoutMs: 12000, term: '#' }
    );
  }
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

async function gatherUsingSpeak(callId, payload, { min = 1, max = 1, timeoutMs = 10000, term = '#' } = {}) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_speak`, {
    method: 'POST', headers: telnyxHeaders(),
    body: JSON.stringify({ payload, voice: 'female', language: 'en-US', minimum_digits: min, maximum_digits: max, timeout_millis: timeoutMs, terminating_digit: term })
  });
  if (!r.ok) console.error('gather_using_speak failed:', await r.text());
}

async function gatherUsingAudio(callId, audioUrl, { min = 1, max = 1, timeoutMs = 10000, term = '#' } = {}) {
  const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_audio`, {
    method: 'POST', headers: telnyxHeaders(),
    body: JSON.stringify({ audio_url: audioUrl, minimum_digits: min, maximum_digits: max, timeout_millis: timeoutMs, terminating_digit: term })
  });
  if (!r.ok) console.error('gather_using_audio failed:', await r.text());
}

/* -----------------------------
   Spaces helpers
----------------------------- */
async function uploadToSpaces({ key, body, contentType, acl = 'public-read', cache = 'public, max-age=31536000, immutable' }) {
  await S3.send(new PutObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: acl,
    CacheControl: cache
  }));
  return `${SPACES_CDN_BASE}/${key}`.replace(/([^:]\/)\/+/g, '$1');
}

async function mirrorRecordingToSpaces(call_id, telnyxUrl) {
  if (!SPACES_BUCKET || !SPACES_CDN_BASE) return telnyxUrl;
  try {
    const resp = await fetch(telnyxUrl);
    if (!resp.ok) throw new Error(`download ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const key = `recordings/${call_id}.mp3`;
    const cdnUrl = await uploadToSpaces({
      key, body: buf, contentType: 'audio/mpeg'
    });
    console.log('Uploaded recording to Spaces:', cdnUrl);
    return cdnUrl;
  } catch (e) {
    console.error('mirrorRecordingToSpaces error:', e);
    return telnyxUrl;
  }
}

/* -----------------------------
   AssemblyAI transcription (async)
----------------------------- */
const ASSEMBLY_KEY = process.env.ASSEMBLYAI_API_KEY || '';

async function startAssemblyJob(audioUrl) {
  const r = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'authorization': ASSEMBLY_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      language_code: 'en',
      punctuate: true
    })
  });
  if (!r.ok) throw new Error(`AssemblyAI create failed: ${await r.text()}`);
  const j = await r.json();
  return j.id;
}

async function waitForAssembly(id, { maxMinutes = 30, intervalSec = 5 } = {}) {
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    const r = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { 'authorization': ASSEMBLY_KEY }
    });
    if (!r.ok) throw new Error(`AssemblyAI status failed: ${await r.text()}`);
    const j = await r.json();
    if (j.status === 'completed') return j.text || '';
    if (j.status === 'error') throw new Error(`AssemblyAI error: ${j.error || 'unknown'}`);
    await waitMs(intervalSec * 1000);
  }
  throw new Error('AssemblyAI timeout');
}

async function transcribeAndUpload({ call_id, recordingUrl }) {
  if (!ASSEMBLY_KEY) return { transcriptText: null, transcriptUrl: null };

  try {
    const jobId = await startAssemblyJob(recordingUrl);
    const text = await waitForAssembly(jobId);
    const buffer = Buffer.from(text, 'utf8');
    const key = `transcripts/${call_id}.txt`;
    const cdnUrl = await uploadToSpaces({
      key,
      body: buffer,
      contentType: 'text/plain',
      cache: 'public, max-age=31536000'
    });
    return { transcriptText: text, transcriptUrl: cdnUrl };
  } catch (e) {
    console.error('Transcription failed:', e.message || e);
    return { transcriptText: null, transcriptUrl: null };
  }
}

/* -----------------------------
   Zapier
----------------------------- */
const ZAP_URL = process.env.ZAPIER_WEBHOOK_URL || '';
console.log('Zapier webhook configured:', Boolean(ZAP_URL), ZAP_URL ? `(${ZAP_URL.slice(0, 20)}…${ZAP_URL.slice(-7)}/)` : '');

async function sendToZapier(callId) {
  try {
    if (!ZAP_URL) return;
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
    if (!call || call.zapier_sent) return;

    const shouldSend =
      (call.call_type === 'customer_inquiry' || call.call_type === 'human_connected') &&
      call.status === 'completed' &&
      !!call.recording_url;

    console.log('ZAPIER DECISION →', {
      call_id: call.call_id,
      direction: call.direction,
      status: call.status,
      call_type: call.call_type,
      hasRecording: !!call.recording_url,
      zapier_sent: !!call.zapier_sent,
      shouldSend
    });

    if (!shouldSend) return;

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
      business_phone: call.to_number,

      // Friendly duplicates (keeps your Zap working)
      'Caller Phone': call.from_number,
      'Recording URL': call.recording_url,
      'Transcript URL': call.transcript_url || ''
    };

    console.log('ZAPIER SEND →', ZAP_URL ? `(${ZAP_URL.slice(0, 20)}…${ZAP_URL.slice(-7)}/)` : '(no url)', payload);

    const r = await fetch(ZAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const body = await r.text();
    console.log('ZAPIER RESP → status:', r.status, 'body:', body);

    if (r.ok) {
      await upsertFields(callId, { zapier_sent: true, zapier_sent_at: new Date().toISOString() });
    } else {
      setTimeout(() => sendToZapier(callId).catch(() => {}), 30000);
    }
  } catch (e) {
    console.error('sendToZapier error:', e);
    setTimeout(() => sendToZapier(callId).catch(() => {}), 60000);
  }
}

/* -----------------------------
   Webhook
----------------------------- */
app.post('/webhooks/calls', async (req, res) => {
  const { data } = req.body || {};
  const event = data?.event_type;
  const callId = data?.payload?.call_control_id || data?.call_control_id;
  console.log('Webhook:', event, 'CallID:', callId);
  // ACK quickly
  res.status(200).send('OK');

  try {
    switch (event) {
      case 'call.initiated':        await handleCallInitiated(data); break;
      case 'call.answered':         await handleCallAnswered(data);  break;
      case 'call.hangup':           await handleCallHangup(data);    break;
      case 'call.recording.saved':  await handleRecordingSaved(data); break;
      case 'call.dtmf.received':    await handleDTMF(data);          break;
      case 'call.bridged':          console.log('Telnyx confirms bridge for:', callId); break;

      // noise
      case 'call.speak.started':
      case 'call.speak.ended':
      case 'call.gather.ended':
        break;

      default: console.log('Unhandled event:', event);
    }
  } catch (e) { console.error('Webhook error:', e); }
});

/* -----------------------------
   Handlers
----------------------------- */
async function handleCallInitiated(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const dir = data.payload?.direction || data.direction; // usually 'incoming' on inbound
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
    await upsertCall({
      call_id, direction: 'outbound', from_number, to_number,
      status: 'initiated', start_time, call_type: 'human_representative', notes: 'Outbound leg to human'
    });
  }
}

async function handleCallAnswered(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  await upsertFields(call_id, { status: 'answered' });

  const existing = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  const looksLikeRepLeg = existing?.call_type === 'human_representative' || pendingByHuman.has(call_id);

  if (looksLikeRepLeg) {
    await handleHumanRepresentativeAnswered(call_id);
  } else {
    // If we *think* it might be the rep but mapping isn't ready yet, wait briefly and try again.
    const customerIdLate = await waitForMapping(call_id, 5000, 150);
    if (customerIdLate) {
      console.log('Late mapping found for human leg; proceeding to bridge. human:', call_id, 'customer:', customerIdLate);
      await handleHumanRepresentativeAnswered(call_id);
    }
  }

  activeCalls.set(call_id, { status: 'active', startTime: new Date(), participants: 1 });
}

async function handleCallHangup(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const end_time = new Date().toISOString();
  const info = activeCalls.get(call_id);
  const duration = info ? Math.floor((Date.now() - info.startTime.getTime()) / 1000) : null;
  await upsertFields(call_id, { status: 'completed', end_time, duration });
  activeCalls.delete(call_id);

  // customer hung up while rep ringing
  if (pendingByCustomer.has(call_id)) {
    const humanId = pendingByCustomer.get(call_id);
    pendingByCustomer.delete(call_id);
    pendingByHuman.delete(humanId);
    try {
      await fetch(`https://api.telnyx.com/v2/calls/${humanId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() });
    } catch {}
  }
}

async function handleRecordingSaved(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const telnyxUrl = data.payload?.recording_urls?.mp3 || data.recording_urls?.mp3;

  let finalRecordingUrl = telnyxUrl;
  try {
    await dbRun('BEGIN IMMEDIATE');
    finalRecordingUrl = await mirrorRecordingToSpaces(call_id, telnyxUrl);
    await upsertFields(call_id, { recording_url: finalRecordingUrl });
    await dbRun('COMMIT');
  } catch (e) {
    try { await dbRun('ROLLBACK'); } catch {}
  }

  // async pipeline: transcription + Zap
  (async () => {
    let transcriptUrl = null;
    let transcriptText = null;

    if (ASSEMBLY_KEY) {
      const result = await transcribeAndUpload({ call_id, recordingUrl: finalRecordingUrl });
      transcriptUrl = result.transcriptUrl;
      transcriptText = result.transcriptText;
    }

    if (transcriptUrl) {
      await upsertFields(call_id, { transcript: transcriptText, transcript_url: transcriptUrl });
    } else {
      await upsertFields(call_id, { transcript: 'Transcript unavailable', transcript_url: '' });
    }

    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
    if (call?.status === 'completed' && call?.recording_url) {
      await sendToZapier(call_id);
    }
  })().catch((e) => console.error('post-recording pipeline error:', e));
}

async function handleDTMF(data) {
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
      await waitMs(700);
      await playIVRMenu(callId);
  }
}

/* -----------------------------
   Human call leg / bridging
----------------------------- */
async function connectToHuman(customerCallId) {
  try {
    if (!HUMAN_PHONE_NUMBER) {
      await speakToCall(customerCallId, "Sorry, we can't reach a representative right now.");
      return;
    }

    await upsertFields(customerCallId, { call_type: 'human_transfer', notes: 'Customer transferred to human representative' });

    await speakToCall(customerCallId, "Connecting you now. Please remain on the line while we dial our representative.");
    await waitMs(200);

    const resp = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: telnyxHeaders(),
      body: JSON.stringify({
        to: HUMAN_PHONE_NUMBER,
        from: TELNYX_PHONE_NUMBER,
        connection_id: "2755388541746808609", // your existing connection id
        webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls',
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
    const humanCallId = json.data.call_control_id;

    // Insert human leg into DB first…
    await upsertCall({
      call_id: humanCallId,
      direction: 'outbound',
      from_number: TELNYX_PHONE_NUMBER,
      to_number: HUMAN_PHONE_NUMBER,
      status: 'initiated',
      start_time: new Date().toISOString(),
      call_type: 'human_representative',
      notes: `Calling representative for customer call ${customerCallId}`
    });

    // …then immediately set the in-memory mapping (race-proofed by waitForMapping fallback).
    pendingByCustomer.set(customerCallId, humanCallId);
    pendingByHuman.set(humanCallId, customerCallId);

    // safety timeout: if still ringing after 35s, bail out
    setTimeout(async () => {
      if (pendingByCustomer.has(customerCallId)) {
        const humanId = pendingByCustomer.get(customerCallId);
        console.log('Human leg timeout; hanging up human and asking customer to leave VM. human:', humanId);
        try {
          await fetch(`https://api.telnyx.com/v2/calls/${humanId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() });
        } catch {}
        await handleHumanNoAnswer(customerCallId);
        pendingByHuman.delete(humanId);
        pendingByCustomer.delete(customerCallId);
      }
    }, 35000);
  } catch (e) {
    console.error('connectToHuman error:', e);
    await speakToCall(customerCallId, "We’re having trouble connecting. Please call back in a few minutes or leave a message.");
  }
}

async function handleHumanRepresentativeAnswered(humanCallId) {
  // Try fast path
  let customerCallId = pendingByHuman.get(humanCallId);
  if (!customerCallId) {
    // Race fallback: wait up to 5s for mapping to appear
    customerCallId = await waitForMapping(humanCallId, 5000, 150);
  }

  if (!customerCallId) {
    console.warn('Human answered but no customer mapping found after wait. human:', humanCallId);
    await speakToCall(humanCallId, "A customer just disconnected. Sorry for the inconvenience.");
    return;
  }

  if (USE_RECORDED_PROMPTS && HUMAN_GREETING_AUDIO_URL) {
    await playbackAudio(humanCallId, HUMAN_GREETING_AUDIO_URL);
    await waitMs(900);
  } else {
    await speakToCall(humanCallId, "A customer is waiting on the line. Connecting you now on a recorded line.");
    await waitMs(400);
  }

  const bridge = await fetch(`https://api.telnyx.com/v2/calls/${customerCallId}/actions/bridge`, {
    method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ call_control_id: humanCallId })
  });

  if (bridge.ok) {
    console.log('Bridge requested. customer:', customerCallId, 'human:', humanCallId);
    pendingByHuman.delete(humanCallId);
    pendingByCustomer.delete(customerCallId);
    await upsertFields(customerCallId, { call_type: 'human_connected', notes: 'Successfully connected to human representative' });
  } else {
    console.error('Bridge failed:', await bridge.text());
    await speakToCall(humanCallId, "I’m sorry, there was a technical issue connecting you to the customer.");
    await speakToCall(customerCallId, "We’re having technical difficulties. Please call back in a few minutes.");
  }
}

async function handleHumanNoAnswer(callId) {
  await speakToCall(callId, "I’m sorry, our representative is unavailable. Please leave your name, phone number, address, and details about the water damage after the beep. When you're done, you can hang up.");
}

/* -----------------------------
   Simple UI endpoints
----------------------------- */
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString(), port: PORT, nodeVersion: process.version }));

/* -----------------------------
   Start
----------------------------- */
async function startServer() {
  try {
    await initDatabase();
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Water Damage Lead System running on port ${PORT}`);
      console.log(`Webhook URL: ${process.env.WEBHOOK_BASE_URL}/webhooks/calls`);
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
