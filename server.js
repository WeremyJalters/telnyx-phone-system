// server.js
// Water Damage Lead System – durable bridging, Spaces mirroring, Zapier, transcripts
// Refactored; AssemblyAI via webhook; minimal Spaces upload (TXT only)

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Node 18+: global fetch available.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const Config = {
  PORT: Number(process.env.PORT || 3000),

  USE_RECORDED_PROMPTS: String(process.env.USE_RECORDED_PROMPTS || 'false').toLowerCase() === 'true',
  GREETING_AUDIO_URL: process.env.GREETING_AUDIO_URL || '',
  MENU_AUDIO_URL: process.env.MENU_AUDIO_URL || '',
  HUMAN_GREETING_AUDIO_URL: process.env.HUMAN_GREETING_AUDIO_URL || '',
  HUMAN_BRIDGE_GREETING_MS: Number(process.env.HUMAN_BRIDGE_GREETING_MS || 3000),

  TELNYX_API_KEY: process.env.TELNYX_API_KEY || '',
  TELNYX_PHONE_NUMBER: process.env.TELNYX_PHONE_NUMBER || '',
  TELNYX_CONNECTION_ID: process.env.TELNYX_CONNECTION_ID || '2755388541746808609',
  WEBHOOK_BASE_URL: (process.env.WEBHOOK_BASE_URL || '').replace(/\/+$/,''),
  HUMAN_PHONE_NUMBER: process.env.HUMAN_PHONE_NUMBER || '',

  SPACES_KEY: process.env.SPACES_KEY || '',
  SPACES_SECRET: process.env.SPACES_SECRET || '',
  SPACES_REGION: process.env.SPACES_REGION || 'nyc3',
  SPACES_ENDPOINT: process.env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com',
  SPACES_BUCKET: process.env.SPACES_BUCKET || '',
  SPACES_CDN_BASE: (process.env.SPACES_CDN_BASE || '').replace(/\/+$/,''),

  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || '',
  ASSEMBLYAI_WEBHOOK_SECRET: process.env.ASSEMBLYAI_WEBHOOK_SECRET || '',
  ASSEMBLYAI_ENABLE_SUMMARY: String(process.env.ASSEMBLYAI_ENABLE_SUMMARY || 'false').toLowerCase() === 'true',
  ASSEMBLYAI_SPEAKER_COUNT: Number(process.env.ASSEMBLYAI_SPEAKER_COUNT || 0),

  ZAPIER_WEBHOOK_URL: process.env.ZAPIER_WEBHOOK_URL || '',

  DATABASE_PATH: process.env.DATABASE_PATH || join(__dirname, 'call_records.db'),
};

const app = express();

// ---------- utils ----------
const aaiEnabled = () => !!Config.ASSEMBLYAI_API_KEY;
function telnyxHeaders() {
  return { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${Config.TELNYX_API_KEY}` };
}
function waitMs(ms){ return new Promise(r=>setTimeout(r,ms)); }
function b64(json){ return Buffer.from(JSON.stringify(json),'utf8').toString('base64'); }
function parseB64(s){ try{ return JSON.parse(Buffer.from(s||'','base64').toString('utf8')); } catch{ return null; } }
function verifyAAISignature(rawBody, signatureHeader, secret){
  if(!secret||!signatureHeader) return true;
  const [algo,sig]=(signatureHeader||'').split('=',2);
  if(algo!=='sha256'||!sig) return false;
  const h=crypto.createHmac('sha256',secret); h.update(rawBody,'utf8');
  const dig=h.digest('hex');
  try{ return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(dig)); }catch{ return false; }
}

// ---------- Spaces ----------
const S3 = new S3Client({
  region: Config.SPACES_REGION,
  endpoint: `https://${Config.SPACES_ENDPOINT}`,
  forcePathStyle: false,
  credentials: { accessKeyId: Config.SPACES_KEY, secretAccessKey: Config.SPACES_SECRET }
});
async function putPublicObject(key, body, contentType, cache='public, max-age=31536000'){
  if(!Config.SPACES_BUCKET) return null;
  await S3.send(new PutObjectCommand({ Bucket: Config.SPACES_BUCKET, Key: key, Body: body, ContentType: contentType, ACL: 'public-read', CacheControl: cache }));
  return `${Config.SPACES_CDN_BASE}/${key}`;
}

