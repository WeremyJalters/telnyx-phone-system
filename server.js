// server.js
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Optional recorded prompts (can enable later) ---
const USE_RECORDED_PROMPTS = String(process.env.USE_RECORDED_PROMPTS || 'false').toLowerCase() === 'true';
const GREETING_AUDIO_URL = process.env.GREETING_AUDIO_URL || '';
const MENU_AUDIO_URL = process.env.MENU_AUDIO_URL || '';
const HUMAN_GREETING_AUDIO_URL = process.env.HUMAN_GREETING_AUDIO_URL || '';

// --- DigitalOcean Spaces (S3-compatible) ---
const S3 = new S3Client({
  region: process.env.SPACES_REGION || 'nyc3',
  endpoint: `https://${process.env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com'}`,
  forcePathStyle: false,
  credentials: {
    accessKeyId: process.env.SPACES_KEY || '',
    secretAccessKey: process.env.SPACES_SECRET || ''
  }
});
const SPACES_BUCKET = process.env.SPACES_BUCKET || '';
const SPACES_CDN_BASE = process.env.SPACES_CDN_BASE || '';

// --- DB (sqlite3) + queue ---
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
    )`);
  const count = await dbGet('SELECT COUNT(*) as count FROM calls');
  console.log('Existing calls in DB:', count?.count || 0);
}

// --- UPSERT helpers ---
async function upsertCall(obj) {
  const cols = Object.keys(obj);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter(c => c !== 'call_id').map(c => `${c}=COALESCE(excluded.${c}, ${c})`).join(', ');
  const sql = `INSERT INTO calls (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(call_id) DO UPDATE SET ${updates}`;
  return dbRun(sql, cols.map(c => obj[c]));
}
async function upsertFields(call_id, fields) { return upsertCall({ call_id, ...fields }); }

// --- App + state ---
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const activeCalls = new Map();
const pendingByCustomer = new Map(); // customerCallId -> humanCallId
const pendingByHuman = new Map();    // humanCallId   -> customerCallId

// --- Telnyx helpers ---
function telnyxHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
  };
}
const HUMAN_PHONE_NUMBER = process.env.HUMAN_PHONE_NUMBER || '';
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER || '';
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || '';

const zapTail = ZAPIER_WEBHOOK_URL ? ZAPIER_WEBHOOK_URL.slice(-8) : '(none)';
console.log(`Zapier webhook configured: ${!!ZAPIER_WEBHOOK_URL} (…${zapTail})`);

// Answer + start recording + menu
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
      "Thanks for calling our flood & water damage restoration team. Press 1 for immediate help to reach a representative. Press 2 to leave details and we'll call you back. You can also press 0 to reach a representative.",
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

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Spaces mirror ---
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

// --- Webhook ---
app.post('/webhooks/calls', async (req, res) => {
  const { data } = req.body || {};
  const event = data?.event_type;
  const callId = data?.payload?.call_control_id || data?.call_control_id;
  console.log('Webhook:', event, 'CallID:', callId);

  try {
    switch (event) {
      case 'call.initiated': await handleCallInitiated(data); break;
      case 'call.answered': await handleCallAnswered(data); break;
      case 'call.hangup': await handleCallHangup(data); break;
      case 'call.recording.saved': await handleRecordingSaved(data); break;
      case 'call.dtmf.received': await handleDTMF(data); break;
      case 'call.bridged': console.log('Telnyx confirms bridge for:', callId); break;

      // quiet noise
      case 'call.speak.started':
      case 'call.speak.ended':
      case 'call.gather.ended':
        break;

      default: console.log('Unhandled event:', event);
    }
  } catch (e) { console.error('Webhook error:', e); }

  res.status(200).send('OK');
});

// --- Handlers ---
async function handleCallInitiated(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const dir = data.payload?.direction || data.direction;
  const from_number = data.payload?.from || data.from;
  const to_number = data.payload?.to || data.to;
  const start_time = new Date().toISOString();

  if (dir === 'incoming') {
    await upsertCall({ call_id, direction: 'inbound', from_number, to_number, status: 'initiated', start_time, call_type: 'customer_inquiry' });
    await answerAndIntro(call_id);
  } else {
    await upsertCall({ call_id, direction: 'outbound', from_number, to_number, status: 'initiated', start_time, call_type: 'human_representative', notes: 'Outbound leg to human' });
  }
}

async function handleCallAnswered(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;

  // Capture numbers here too in case 'answered' arrives before 'initiated'
  const from_number = data.payload?.from || data.from;
  const to_number   = data.payload?.to   || data.to;

  await upsertFields(call_id, {
    status: 'answered',
    ...(from_number ? { from_number } : {}),
    ...(to_number   ? { to_number   } : {})
  });

  const existing = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  const isRepLeg = pendingByHuman.has(call_id) || existing?.call_type === 'human_representative';
  if (isRepLeg) await handleHumanRepresentativeAnswered(call_id);

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
  let finalUrl = telnyxUrl;
  try {
    await dbRun('BEGIN IMMEDIATE');
    finalUrl = await mirrorRecordingToSpaces(call_id, telnyxUrl);
    await upsertFields(call_id, { recording_url: finalUrl });
    await dbRun('COMMIT');
  } catch (e) {
    try { await dbRun('ROLLBACK'); } catch {}
  }
  await upsertFields(call_id, { transcript: 'Transcript generation in progress...' });

  // Decide whether to send to Zapier (broadened condition, with logs)
  await scheduleZapierWebhook(call_id);
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

// --- Human call leg ---
async function connectToHuman(customerCallId) {
  try {
    if (!HUMAN_PHONE_NUMBER) {
      await speakToCall(customerCallId, "Sorry, we can't reach a representative right now.");
      return;
    }

    await upsertFields(customerCallId, { call_type: 'human_transfer', notes: 'Customer transferred to human representative' });

    await speakToCall(customerCallId, "Connecting you now. Please remain on the line while we dial our representative.");
    await waitMs(300);

    const resp = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: telnyxHeaders(),
      body: JSON.stringify({
        to: HUMAN_PHONE_NUMBER,
        from: TELNYX_PHONE_NUMBER,
        connection_id: "2755388541746808609", // your Telnyx connection id
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

    pendingByCustomer.set(customerCallId, humanCallId);
    pendingByHuman.set(humanCallId, customerCallId);

    setTimeout(async () => {
      if (pendingByCustomer.has(customerCallId)) {
        const humanId = pendingByCustomer.get(customerCallId);
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
  const customerCallId = pendingByHuman.get(humanCallId);
  if (!customerCallId) {
    await speakToCall(humanCallId, "Sorry, there was a system error. No customer is waiting. Please hang up.");
    return;
  }

  if (USE_RECORDED_PROMPTS && HUMAN_GREETING_AUDIO_URL) {
    await playbackAudio(humanCallId, HUMAN_GREETING_AUDIO_URL);
    await waitMs(1200);
  } else {
    await speakToCall(humanCallId, "A customer is waiting on the line. Connecting you now on a recorded line.");
    await waitMs(600);
  }

  const bridge = await fetch(`https://api.telnyx.com/v2/calls/${customerCallId}/actions/bridge`, {
    method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ call_control_id: humanCallId })
  });

  if (bridge.ok) {
    pendingByHuman.delete(humanCallId);
    pendingByCustomer.delete(customerCallId);
    await upsertFields(customerCallId, { call_type: 'human_connected', notes: 'Successfully connected to human representative' });
  } else {
    await speakToCall(humanCallId, "I’m sorry, there was a technical issue connecting you to the customer.");
    await speakToCall(customerCallId, "We’re having technical difficulties. Please call back in a few minutes.");
  }
}

