// server.js
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ------------------------------------------------------
// Setup
// ------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Optional recorded prompts
const USE_RECORDED_PROMPTS = String(process.env.USE_RECORDED_PROMPTS || 'false').toLowerCase() === 'true';
const GREETING_AUDIO_URL = process.env.GREETING_AUDIO_URL || '';
const MENU_AUDIO_URL = process.env.MENU_AUDIO_URL || '';
const HUMAN_GREETING_AUDIO_URL = process.env.HUMAN_GREETING_AUDIO_URL || '';

// Spaces client (S3-compatible)
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

// ------------------------------------------------------
// SQLite + simple queue
// ------------------------------------------------------
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
    db.run(sql, params, function (err) {
      if (err) { console.error('DB RUN error:', err, sql, params); rej(err); }
      else res({ changes: this.changes, lastID: this.lastID });
    });
  }));
const dbAll = (sql, params = []) =>
  dbQueue.execute(() => new Promise((res, rej) => {
    db.all(sql, params, (err, rows) => err ? (console.error('DB ALL error:', err, sql, params), rej(err)) : res(rows));
  }));
const dbGet = (sql, params = []) =>
  dbQueue.execute(() => new Promise((res, rej) => {
    db.get(sql, params, (err, row) => err ? (console.error('DB GET error:', err, sql, params), rej(err)) : res(row));
  }));

// UPSERT helpers using call_id as unique key
async function upsertCall(call) {
  const cols = Object.keys(call);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter(c => c !== 'call_id').map(c => `${c}=COALESCE(excluded.${c}, ${c})`).join(', ');
  const sql = `INSERT INTO calls (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(call_id) DO UPDATE SET ${updates}`;
  return dbRun(sql, cols.map(c => call[c]));
}
async function upsertFields(call_id, fields) { return upsertCall({ call_id, ...fields }); }

// ------------------------------------------------------
// Express
// ------------------------------------------------------
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// DB schema
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
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE,
      name TEXT,
      address TEXT,
      zip_code TEXT,
      damage_type TEXT,
      urgency TEXT,
      notes TEXT,
      status TEXT DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS contractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE,
      name TEXT,
      company TEXT,
      service_area TEXT,
      specialties TEXT,
      rating REAL,
      availability TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const count = await dbGet('SELECT COUNT(*) as count FROM calls');
  console.log('Existing calls in DB:', count?.count || 0);
}

// ------------------------------------------------------
// Runtime state
// ------------------------------------------------------
const activeCalls = new Map();
const pendingHumanCalls = new Map(); // customerCallId -> humanCallId

// ------------------------------------------------------
// Routes
// ------------------------------------------------------
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

// Telnyx webhook
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
      default: console.log('Unhandled event:', event);
    }
  } catch (e) { console.error('Webhook error:', e); }

  res.status(200).send('OK');
});

// ------------------------------------------------------
// Handlers
// ------------------------------------------------------
async function handleCallInitiated(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const dir = data.payload?.direction || data.direction;
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
      status: 'initiated', start_time, call_type: 'human_representative',
      notes: 'Outbound leg to human'
    });
  }
}

async function handleCallAnswered(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  await upsertFields(call_id, { status: 'answered' });

  const existing = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  const isRepLeg = [...pendingHumanCalls.values()].includes(call_id) || existing?.call_type === 'human_representative';
  if (isRepLeg) await handleHumanRepresentativeAnswered(call_id, existing);

  activeCalls.set(call_id, { status: 'active', startTime: new Date(), participants: 1 });
}

async function handleCallHangup(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const end_time = new Date().toISOString();
  const info = activeCalls.get(call_id);
  const duration = info ? Math.floor((Date.now() - info.startTime.getTime()) / 1000) : null;

  await upsertFields(call_id, { status: 'completed', end_time, duration });
  activeCalls.delete(call_id);

  // If customer hung up while rep ringing
  if (pendingHumanCalls.has(call_id)) {
    const humanId = pendingHumanCalls.get(call_id);
    pendingHumanCalls.delete(call_id);
    try {
      await fetch(`https://api.telnyx.com/v2/calls/${humanId}/actions/hangup`, {
        method: 'POST', headers: telnyxHeaders()
      });
    } catch {}
  }

  try {
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
    if (call && (call.call_type === 'customer_inquiry' || call.call_type === 'human_connected')) {
      await scheduleZapierWebhook(call_id);
    }
  } catch (e) { console.error('hangup schedule zap error:', e); }
}