// ---------- DB (queued) ----------
class DatabaseQueue{ constructor(){this.q=[];this.processing=false;} execute(op){return new Promise((resolve,reject)=>{this.q.push({op,resolve,reject});this._run();});} async _run(){if(this.processing)return;this.processing=true;while(this.q.length){const {op,resolve,reject}=this.q.shift();try{resolve(await op());}catch(e){reject(e);}}this.processing=false;if(this.q.length)this._run();}}
const dbQueue=new DatabaseQueue();
const db=new sqlite3.Database(Config.DATABASE_PATH, sqlite3.OPEN_READWRITE|sqlite3.OPEN_CREATE, (err)=>err?console.error('Error opening DB:',err):console.log('Connected to SQLite at:',Config.DATABASE_PATH));
db.serialize(()=>{ db.exec('PRAGMA journal_mode = WAL;'); db.exec('PRAGMA synchronous = NORMAL;'); db.exec('PRAGMA cache_size = 1000;'); db.exec('PRAGMA temp_store = memory;'); db.exec('PRAGMA busy_timeout = 30000;'); db.exec('PRAGMA foreign_keys = ON;'); db.exec('PRAGMA locking_mode = NORMAL;'); console.log('Database PRAGMA settings applied'); });
const dbRun=(sql,params=[])=>dbQueue.execute(()=>new Promise((res,rej)=>{ db.run(sql,params,function(err){ err?rej(err):res({changes:this.changes,lastID:this.lastID}); }); }));
const dbAll=(sql,params=[])=>dbQueue.execute(()=>new Promise((res,rej)=>{ db.all(sql,params,(e,rows)=>e?rej(e):res(rows)); }));
const dbGet=(sql,params=[])=>dbQueue.execute(()=>new Promise((res,rej)=>{ db.get(sql,params,(e,row)=>e?rej(e):res(row)); }));
function normalizedColumns(obj){ const order=['call_id','direction','from_number','to_number','status','start_time','end_time','duration','recording_url','transcript','transcript_url','call_type','customer_info','contractor_info','notes','customer_zip_code','customer_name','lead_quality','zapier_sent','zapier_sent_at','pending_human_call_id','linked_customer_call_id','human_dial_started_at','human_answered_at','created_at']; const cols=[],vals=[]; for(const k of order) if(Object.prototype.hasOwnProperty.call(obj,k)){ cols.push(k); vals.push(obj[k]); } return {cols,vals}; }
async function upsertCall(obj){ if(!obj.call_id) throw new Error('upsertCall requires call_id'); const {cols,vals}=normalizedColumns(obj); const placeholders=cols.map(()=>'?').join(', '); const updates=cols.filter(c=>'call_id'!==c).map(c=>`${c}=COALESCE(excluded.${c}, ${c})`).join(', '); const sql=`INSERT INTO calls (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(call_id) DO UPDATE SET ${updates}`; return dbRun(sql,vals); }
async function upsertFields(call_id,fields){ return upsertCall({call_id,...fields}); }
async function initDatabase(){
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
  const count=await dbGet('SELECT COUNT(*) as count FROM calls'); console.log('Existing calls in DB:',count?.count||0);
}

