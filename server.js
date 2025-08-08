import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fetch from 'node-fetch';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';
import AWS from 'aws-sdk';

dotenv.config();

const app = express();
app.use(helmet());
app.use(cors());
app.use(bodyParser.json());
app.use(morgan('combined'));

const PORT = process.env.PORT || 3000;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_NUMBER = process.env.TELNYX_NUMBER;
const HUMAN_PHONE = process.env.HUMAN_PHONE;
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;

const SPACES_BUCKET = process.env.SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION;
const SPACES_KEY = process.env.SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET;
const SPACES_CDN_BASE = process.env.SPACES_CDN_BASE;

// --- AWS S3 config for DigitalOcean Spaces ---
const spacesEndpoint = new AWS.Endpoint(`${SPACES_REGION}.digitaloceanspaces.com`);
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: SPACES_KEY,
  secretAccessKey: SPACES_SECRET
});

// --- Database ---
const dbFile = path.join('/workspace', 'call_records.db');
console.log(`Database path: ${dbFile}`);

let db;
(async () => {
  db = await open({
    filename: dbFile,
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      call_id TEXT PRIMARY KEY,
      phone_number TEXT,
      call_type TEXT,
      recording_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    )
  `);
  console.log('Database PRAGMA settings applied');
  const count = await db.get(`SELECT COUNT(*) as cnt FROM calls`);
  console.log(`Existing calls in DB: ${count.cnt}`);
})();

// --- State maps ---
const activeCalls = new Map();
const pendingByCustomer = new Map(); // customerCallId -> humanCallId
const pendingByHuman = new Map();    // humanCallId   -> customerCallId

// --- Helpers ---
const telnyxHeaders = () => ({
  Authorization: `Bearer ${TELNYX_API_KEY}`,
  'Content-Type': 'application/json'
});

async function upsertFields(callId, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  await db.run(
    `INSERT INTO calls (call_id, ${keys.join(', ')})
     VALUES (?, ${keys.map(() => '?').join(', ')})
     ON CONFLICT(call_id) DO UPDATE SET ${setClause}`,
    [callId, ...values, ...values]
  );
}

async function speakToCall(callId, text) {
  return fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
    method: 'POST',
    headers: telnyxHeaders(),
    body: JSON.stringify({
      payload: text,
      voice: 'female',
      language: 'en-US'
    })
  });
}

async function gatherUsingSpeak(callId, text) {
  return fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_speak`, {
    method: 'POST',
    headers: telnyxHeaders(),
    body: JSON.stringify({
      payload: text,
      voice: 'female',
      language: 'en-US',
      minimum_digits: 1,
      maximum_digits: 1
    })
  });
}

// --- Call flow ---
async function connectToHuman(customerCallId) {
  try {
    const resp = await fetch(`https://api.telnyx.com/v2/calls`, {
      method: 'POST',
      headers: telnyxHeaders(),
      body: JSON.stringify({
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: HUMAN_PHONE,
        from: TELNYX_NUMBER
      })
    });
    const data = await resp.json();
    const humanCallId = data.data.call_control_id;

    await upsertFields(humanCallId, { call_type: 'human_representative' });

    pendingByCustomer.set(customerCallId, humanCallId);
    pendingByHuman.set(humanCallId, customerCallId);

    setTimeout(async () => {
      if (pendingByCustomer.has(customerCallId)) {
        const humanId = pendingByCustomer.get(customerCallId);
        try {
          await fetch(`https://api.telnyx.com/v2/calls/${humanId}/actions/hangup`, {
            method: 'POST',
            headers: telnyxHeaders()
          });
        } catch {}
        await handleHumanNoAnswer(customerCallId);
        pendingByHuman.delete(humanId);
        pendingByCustomer.delete(customerCallId);
      }
    }, 35000);
  } catch (err) {
    console.error('Error connecting to human rep:', err);
    await speakToCall(customerCallId, 'We’re unable to connect you to a representative at the moment.');
  }
}

async function handleHumanNoAnswer(customerCallId) {
  await speakToCall(customerCallId, 'Our representatives are busy at the moment. Please leave a message after the tone.');
}

async function handleHumanRepresentativeAnswered(humanCallId) {
  const customerCallId = pendingByHuman.get(humanCallId);
  if (!customerCallId) {
    await speakToCall(humanCallId, 'Sorry, there was a system error. No customer is waiting. Please hang up.');
    return;
  }
  const bridgeResp = await fetch(`https://api.telnyx.com/v2/calls/${customerCallId}/actions/bridge`, {
    method: 'POST',
    headers: telnyxHeaders(),
    body: JSON.stringify({ call_control_id: humanCallId })
  });
  if (bridgeResp.ok) {
    pendingByHuman.delete(humanCallId);
    pendingByCustomer.delete(customerCallId);
    await upsertFields(customerCallId, {
      call_type: 'human_connected',
      notes: 'Successfully connected to human representative'
    });
  } else {
    await speakToCall(humanCallId, 'I’m sorry, there was a technical issue connecting you to the customer.');
    await speakToCall(customerCallId, 'We’re having technical difficulties. Please call back in a few minutes.');
  }
}

// --- Recording upload ---
async function uploadRecording(callId, url) {
  try {
    const fileResp = await fetch(url);
    const buffer = await fileResp.buffer();
    const key = `recordings/${callId}.mp3`;
    await s3
      .putObject({
        Bucket: SPACES_BUCKET,
        Key: key,
        Body: buffer,
        ACL: 'public-read',
        ContentType: 'audio/mpeg'
      })
      .promise();
    const cdnUrl = `${SPACES_CDN_BASE}/${key}`;
    console.log(`Uploaded recording to Spaces: ${cdnUrl}`);
    await upsertFields(callId, { recording_url: cdnUrl });
    return cdnUrl;
  } catch (err) {
    console.error('Error uploading recording:', err);
    return null;
  }
}

// --- Webhook handler ---
app.post('/webhooks/calls', async (req, res) => {
  const event = req.body.data?.event_type;
  const callId = req.body.data?.payload?.call_control_id;
  console.log(`Webhook: ${event} CallID: ${callId}`);

  switch (event) {
    case 'call.initiated':
      await upsertFields(callId, {
        phone_number: req.body.data.payload.to,
        call_type: 'incoming'
      });
      break;

    case 'call.answered': {
      const existing = await db.get(`SELECT * FROM calls WHERE call_id = ?`, [callId]);
      const isRepLeg =
        [...pendingByCustomer.values()].includes(callId) ||
        existing?.call_type === 'human_representative';
      if (isRepLeg) {
        await handleHumanRepresentativeAnswered(callId);
      } else {
        await gatherUsingSpeak(callId, 'Press 1 to speak to a representative, or 2 to leave a message.');
      }
      break;
    }

    case 'call.dtmf.received':
      if (req.body.data.payload.digits === '1') {
        await connectToHuman(callId);
      } else if (req.body.data.payload.digits === '2') {
        await speakToCall(callId, 'Please leave your message after the tone.');
      }
      break;

    case 'call.hangup':
      if (pendingByCustomer.has(callId)) {
        const humanId = pendingByCustomer.get(callId);
        pendingByCustomer.delete(callId);
        pendingByHuman.delete(humanId);
        try {
          await fetch(`https://api.telnyx.com/v2/calls/${humanId}/actions/hangup`, {
            method: 'POST',
            headers: telnyxHeaders()
          });
        } catch {}
      }
      if (pendingByHuman.has(callId)) {
        const custId = pendingByHuman.get(callId);
        pendingByHuman.delete(callId);
        pendingByCustomer.delete(custId);
      }
      break;

    case 'call.recording.saved': {
      const recUrl = req.body.data.payload.recording_urls.mp3;
      const cdnUrl = await uploadRecording(callId, recUrl);
      if (ZAPIER_WEBHOOK_URL && cdnUrl) {
        await fetch(ZAPIER_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            call_id: callId,
            recording_url: cdnUrl
          })
        });
        console.log(`Successfully sent call to Zapier: ${callId}`);
      }
      break;
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Water Damage Lead System running on port ${PORT}`);
  console.log(`Webhook URL: ${process.env.PUBLIC_WEBHOOK_URL || 'Not set'}`);
  console.log(`Telnyx number: ${TELNYX_NUMBER}`);
  console.log(`Human number: ${HUMAN_PHONE || 'Not set'}`);
  console.log(`Spaces bucket: ${SPACES_BUCKET}`);
  console.log(`Spaces CDN base: ${SPACES_CDN_BASE}`);
});