async function handleHumanNoAnswer(callId) {
  await speakToCall(callId, "I’m sorry, our representative is unavailable. Please leave your name, phone number, address, and details about the water damage after the beep. When you're done, you can hang up.");
}

// --- Helpers for Zap payload ---
function titleCase(s) {
  if (!s) return s;
  return s.replace(/_/g, ' ').replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1));
}
function formatNANP(e164) {
  // Keep it super safe: only format +1XXXXXXXXXX; otherwise return as-is
  const m = /^\+1(\d{10})$/.exec(e164 || '');
  if (!m) return e164;
  const d = m[1];
  return `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}
function buildZapPayload(call) {
  // Original keys (back-compat with your working Zap)
  const original = {
    call_id: call.call_id,
    timestamp: new Date().toISOString(),
    customer_phone: call.from_number,
    call_duration_seconds: call.duration || 0,
    call_start_time: call.start_time,
    call_end_time: call.end_time,
    call_type: call.call_type,
    call_status: call.status,
    recording_url: call.recording_url,
    source: 'Water Damage Restoration Phone System',
    lead_source: 'Inbound Phone Call',
    business_phone: call.to_number
  };

  // Friendly duplicates (for Airtable clarity)
  const friendly = {
    'Call ID': call.call_id,
    'Customer Phone': formatNANP(call.from_number),
    'Business Phone': formatNANP(call.to_number),
    'Recording URL': call.recording_url,
    'Type': titleCase(call.call_type || ''),
    'Status': titleCase(call.status || ''),
    'Duration (sec)': call.duration || 0,
    'Start Time': call.start_time,
    'End Time': call.end_time,
    'Source': 'Water Damage Restoration Phone System',
    'Lead Source': 'Inbound Phone Call'
  };

  // Merge (friendly keys won’t overwrite originals)
  return { ...original, ...friendly };
}

// --- Zapier (broadened condition + stronger logging) ---
async function scheduleZapierWebhook(callId) {
  try {
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);

    const shouldSend =
      call &&
      call.status === 'completed' &&
      !!call.recording_url &&
      !call.zapier_sent &&
      (
        call.direction === 'inbound' ||
        call.call_type === 'customer_inquiry' ||
        call.call_type === 'human_connected' ||
        call.call_type === 'human_transfer'
      );

    console.log('ZAPIER DECISION →', {
      call_id: callId,
      direction: call?.direction,
      status: call?.status,
      call_type: call?.call_type,
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
    if (!ZAPIER_WEBHOOK_URL) {
      console.warn('ZAPIER SEND SKIPPED (no webhook URL configured)');
      return;
    }
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
    if (!call) {
      console.warn('ZAPIER SEND SKIPPED (call not found):', callId);
      return;
    }

    const payload = buildZapPayload(call);
    console.log('ZAPIER SEND → (…' + zapTail + ')', payload);

    const r = await fetch(ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await r.text().catch(() => '');
    console.log('ZAPIER RESP → status:', r.status, 'body:', text.slice(0, 300));

    if (r.ok) {
      await upsertFields(callId, { zapier_sent: true, zapier_sent_at: new Date().toISOString() });
      // Airtable creation log (human-friendly)
      console.log(`[Airtable] ✅ New lead record created → Call: ${payload['Call ID']} | Customer: ${payload['Customer Phone']} | Recording: ${payload['Recording URL']}`);
    } else {
      console.warn('Zapier returned non-200. Will retry in 30s.');
      setTimeout(async () => { await sendToZapier(callId); }, 30000);
    }
  } catch (e) {
    console.error('sendToZapier error:', e);
    setTimeout(async () => { await sendToZapier(callId); }, 60000);
  }
}

// --- Manual re-send to Zapier (helpful for testing) ---
app.post('/api/calls/:callId/send-to-zapier', async (req, res) => {
  try {
    await sendToZapier(req.params.callId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Simple UI endpoints ---
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString(), port: PORT, nodeVersion: process.version }));

// --- Start ---
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