// ---------- Telnyx helpers ----------
async function playbackAudio(callId,url){ const r=await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`,{method:'POST',headers:telnyxHeaders(),body:JSON.stringify({audio_url:url})}); if(!r.ok) console.error('playback_start failed:',await r.text()); }
async function speakToCall(callId,msg){ const r=await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`,{method:'POST',headers:telnyxHeaders(),body:JSON.stringify({payload:msg,voice:'female',language:'en-US'})}); if(!r.ok) console.error('speak failed:',await r.text()); }
async function gatherUsingSpeak(callId,payload,{min=1,max=1,timeoutMs=12000,term='#'}={}){ const r=await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_speak`,{method:'POST',headers:telnyxHeaders(),body:JSON.stringify({payload,voice:'female',language:'en-US',minimum_digits:min,maximum_digits:max,timeout_millis:timeoutMs,terminating_digit:term})}); if(!r.ok) console.error('gather_using_speak failed:',await r.text()); }
async function gatherUsingAudio(callId,url,{min=1,max=1,timeoutMs=12000,term='#'}={}){ const r=await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_audio`,{method:'POST',headers:telnyxHeaders(),body:JSON.stringify({audio_url:url,minimum_digits:min,maximum_digits:max,timeout_millis:timeoutMs,terminating_digit:term})}); if(!r.ok) console.error('gather_using_audio failed:',await r.text()); }
async function playIVRMenu(callId){
  if(Config.USE_RECORDED_PROMPTS && Config.MENU_AUDIO_URL){ await gatherUsingAudio(callId,Config.MENU_AUDIO_URL,{min:1,max:1,timeoutMs:12000,term:'#'}); }
  else{
    const t="Thanks for calling our flood and water damage restoration team. Press 1 to be connected to a representative now. Press 2 to leave details and we'll call you back. You can also press 0 to reach a representative.";
    await gatherUsingSpeak(callId,t,{min:1,max:1,timeoutMs:12000,term:'#'});
  }
}
async function answerAndIntro(callId){
  try{
    const ans=await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`,{method:'POST',headers:telnyxHeaders(),body:JSON.stringify({})});
    if(!ans.ok){ console.error('Failed to answer:',await ans.text()); return; }
    const rec=await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/record_start`,{method:'POST',headers:telnyxHeaders(),body:JSON.stringify({format:'mp3',channels:'dual'})}).catch(e=>console.error('record_start error',e));
    if(rec && !rec.ok) console.error('record_start HTTP error:',await rec.text());
    if(Config.USE_RECORDED_PROMPTS && Config.GREETING_AUDIO_URL){ await playbackAudio(callId,Config.GREETING_AUDIO_URL); await waitMs(400); }
    await playIVRMenu(callId);
  }catch(e){ console.error('answerAndIntro error:',e); }
}

// ---------- Spaces: mirror Telnyx mp3 ----------
async function mirrorRecordingToSpaces(call_id, telnyxUrl){
  if(!Config.SPACES_BUCKET || !Config.SPACES_CDN_BASE) return telnyxUrl;
  try{
    const resp=await fetch(telnyxUrl); if(!resp.ok) throw new Error(`download ${resp.status}`);
    const buf=Buffer.from(await resp.arrayBuffer());
    const key=`recordings/${call_id}.mp3`;
    const cdn=await putPublicObject(key,buf,'audio/mpeg','public, max-age=31536000, immutable');
    console.log('Uploaded recording to Spaces:',cdn);
    return cdn||telnyxUrl;
  }catch(e){ console.error('mirrorRecordingToSpaces error:',e); return telnyxUrl; }
}