// Mirror Telnyx temporary URL to Spaces, return permanent CDN URL
async function mirrorRecordingToSpaces(call_id, telnyxUrl) {
  if (!SPACES_BUCKET || !SPACES_CDN_BASE) {
    console.warn('Spaces not fully configured; keeping Telnyx URL.');
    return telnyxUrl;
  }

  try {
    const resp = await fetch(telnyxUrl);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Download failed: ${resp.status} ${txt}`);
    }

    const arrayBuf = await resp.arrayBuffer();
    const body = Buffer.from(arrayBuf);

    const key = `recordings/${call_id}.mp3`;
    const put = new PutObjectCommand({
      Bucket: SPACES_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'audio/mpeg',
      ACL: 'public-read',
      CacheControl: 'public, max-age=31536000, immutable'
    });
    await S3.send(put);

    const cdnUrl = `${SPACES_CDN_BASE.replace(/\/+$/,'')}/${key}`;
    console.log('Uploaded recording to Spaces:', cdnUrl);
    return cdnUrl;
  } catch (err) {
    console.error('mirrorRecordingToSpaces error:', err);
    return telnyxUrl; // fallback (expires) so Zap still gets something
  }
}

async function handleRecordingSaved(data) {
  const call_id = data.payload?.call_control_id || data.call_control_id;
  const telnyxRecordingUrl = data.payload?.recording_urls?.mp3 || data.recording_urls?.mp3;

  let finalRecordingUrl = telnyxRecordingUrl;
  try {
    await dbRun('BEGIN IMMEDIATE');
    finalRecordingUrl = await mirrorRecordingToSpaces(call_id, telnyxRecordingUrl);
    await upsertFields(call_id, { recording_url: finalRecordingUrl });
    await dbRun('COMMIT');
  } catch (e) {
    console.error('recording upsert failed:', e);
    try { await dbRun('ROLLBACK'); } catch {}
  }

  await upsertFields(call_id, { transcript: 'Transcript generation in progress...' });

  const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [call_id]);
  if (call?.status === 'completed' && call?.recording_url) {
    await scheduleZapierWebhook(call_id);
  }
}

async function handleDTMF(data) {
  const callId = data.payload?.call_control_id || data.call_control_id;
  const digit = data.payload?.digit || data.digit;
  try {
    switch (digit) {
      case '1':
      case '0':
        await speakToCall(callId, "Connecting you now. Please remain on the line while we dial our representative.");
        await connectToHuman(callId);
        break;
      case '2':
        await gatherUsingSpeak(
          callId,
          "Please describe your water or flood damage situation after the beep. Include your address and details of the damage. Press pound when finished.",
          { min: 0, max: 0, timeoutMs: 30000, term: '#' }
        );
        break;
      default:
        await speakToCall(callId, "Invalid selection. Please try again.");
        await waitMs(700);
        await playIVRMenu(callId);
    }
  } catch (e) {
    console.error('Error handling DTMF:', e);
  }
}

// ------------------------------------------------------
// Telnyx helper funcs
// ------------------------------------------------------
function telnyxHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
  };
}

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
      await waitMs(800);
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
      "Thank you for calling our flood and water damage restoration team. For immediate help and to speak with a representative, press 1. For general questions about water, flood, or mold restoration, press 2. You can also press 0 to speak with a representative.",
      { min: 1, max: 1, timeoutMs: 12000, term: '#' }
    );
  }
}

async function playbackAudio(callId, audioUrl) {
  try {
    const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
      method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ audio_url: audioUrl })
    });
    if (!r.ok) console.error('playback_start failed:', await r.text());
  } catch (e) { console.error('playbackAudio error:', e); }
}

async function speakToCall(callId, message) {
  try {
    const r = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
      method: 'POST', headers: telnyxHeaders(),
      body: JSON.stringify({ payload: message, voice: 'female', language: 'en-US' })
    });
    if (!r.ok) console.error('speak failed:', await r.text());
  } catch (e) { console.error('speakToCall error:', e); }
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

async function connectToHuman(customerCallId) {
  try {
    const humanPhoneNumber = process.env.HUMAN_PHONE_NUMBER || '+18609389491';

    await upsertFields(customerCallId, { call_type: 'human_transfer', notes: 'Customer transferred to human representative' });

    await speakToCall(customerCallId, "Connecting you now. Please remain on the line while we dial our representative.");
    await waitMs(400);

    const resp = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST', headers: telnyxHeaders(),
      body: JSON.stringify({
        to: humanPhoneNumber,
        from: process.env.TELNYX_PHONE_NUMBER,
        connection_id: "2755388541746808609",
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
      from_number: process.env.TELNYX_PHONE_NUMBER,
      to_number: humanPhoneNumber,
      status: 'initiated',
      start_time: new Date().toISOString(),
      call_type: 'human_representative',
      notes: `Calling representative for customer call ${customerCallId}`
    });
    pendingHumanCalls.set(customerCallId, humanCallId);

    setTimeout(async () => {
      if (pendingHumanCalls.has(customerCallId)) {
        try {
          await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`, { method: 'POST', headers: telnyxHeaders() });
        } catch {}
        await handleHumanNoAnswer(customerCallId);
        pendingHumanCalls.delete(customerCallId);
      }
    }, 35000);
  } catch (e) {
    console.error('connectToHuman error:', e);
    await speakToCall(customerCallId, "We’re having trouble connecting. Please call back in a few minutes or leave a message.");
  }
}