// ---------- AssemblyAI (webhook-based, TXT only to Spaces) ----------
const AAI_WEBHOOK_URL = `${Config.WEBHOOK_BASE_URL}/webhooks/assembly`;
async function createAAIJob(call_id, audioUrl){
  if(!aaiEnabled() || !audioUrl) return;
  const payload={
    audio_url: audioUrl,
    webhook_url: AAI_WEBHOOK_URL,
    webhook_auth_header_name: Config.ASSEMBLYAI_WEBHOOK_SECRET ? 'Authorization' : undefined,
    webhook_auth_header_value: Config.ASSEMBLYAI_WEBHOOK_SECRET ? `Bearer ${Config.ASSEMBLYAI_WEBHOOK_SECRET}` : undefined,
    speaker_labels: true,
    entity_detection: true,
    sentiment_analysis: true,
    summarization: Config.ASSEMBLYAI_ENABLE_SUMMARY,
    content_safety: true,
    pii_redaction: true,
    redact_pii_audio: false,
    redact_pii_policies: ['medical_process','person_name','phone_number','email_address','address'],
    redact_pii_sub: 'entity_type',
    speakers_expected: Config.ASSEMBLYAI_SPEAKER_COUNT > 0 ? Config.ASSEMBLYAI_SPEAKER_COUNT : undefined,
    summary_model: Config.ASSEMBLYAI_ENABLE_SUMMARY ? 'informative' : undefined,
    summary_type: Config.ASSEMBLYAI_ENABLE_SUMMARY ? 'bullets' : undefined,
    metadata: JSON.stringify({ call_id })
  };
  try{
    const r=await fetch('https://api.assemblyai.com/v2/transcript',{method:'POST',headers:{'Authorization':Config.ASSEMBLYAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json();
    if(!r.ok){ console.error('AssemblyAI create error:',j); await upsertFields(call_id,{notes:`AAI create error: ${j.error||r.status}`}); return; }
    console.log('AssemblyAI job created:',j.id);
    await upsertFields(call_id,{notes:`AAI job ${j.id} created`});
  }catch(e){ console.error('AssemblyAI create exception:',e); await upsertFields(call_id,{notes:`AAI create exception: ${e.message}`}); }
}

// ---------- State ----------
const humanTimeouts=new Map(); // customerCallId -> timeout
const pendingBridges=new Map(); // humanCallId -> { customerCallId, readyToBridge:true }
function clearHumanTimeout(customerCallId){ const t=humanTimeouts.get(customerCallId); if(t){ clearTimeout(t); humanTimeouts.delete(customerCallId); }}

// ---------- Webhooks ----------
app.use(express.json());

// Telnyx
app.post('/webhooks/calls', async (req,res)=>{
  const { data } = req.body || {};
  const event = data?.event_type;
  const callId = data?.payload?.call_control_id || data?.call_control_id;
  const clientState = parseB64(data?.payload?.client_state || data?.client_state);
  if(event && callId){ console.log(`🌐 WEBHOOK: ${event} | CallID: ${callId}`); if(clientState) console.log('🌐 CLIENT_STATE:',JSON.stringify(clientState)); }
  try{
    switch(event){
      case 'call.initiated': await onCallInitiated(data,clientState); break;
      case 'call.answered': await onCallAnswered(data,clientState); break;
      case 'call.hangup': await onCallHangup(data,clientState); break;
      case 'call.recording.saved': await onRecordingSaved(data,clientState); break;
      case 'call.dtmf.received': await onDTMF(data); break;
      case 'call.speak.ended': await onSpeakEnded(data,clientState); break;
      case 'call.bridged': console.log('🌉 BRIDGE CONFIRMED'); break;
      default: /* ignore noisy events */ break;
    }
  }catch(e){ console.error('WEBHOOK ERROR:',e); }
  res.status(200).send('OK');
});

// AssemblyAI (TXT only to Spaces)
app.post('/webhooks/assembly', express.text({ type: '*/*' }), async (req,res)=>{
  try{
    const raw=req.body||'';
    const sig=req.get('AAI-Signature')||'';
    const auth=req.get('Authorization')||'';
    if(Config.ASSEMBLYAI_WEBHOOK_SECRET){
      const hmacOK=verifyAAISignature(raw,sig,Config.ASSEMBLYAI_WEBHOOK_SECRET);
      const bearerOK=auth===`Bearer ${Config.ASSEMBLYAI_WEBHOOK_SECRET}`;
      if(!hmacOK && !bearerOK) return res.status(401).send('unauthorized');
    }
    const evt=JSON.parse(raw);
    let call_id=null; try{ call_id=evt?.metadata ? JSON.parse(evt.metadata)?.call_id||null : null; }catch{}
    if(!call_id) return res.status(200).send('OK');
    if(evt.status==='error'){ await upsertFields(call_id,{notes:`AAI error: ${evt.error||'unknown'}`}); return res.status(200).send('OK'); }
    if(evt.status!=='completed') return res.status(200).send('OK');

    // Build transcript text (fallback to utterances with speakers)
    let transcriptText=evt.text||'';
    if((!transcriptText || transcriptText.trim().length<5) && Array.isArray(evt.utterances)){
      transcriptText=evt.utterances.map(u=>{
        const sp=(typeof u.speaker==='number')?`Speaker ${u.speaker}`:(u.speaker||'Speaker');
        return `${sp}: ${u.text||''}`;
      }).join('\n');
    }

    // Save TXT only
    let txtUrl=null;
    if(Config.SPACES_BUCKET && Config.SPACES_CDN_BASE){
      const key=`transcripts/${call_id}.txt`;
      try{
        txtUrl = await putPublicObject(key, Buffer.from(transcriptText || evt.text || '','utf8'), 'text/plain; charset=utf-8');
      }catch(e){ console.error('TXT upload failed:',e); }
    }

    await upsertFields(call_id,{ transcript: transcriptText || evt.text || null, transcript_url: txtUrl || null, notes: 'AAI complete' });
    console.log('✅ AAI transcript stored for',call_id,'txt:',txtUrl);
    return res.status(200).send('OK');
  }catch(e){ console.error('AAI webhook error:',e); return res.status(500).send('error'); }
});

// ---------- handlers ----------
async function onSpeakEnded(data){
  const call_id=data?.payload?.call_control_id || data?.call_control_id;
  const b=pendingBridges.get(call_id);
  if(b && b.readyToBridge){ pendingBridges.delete(call_id); await attemptBridge(b.customerCallId,call_id); }
}

async function attemptBridge(customerCallId,humanCallId){
  try{
    const cust=await dbGet('SELECT * FROM calls WHERE call_id = ?',[customerCallId]);
    if(!cust || cust.status==='completed'){
      await speakToCall(humanCallId,"Sorry, the caller disconnected. Thank you.");
      setTimeout(async()=>{ try{ await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`,{method:'POST',headers:telnyxHeaders()}); }catch{} },2000);
      return;
    }
    const r=await fetch(`https://api.telnyx.com/v2/calls/${customerCallId}/actions/bridge`,{method:'POST',headers:telnyxHeaders(),body:JSON.stringify({call_control_id:humanCallId})});
    if(r.ok){
      await upsertFields(customerCallId,{ call_type:'human_connected', notes:'Connected to human representative', pending_human_call_id:null });
      console.log('✅ BRIDGE SUCCESS');
    }else{
      console.error('BRIDGE FAILED:',await r.text());
      await speakToCall(humanCallId,"We're having an issue connecting you. Sorry about that.");
      await speakToCall(customerCallId,"We're having technical difficulties. Please call back in a few minutes.");
      setTimeout(async()=>{ try{ await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`,{method:'POST',headers:telnyxHeaders()}); }catch{} },3000);
    }
  }catch(e){ console.error('BRIDGE EXCEPTION:',e); try{ await speakToCall(humanCallId,"We're having technical difficulties. Sorry about that."); }catch{} }
}

async function onCallInitiated(data,clientState){
  const call_id=data.payload?.call_control_id || data.call_control_id;
  const dirRaw=data.payload?.direction || data.direction; const direction=dirRaw==='incoming'?'inbound':'outbound';
  const from_number=data.payload?.from || data.from || null;
  const to_number=data.payload?.to || data.to || null;
  const start_time=new Date().toISOString();

  if(direction==='inbound'){
    await upsertCall({ call_id, direction, from_number, to_number, status:'initiated', start_time, call_type:'customer_inquiry' });
    await answerAndIntro(call_id);
  }else{
    const linked_customer_call_id=clientState?.customer_call_id || null;
    const existing=await dbGet('SELECT * FROM calls WHERE call_id = ?',[call_id]);
    if(existing){
      await upsertFields(call_id,{ direction: existing.direction||'outbound', from_number: from_number||existing.from_number||Config.TELNYX_PHONE_NUMBER||null, to_number: to_number||existing.to_number||Config.HUMAN_PHONE_NUMBER||null, status:'initiated', start_time, call_type: existing.call_type||'human_representative', linked_customer_call_id: existing.linked_customer_call_id||linked_customer_call_id });
    }else{
      await upsertCall({ call_id, direction:'outbound', from_number, to_number, status:'initiated', start_time, call_type:'human_representative', linked_customer_call_id });
    }
  }
}

async function onCallAnswered(data,clientState){
  const call_id=data.payload?.call_control_id || data.call_control_id;
  await upsertFields(call_id,{ status:'answered' });

  let rec=await dbGet('SELECT * FROM calls WHERE call_id = ?',[call_id]);
  const customerFromState=clientState?.customer_call_id || null;

  const assumeHuman=rec?.direction==='outbound' || !!customerFromState;
  if(assumeHuman){
    await upsertFields(call_id,{ call_type: rec?.call_type||'human_representative', linked_customer_call_id: rec?.linked_customer_call_id||customerFromState||null, direction: rec?.direction||'outbound' });
    rec=await dbGet('SELECT * FROM calls WHERE call_id = ?',[call_id]);
  }

  let isHuman=rec?.call_type==='human_representative';
  let customerCallId=customerFromState || rec?.linked_customer_call_id || null;
  if(!isHuman && rec?.direction==='outbound' && customerCallId) isHuman=true;
  if(!isHuman && customerFromState) isHuman=true;

  if(isHuman && customerCallId){
    await upsertFields(call_id,{ human_answered_at:new Date().toISOString() });
    clearHumanTimeout(customerCallId);
    const cust=await dbGet('SELECT * FROM calls WHERE call_id = ?',[customerCallId]);
    if(!cust || cust.status==='completed'){
      await speakToCall(call_id,"Sorry, the caller disconnected just now. Thank you.");
      setTimeout(async()=>{ try{ await fetch(`https://api.telnyx.com/v2/calls/${call_id}/actions/hangup`,{method:'POST',headers:telnyxHeaders()}); }catch{} },2000);
      return;
    }
    pendingBridges.set(call_id,{ customerCallId, readyToBridge:true });
    try{
      if(Config.USE_RECORDED_PROMPTS && Config.HUMAN_GREETING_AUDIO_URL){ await playbackAudio(call_id,Config.HUMAN_GREETING_AUDIO_URL); }
      else{ await speakToCall(call_id,"Customer is on the line. Connecting you now."); }
      setTimeout(async()=>{ const still=pendingBridges.get(call_id); if(still&&still.readyToBridge){ pendingBridges.delete(call_id); await attemptBridge(customerCallId,call_id); } }, Config.HUMAN_BRIDGE_GREETING_MS);
    }catch(e){ console.error('Greeting error:',e); setTimeout(()=>attemptBridge(customerCallId,call_id),2000); }
  }
}

async function onCallHangup(data,clientState){
  const call_id=data.payload?.call_control_id || data.call_control_id;
  const end_time=new Date().toISOString();
  const wasPending=pendingBridges.has(call_id); pendingBridges.delete(call_id);

  const rec=await dbGet('SELECT * FROM calls WHERE call_id = ?',[call_id]);
  const wasCustomer=rec?.direction==='inbound' || rec?.call_type==='customer_inquiry';
  const wasHuman=rec?.call_type==='human_representative';

  let duration=null; if(rec?.start_time){ duration=Math.max(0,Math.floor((Date.now()-new Date(rec.start_time).getTime())/1000)); }
  await upsertFields(call_id,{ status:'completed', end_time, duration });

  if(wasCustomer){
    clearHumanTimeout(call_id);
    const h=await dbGet('SELECT pending_human_call_id FROM calls WHERE call_id = ?',[call_id]);
    const humanId=h?.pending_human_call_id;
    if(humanId){ try{ await fetch(`https://api.telnyx.com/v2/calls/${humanId}/actions/hangup`,{method:'POST',headers:telnyxHeaders()}); }catch{} await upsertFields(call_id,{ pending_human_call_id:null }); }
  }

  if(wasHuman){
    const customerCallId=rec?.linked_customer_call_id || clientState?.customer_call_id;
    if(customerCallId){
      const cust=await dbGet('SELECT * FROM calls WHERE call_id = ?',[customerCallId]);
      if(cust && cust.status!=='completed'){
        await speakToCall(customerCallId,"Sorry, our representative couldn't take the call. Please leave your name, phone, address, and details after the beep.");
        await upsertFields(customerCallId,{ pending_human_call_id:null });
      }
    }
  }

  console.log(`🔚 CALL HANGUP ${call_id} | wasCustomer=${!!wasCustomer} wasHuman=${!!wasHuman} pendingBridge=${wasPending}`);
}

async function onRecordingSaved(data){
  const call_id=data.payload?.call_control_id || data.call_control_id;
  const telnyxUrl=data.payload?.recording_urls?.mp3 || data.recording_urls?.mp3;
  let finalUrl=telnyxUrl;
  try{
    await dbRun('BEGIN IMMEDIATE');
    finalUrl=await mirrorRecordingToSpaces(call_id,telnyxUrl);
    await upsertFields(call_id,{ recording_url: finalUrl });
    await dbRun('COMMIT');
  }catch(e){ console.error('recording update failed:',e); try{ await dbRun('ROLLBACK'); }catch{} }

  // Start AAI (webhook handles completion)
  createAAIJob(call_id,finalUrl).catch(e=>console.error('AAI create job error:',e));

  // Zapier decision
  await scheduleZapierWebhook(call_id);
}

async function onDTMF(data){
  const callId=data.payload?.call_control_id || data.call_control_id;
  const digit=data.payload?.digit || data.digit;
  switch(digit){
    case '1':
    case '0':
      await speakToCall(callId,"Connecting you now. Please remain on the line while we dial our representative.");
      await connectToHuman(callId);
      break;
    case '2':
      await speakToCall(callId,"Please describe your water or flood damage situation after the beep. Include your address and details of the damage. When you're done, you can simply hang up.");
      break;
    default:
      await speakToCall(callId,"Invalid selection. Please try again.");
      await waitMs(600); await playIVRMenu(callId);
  }
}

async function connectToHuman(customerCallId){
  try{
    if(!Config.HUMAN_PHONE_NUMBER){ await speakToCall(customerCallId,"Sorry, we can't reach a representative right now."); return; }
    await upsertFields(customerCallId,{ call_type:'human_transfer', notes:'Customer requested human representative' });

    const cs=b64({customer_call_id:customerCallId});
    const resp=await fetch('https://api.telnyx.com/v2/calls',{method:'POST',headers:telnyxHeaders(),body:JSON.stringify({
      to: Config.HUMAN_PHONE_NUMBER,
      from: Config.TELNYX_PHONE_NUMBER,
      connection_id: Config.TELNYX_CONNECTION_ID,
      webhook_url: `${Config.WEBHOOK_BASE_URL}/webhooks/calls`,
      client_state: cs,
      machine_detection: 'disabled',
      timeout_secs: 30
    })});
    if(!resp.ok){ console.error('dial human failed:',await resp.text()); await speakToCall(customerCallId,"I'm sorry, we couldn't reach our representative. Please leave a detailed message after the tone."); return; }
    const json=await resp.json(); const humanCallId=json?.data?.call_control_id;
    if(!humanCallId){ await speakToCall(customerCallId,"I'm sorry, we couldn't reach our representative."); return; }

    const now=new Date().toISOString();
    await upsertFields(customerCallId,{ pending_human_call_id:humanCallId });
    await upsertCall({ call_id:humanCallId, direction:'outbound', from_number:Config.TELNYX_PHONE_NUMBER, to_number:Config.HUMAN_PHONE_NUMBER, status:'initiated', start_time:now, call_type:'human_representative', linked_customer_call_id:customerCallId, human_dial_started_at:now });

    clearHumanTimeout(customerCallId);
    const t=setTimeout(async()=>{
      const row=await dbGet('SELECT status, pending_human_call_id FROM calls WHERE call_id = ?',[customerCallId]);
      if(!row || row.status==='completed') return;
      if(row.pending_human_call_id!==humanCallId) return;
      try{ await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/hangup`,{method:'POST',headers:telnyxHeaders()}); }catch{}
      await speakToCall(customerCallId,"I'm sorry, our representative is unavailable. Please leave your name, phone number, address, and details about the water damage after the beep.");
      await upsertFields(customerCallId,{ pending_human_call_id:null });
    },35000);
    humanTimeouts.set(customerCallId,t);
  }catch(e){ console.error('connectToHuman error:',e); await speakToCall(customerCallId,"We're having trouble connecting. Please call back in a few minutes or leave a message."); }
}

// ---------- Zapier ----------
async function scheduleZapierWebhook(callId){
  try{
    const call=await dbGet('SELECT * FROM calls WHERE call_id = ?',[callId]);
    const shouldSend=!!(call?.recording_url && !call?.zapier_sent && call?.direction==='inbound');
    if(!shouldSend) return;
    setTimeout(async()=>{ await sendToZapier(callId); },3000);
  }catch(e){ console.error('scheduleZapierWebhook error:',e); }
}
async function sendToZapier(callId){
  try{
    if(!Config.ZAPIER_WEBHOOK_URL){ console.log('Zapier not configured'); return; }
    const call=await dbGet('SELECT * FROM calls WHERE call_id = ?',[callId]);
    if(!call) return;
    const payload={
      call_id: call.call_id,
      timestamp: new Date().toISOString(),
      customer_phone: call.from_number,
      call_duration_seconds: call.duration || 0,
      call_start_time: call.start_time,
      call_end_time: call.end_time,
      call_type: call.call_type,
      call_status: call.status,
      recording_url: call.recording_url,
      transcript_url: call.transcript_url || null,   // keep old key for compatibility
      " Transcript URL": call.transcript_url || null, // Airtable field EXACT name (leading space)
      source: 'Water Damage Restoration Phone System',
      lead_source: 'Inbound Phone Call',
      business_phone: call.to_number
    };
    const start=Date.now();
    const r=await fetch(Config.ZAPIER_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),timeout:30000});
    const body=await r.text();
    console.log(`ZAPIER RESP → status: ${r.status}, time: ${Date.now()-start}ms, body: ${body}`);
    if(r.ok){ await upsertFields(callId,{ zapier_sent:true, zapier_sent_at:new Date().toISOString() }); }
    else{ setTimeout(async()=>{ await sendToZapier(callId); },30000); }
  }catch(e){ console.error('Zapier error:',e); setTimeout(async()=>{ await sendToZapier(callId); },60000); }
}

// ---------- Static & Health ----------
app.use(express.static(join(__dirname,'public')));
app.get('/',(req,res)=>res.sendFile(join(__dirname,'public','index.html')));
app.get('/health',(req,res)=>res.json({status:'healthy',timestamp:new Date().toISOString(),port:Config.PORT,nodeVersion:process.version}));

// ---------- Start ----------
async function startServer(){
  try{
    await initDatabase();
    const server=app.listen(Config.PORT,'0.0.0.0',()=>{
      console.log(`Water Damage Lead System running on port ${Config.PORT}`);
      console.log(`Webhook URL (Telnyx): ${Config.WEBHOOK_BASE_URL}/webhooks/calls`);
      console.log(`Webhook URL (AAI):    ${AAI_WEBHOOK_URL}`);
      console.log(`Spaces bucket: ${Config.SPACES_BUCKET||'(not set)'} | CDN: ${Config.SPACES_CDN_BASE||'(not set)'}`);
      console.log(`Telnyx #: ${Config.TELNYX_PHONE_NUMBER||'Not set'} | Human #: ${Config.HUMAN_PHONE_NUMBER||'Not set'}`);
      console.log(`Recorded prompts enabled: ${Config.USE_RECORDED_PROMPTS}`);
      console.log(`Database path: ${Config.DATABASE_PATH}`);
    });
    const shutdown=(sig)=>{ console.log(`${sig} received, shutting down...`); db.close((err)=>{ if(err) console.error('Error closing DB:',err); server.close(()=>process.exit(0)); }); };
    process.on('SIGTERM',()=>shutdown('SIGTERM'));
    process.on('SIGINT',()=>shutdown('SIGINT'));
  }catch(e){ console.error('Failed to start server:',e); process.exit(1); }
}
startServer().catch(console.error);

export default app;