async function handleHumanRepresentativeAnswered(humanCallId) {
  let customerCallId = null;
  for (const [custId, humanId] of pendingHumanCalls) {
    if (humanId === humanCallId) { customerCallId = custId; break; }
  }
  if (!customerCallId) { await speakToCall(humanCallId, "Sorry, no customer is waiting. Please hang up."); return; }

  if (USE_RECORDED_PROMPTS && HUMAN_GREETING_AUDIO_URL) {
    await playbackAudio(humanCallId, HUMAN_GREETING_AUDIO_URL);
    await waitMs(1500);
  } else {
    await speakToCall(humanCallId, "Hello, this is the water damage restoration team. A customer is waiting on the line. Connecting you now on a recorded line.");
    await waitMs(800);
  }

  const bridge = await fetch(`https://api.telnyx.com/v2/calls/${customerCallId}/actions/bridge`, {
    method: 'POST', headers: telnyxHeaders(), body: JSON.stringify({ call_control_id: humanCallId })
  });

  if (bridge.ok) {
    pendingHumanCalls.delete(customerCallId);
    await upsertFields(customerCallId, { call_type: 'human_connected', notes: 'Successfully connected to human representative' });
  } else {
    await speakToCall(humanCallId, "I’m sorry, there was a technical issue connecting you to the customer.");
    await speakToCall(customerCallId, "We’re having technical difficulties. Please call back in a few minutes.");
  }
}

async function handleHumanNoAnswer(callId) {
  await speakToCall(callId, "I’m sorry, our representative is unavailable. Please leave your name, phone number, address, and details about the water damage after the beep. Press pound when you’re finished.");
  await waitMs(800);
  await gatherUsingSpeak(callId, "Please leave your message now. Press pound when finished.", { min: 0, max: 0, timeoutMs: 60000, term: '#' });
}

// ------------------------------------------------------
// Zapier webhook (payload keys unchanged)
// ------------------------------------------------------
async function scheduleZapierWebhook(callId) {
  try {
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
    const shouldSend =
      (call?.call_type === 'customer_inquiry' || call?.call_type === 'human_connected') &&
      call?.status === 'completed' &&
      call?.recording_url &&
      !call?.zapier_sent;

    if (!shouldSend) return;
    setTimeout(async () => { await sendToZapier(callId); }, 5000);
  } catch (e) { console.error('scheduleZapierWebhook error:', e); }
}

async function sendToZapier(callId) {
  try {
    const zapUrl = process.env.ZAPIER_WEBHOOK_URL;
    if (!zapUrl) { console.log('ZAPIER_WEBHOOK_URL not set; skipping.'); return; }

    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
    if (!call) { console.error('sendToZapier: call not found', callId); return; }

    const payload = {
      call_id: call.call_id,
      timestamp: new Date().toISOString(),
      customer_phone: call.from_number,
      customer_name: call.customer_name || 'Name collected during call',
      customer_zip_code: call.customer_zip_code || 'Zip code collected during call',
      call_duration_seconds: call.duration || 0,
      call_start_time: call.start_time,
      call_end_time: call.end_time,
      call_type: call.call_type,
      call_status: call.status,
      recording_url: call.recording_url, // now permanent Spaces CDN link
      transcript: call.transcript,
      lead_quality: call.lead_quality || 'To be determined',
      notes: call.notes || '',
      business_phone: call.to_number,
      source: 'Water Damage Restoration Phone System',
      lead_source: 'Inbound Phone Call'
    };

    const r = await fetch(zapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (r.ok) {
      await upsertFields(callId, { zapier_sent: true, zapier_sent_at: new Date().toISOString() });
      console.log('Successfully sent call to Zapier:', callId);
    } else {
      const txt = await r.text();
      console.error('Zapier error:', txt);
      setTimeout(async () => { await sendToZapier(callId); }, 30000);
    }
  } catch (e) {
    console.error('sendToZapier error:', e);
    setTimeout(async () => { await sendToZapier(callId); }, 60000);
  }
}

// ------------------------------------------------------
// Misc API for your UI
// ------------------------------------------------------
app.post('/api/call-customer', async (req, res) => {
  try {
    const { customerNumber } = req.body;
    const r = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST', headers: telnyxHeaders(),
      body: JSON.stringify({ to: customerNumber, from: process.env.TELNYX_PHONE_NUMBER, webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls' })
    });
    if (!r.ok) throw new Error(`Failed to create call: ${r.status}`);
    const call = await r.json();

    await upsertCall({
      call_id: call.data.call_control_id,
      direction: 'outbound',
      from_number: process.env.TELNYX_PHONE_NUMBER,
      to_number: customerNumber,
      status: 'initiated',
      start_time: new Date().toISOString(),
      call_type: 'customer_followup'
    });

    res.json({ success: true, callId: call.data.call_control_id });
  } catch (e) { console.error('Error making customer call:', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/call-contractor', async (req, res) => {
  try {
    const { contractorNumber, jobDetails } = req.body;
    const r = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST', headers: telnyxHeaders(),
      body: JSON.stringify({ to: contractorNumber, from: process.env.TELNYX_PHONE_NUMBER, webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls' })
    });
    if (!r.ok) throw new Error(`Failed to create call: ${r.status}`);
    const call = await r.json();

    await upsertCall({
      call_id: call.data.call_control_id,
      direction: 'outbound',
      from_number: process.env.TELNYX_PHONE_NUMBER,
      to_number: contractorNumber,
      status: 'initiated',
      start_time: new Date().toISOString(),
      call_type: 'contractor_outreach',
      notes: JSON.stringify(jobDetails || {})
    });

    res.json({ success: true, callId: call.data.call_control_id });
  } catch (e) { console.error('Error making contractor call:', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/calls', async (req, res) => {
  try {
    const { limit = 50, offset = 0, type } = req.query;
    let sql = 'SELECT * FROM calls';
    const params = [];
    if (type) { sql += ' WHERE call_type = ?'; params.push(type); }
    sql += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    const calls = await dbAll(sql, params);
    res.json({ calls, source: 'database', timestamp: new Date().toISOString() });
  } catch (e) { console.error('GET /api/calls error:', e); res.status(500).json({ error: e.message, calls: [], source: 'error' }); }
});

app.get('/api/calls/:callId', async (req, res) => {
  try {
    const { callId } = req.params;
    const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json(call);
  } catch (e) { console.error('GET call details error:', e); res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), port: PORT, nodeVersion: process.version });
});

// ------------------------------------------------------
// Boot
// ------------------------------------------------------
function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startServer() {
  try {
    await initDatabase();
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Water Damage Lead System running on port ${PORT}`);
      console.log(`Webhook URL: ${process.env.WEBHOOK_BASE_URL}/webhooks/calls`);
      console.log(`Telnyx number: ${process.env.TELNYX_PHONE_NUMBER || 'Not set'}`);
      console.log(`Human number: ${process.env.HUMAN_PHONE_NUMBER || 'Not set'}`);
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
