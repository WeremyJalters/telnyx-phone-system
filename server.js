import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Database operation queue to ensure single-threaded access
class DatabaseQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    async execute(operation) {
        return new Promise((resolve, reject) => {
            this.queue.push({ operation, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            const { operation, resolve, reject } = this.queue.shift();
            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        }

        this.processing = false;
    }
}

const dbQueue = new DatabaseQueue();

// Force single database instance with absolute path and better connection management
const dbPath = process.env.DATABASE_PATH || join(__dirname, 'call_records.db');
console.log('Database path:', dbPath);

// Create database with more explicit settings
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database at:', dbPath);
    }
});

// Enable WAL mode for better concurrency - but make it synchronous for reliability
db.serialize(() => {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = FULL;'); // Changed from NORMAL to FULL for data integrity
    db.exec('PRAGMA cache_size = 1000;');
    db.exec('PRAGMA temp_store = memory;');
    db.exec('PRAGMA busy_timeout = 30000;'); // 30 second timeout for busy database
    db.exec('PRAGMA foreign_keys = ON;'); // Enable foreign key constraints
    db.exec('PRAGMA locking_mode = EXCLUSIVE;'); // Exclusive locking mode
    console.log('Database PRAGMA settings applied');
});

// Promisify database methods with queue
const dbRun = (sql, params = []) => {
    return dbQueue.execute(() => {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) {
                    console.error('Database RUN error:', err, 'SQL:', sql, 'Params:', params);
                    reject(err);
                } else {
                    console.log('Database RUN success:', sql, 'Changes:', this.changes, 'LastID:', this.lastID);
                    resolve({ changes: this.changes, lastID: this.lastID });
                }
            });
        });
    });
};

const dbAll = (sql, params = []) => {
    return dbQueue.execute(() => {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) {
                    console.error('Database ALL error:', err, 'SQL:', sql, 'Params:', params);
                    reject(err);
                } else {
                    console.log('Database ALL success:', sql, 'Rows:', rows.length);
                    resolve(rows);
                }
            });
        });
    });
};

const dbGet = (sql, params = []) => {
    return dbQueue.execute(() => {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) {
                    console.error('Database GET error:', err, 'SQL:', sql, 'Params:', params);
                    reject(err);
                } else {
                    console.log('Database GET success:', sql, 'Found:', !!row);
                    resolve(row);
                }
            });
        });
    });
};

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Initialize database tables
async function initDatabase() {
    console.log('Initializing SQLite database tables...');
    
    try {
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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Calls table initialized');
        
        await dbRun(`
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_number TEXT UNIQUE,
                name TEXT,
                address TEXT,
                damage_type TEXT,
                urgency TEXT,
                notes TEXT,
                status TEXT DEFAULT 'new',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Customers table initialized');
        
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
        console.log('Contractors table initialized');
        
        // Check existing data
        const existingCalls = await dbGet('SELECT COUNT(*) as count FROM calls');
        console.log('Existing calls in database:', existingCalls.count);
        
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    }
}

// Call state management
const activeCalls = new Map();
const conferenceRooms = new Map();

// Routes
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/api/stats', (req, res) => {
    res.json(callStats);
});

// Webhook handler for incoming calls
app.post('/webhooks/calls', async (req, res) => {
    console.log('Raw webhook received:', JSON.stringify(req.body, null, 2));
    
    const { data } = req.body;
    const callId = data.payload?.call_control_id || data.call_control_id;
    console.log('Webhook received:', data.event_type, 'CallID:', callId);
    console.log('Payload:', JSON.stringify(data.payload, null, 2));

    try {
        switch (data.event_type) {
            case 'call.initiated':
                await handleIncomingCall(data);
                break;
            case 'call.answered':
                await handleCallAnswered(data);
                break;
            case 'call.hangup':
                await handleCallHangup(data);
                break;
            case 'call.recording.saved':
                await handleRecordingSaved(data);
                break;
            case 'call.dtmf.received':
                await handleDTMF(data);
                break;
        }
    } catch (error) {
        console.error('Webhook error:', error);
    }

    res.status(200).send('OK');
});

// Handle incoming calls - simplified without memory
async function handleIncomingCall(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    const fromNumber = data.payload?.from || data.from;
    const toNumber = data.payload?.to || data.to;

    console.log('Handling incoming call:', callId, 'from', fromNumber, 'to', toNumber);

    // Store call record in database with explicit transaction
    try {
        console.log('Attempting to insert call record into database...');
        
        const result = await dbRun(`
            INSERT OR REPLACE INTO calls 
            (call_id, direction, from_number, to_number, status, start_time, call_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [callId, 'inbound', fromNumber, toNumber, 'initiated', new Date().toISOString(), 'customer_inquiry']);
        
        console.log('Call record inserted successfully. Row ID:', result?.lastID);
        
        // Verify the insert worked with a fresh query
        const insertedCall = await dbGet('SELECT * FROM calls WHERE call_id = ? ORDER BY id DESC LIMIT 1', [callId]);
        console.log('Verified inserted call:', insertedCall ? `ID: ${insertedCall.id}, Status: ${insertedCall.status}` : 'NOT FOUND');
        
        // Double check total count for debugging
        const totalCount = await dbGet('SELECT COUNT(*) as count FROM calls');
        console.log('Total calls after insert:', totalCount);
        
    } catch (dbError) {
        console.error('Database error inserting call:', dbError);
    }

    try {
        // Answer the call using direct HTTP API
        const answerResponse = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({})
        });

        if (!answerResponse.ok) {
            const errorData = await answerResponse.text();
            console.error('Failed to answer call:', answerResponse.status, errorData);
            return;
        }

        console.log('Call answered successfully');
        
        // Start recording using direct HTTP API
        const recordResponse = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/record_start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                format: 'mp3',
                channels: 'dual'
            })
        });

        if (recordResponse.ok) {
            console.log('Recording started');
        } else {
            console.log('Recording failed, but continuing...');
        }
        
        // Wait a moment then play greeting and gather input
        setTimeout(async () => {
            await playIVRMenu(callId);
        }, 2000);
        
    } catch (error) {
        console.error('Error in handleIncomingCall:', error);
    }
}

// Handle call answered
async function handleCallAnswered(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    
    console.log('Processing call.answered for:', callId);
    
    try {
        // First verify the record exists before updating
        const existingCall = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
        console.log('Found existing call for answered:', !!existingCall, existingCall ? `ID: ${existingCall.id}` : 'NONE');
        
        if (!existingCall) {
            console.error('ERROR: Cannot update answered - call record not found for:', callId);
            return;
        }

        // Check if this is a human representative call (outbound call to human)
        if (existingCall.call_type === 'human_representative') {
            console.log('Human representative answered, connecting to conference');
            await handleHumanRepresentativeAnswered(callId, existingCall);
        }

        const result = await dbRun(`
            UPDATE calls 
            SET status = 'answered'
            WHERE call_id = ?
        `, [callId]);
        
        console.log('Call status updated to answered for:', callId, 'Rows affected:', result?.changes || 0);
        
        if ((result?.changes || 0) === 0) {
            console.error('WARNING: Answered update affected 0 rows for call:', callId);
        }
        
        // Verify the update worked
        const updatedCall = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
        console.log('Verified call status after update:', {
            found: !!updatedCall,
            status: updatedCall?.status
        });
        
    } catch (error) {
        console.error('Error updating call status:', error);
    }

    activeCalls.set(callId, {
        status: 'active',
        startTime: new Date(),
        participants: 1
    });
}

// Handle when human representative answers their phone
async function handleHumanRepresentativeAnswered(humanCallId, humanCallRecord) {
    try {
        console.log('Human representative answered call:', humanCallId);
        
        // Find the conference room for this human call
        let conferenceId = null;
        let customerCallId = null;
        
        for (const [confId, conf] of conferenceRooms) {
            if (conf.human === humanCallId) {
                conferenceId = confId;
                customerCallId = conf.customer;
                break;
            }
        }
        
        if (!conferenceId) {
            console.error('No conference room found for human call:', humanCallId);
            return;
        }
        
        console.log('Found conference room:', conferenceId, 'for customer:', customerCallId);
        
        // Greet the human representative with context
        await speakToCall(humanCallId, "Hello, this is Weather Pro Solutions. You have a customer waiting on the line who needs to speak with a representative. You will now be connected to the customer.");
        
        // Transfer human to the conference room (where customer is waiting)
        setTimeout(async () => {
            const transferResponse = await fetch(`https://api.telnyx.com/v2/calls/${humanCallId}/actions/transfer`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
                },
                body: JSON.stringify({
                    to: `conference:${conferenceId}`
                })
            });

            if (transferResponse.ok) {
                console.log('Human representative transferred to conference successfully');
                
                // Update conference room status
                const conference = conferenceRooms.get(conferenceId);
                if (conference) {
                    conference.status = 'connected';
                    conference.connectedAt = new Date();
                    conferenceRooms.set(conferenceId, conference);
                }
                
                // Update call records
                await dbRun(`
                    UPDATE calls 
                    SET call_type = 'human_connected', notes = 'Successfully connected to human representative'
                    WHERE call_id = ?
                `, [customerCallId]);
                
            } else {
                const errorData = await transferResponse.text();
                console.error('Failed to transfer human to conference:', transferResponse.status, errorData);
                await speakToCall(humanCallId, "I apologize, there was a technical issue connecting you to the customer. Please hang up and we'll try to reach you again.");
            }
        }, 3000); // Give human rep 3 seconds to hear the greeting
        
    } catch (error) {
        console.error('Error handling human representative answer:', error);
    }
}

// Handle DTMF (keypad) input
async function handleDTMF(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    const digit = data.payload?.digit || data.digit;
    
    console.log(`DTMF received: ${digit} for call ${callId}`);

    try {
        switch (digit) {
            case '1':
                // Emergency/Human - immediate connection to live person
                await speakToCall(callId, "Please hold while we connect you with a live representative. You will remain on this recorded line.");
                // Connect to human representative
                await connectToHuman(callId);
                break;
            case '2':
                // General inquiry - collect information
                await collectCustomerInfo(callId);
                break;
            case '0':
                // Speak with representative (same as 1)
                await speakToCall(callId, "Please hold while we connect you with a Weather Pro Solutions representative.");
                await connectToHuman(callId);
                break;
            default:
                // Invalid input - replay menu
                await speakToCall(callId, "Invalid selection. Please try again.");
                setTimeout(async () => {
                    await playIVRMenu(callId);
                }, 2000);
                break;
        }
    } catch (error) {
        console.error('Error handling DTMF:', error);
    }
}

// Helper function to speak to a call
async function speakToCall(callId, message) {
    try {
        const response = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                payload: message,
                voice: 'female',
                language: 'en-US'
            })
        });
        
        if (!response.ok) {
            console.error('Failed to speak to call:', response.status);
        }
    } catch (error) {
        console.error('Error speaking to call:', error);
    }
}

// Collect customer information
async function collectCustomerInfo(callId) {
    try {
        const response = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_speak`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                payload: "Please describe your roofing project or issue after the beep. Include your address and type of service needed. Press pound when finished.",
                voice: 'female',
                language: 'en-US',
                minimum_digits: 0,
                maximum_digits: 0,
                timeout_millis: 30000,
                terminating_digit: '#'
            })
        });
        
        if (!response.ok) {
            console.error('Failed to gather customer info:', response.status);
        }
    } catch (error) {
        console.error('Error gathering customer info:', error);
    }
}

// Connect to human representative
async function connectToHuman(callId) {
    try {
        console.log('Connecting customer to human representative for call:', callId);
        
        // Configuration for human representative
        const humanPhoneNumber = process.env.HUMAN_PHONE_NUMBER || '+18609389491'; // Replace with actual number
        
        if (humanPhoneNumber === '+1234567890') {
            console.error('HUMAN_PHONE_NUMBER not configured in environment variables');
            await speakToCall(callId, "I apologize, but our representative phone number is not configured. Please call back later or leave a voicemail.");
            return;
        }

        // Update call record to show human connection attempt
        await dbRun(`
            UPDATE calls 
            SET call_type = 'human_transfer', notes = 'Customer transferred to human representative'
            WHERE call_id = ?
        `, [callId]);

        // First, tell the customer what's happening
        await speakToCall(callId, "Connecting you now. Please remain on the line while we dial our representative.");

        // Create a conference room for the three-way call
        const conferenceId = `human_${Date.now()}`;
        
        console.log('Creating conference room:', conferenceId);
        
        // Transfer customer to conference room
        const transferResponse = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/transfer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                to: `conference:${conferenceId}`,
                // Keep recording active during transfer
                record: 'record-from-answer'
            })
        });

        if (!transferResponse.ok) {
            const errorData = await transferResponse.text();
            console.error('Failed to transfer customer to conference:', transferResponse.status, errorData);
            await speakToCall(callId, "I apologize, but we're having technical difficulties. Please try calling back in a few minutes.");
            return;
        }

        console.log('Customer transferred to conference successfully');

        // Now call the human representative
        const humanCallResponse = await fetch('https://api.telnyx.com/v2/calls', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                to: humanPhoneNumber,
                from: process.env.TELNYX_PHONE_NUMBER,
                webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls',
                // Automatically transfer to conference when answered
                machine_detection: 'disabled',
                timeout_secs: 30
            })
        });

        if (!humanCallResponse.ok) {
            const errorData = await humanCallResponse.text();
            console.error('Failed to call human representative:', humanCallResponse.status, errorData);
            await speakToCall(callId, "I apologize, but we're unable to reach our representative right now. Please leave a detailed message and we'll call you back shortly.");
            return;
        }

        const humanCall = await humanCallResponse.json();
        const humanCallId = humanCall.data.call_control_id;
        
        console.log('Human representative call initiated:', humanCallId);

        // Store the human call record
        await dbRun(`
            INSERT INTO calls 
            (call_id, direction, from_number, to_number, status, start_time, call_type, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            humanCallId,
            'outbound',
            process.env.TELNYX_PHONE_NUMBER,
            humanPhoneNumber,
            'initiated',
            new Date().toISOString(),
            'human_representative',
            `Calling representative for customer call ${callId}`
        ]);

        // Store conference information
        conferenceRooms.set(conferenceId, {
            customer: callId,
            human: humanCallId,
            created: new Date(),
            type: 'human_transfer'
        });

        // Set up a timeout to handle if human doesn't answer
        setTimeout(async () => {
            const conference = conferenceRooms.get(conferenceId);
            if (conference && conference.status !== 'connected') {
                console.log('Human representative did not answer within timeout');
                await handleHumanNoAnswer(callId, conferenceId);
            }
        }, 35000); // 35 second timeout

    } catch (error) {
        console.error('Error connecting to human representative:', error);
        await speakToCall(callId, "I apologize, but we're experiencing technical difficulties. Please call back in a few minutes or leave a detailed message.");
    }
}

// Handle when human representative doesn't answer
async function handleHumanNoAnswer(callId, conferenceId) {
    try {
        console.log('Human representative did not answer, providing fallback options');
        
        // Remove from conference tracking
        conferenceRooms.delete(conferenceId);
        
        // Speak to the customer with options
        await speakToCall(callId, "I apologize, but our representative is currently unavailable. Please choose from the following options: Press 2 to leave a detailed message about your roofing needs, or stay on the line to hear our main menu again.");
        
        // Set up gather for customer choice
        setTimeout(async () => {
            await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_speak`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
                },
                body: JSON.stringify({
                    payload: "Press 2 to leave a message, or any other key to hear our menu again.",
                    voice: 'female',
                    language: 'en-US',
                    minimum_digits: 1,
                    maximum_digits: 1,
                    timeout_millis: 10000,
                    terminating_digit: '#'
                })
            });
        }, 3000);
        
    } catch (error) {
        console.error('Error handling human no answer:', error);
    }
}

// Play IVR menu (extracted to reusable function)
async function playIVRMenu(callId) {
    try {
        const response = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/gather_using_speak`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                payload: "Thank you for calling Weather Pro Solutions, your trusted roofing and exterior specialists. If you need to speak with a representative immediately, press 1. For general inquiries about roofing, siding, or gutters, press 2. To speak with a representative, press 0.",
                voice: 'female',
                language: 'en-US',
                minimum_digits: 1,
                maximum_digits: 1,
                timeout_millis: 10000,
                terminating_digit: '#'
            })
        });
        
        if (response.ok) {
            console.log('IVR menu played successfully for call:', callId);
        } else {
            console.error('Failed to play IVR menu:', response.status);
        }
    } catch (error) {
        console.error('Error playing IVR menu:', error);
    }
}

// Handle call hangup
async function handleCallHangup(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    const endTime = new Date().toISOString();
    const callInfo = activeCalls.get(callId);
    const duration = callInfo ? Math.floor((new Date() - callInfo.startTime) / 1000) : 0;

    console.log('Processing call.hangup for:', callId, 'Duration:', duration + 's');

    try {
        // First verify the record exists before updating
        const existingCall = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
        console.log('Found existing call for hangup:', !!existingCall, existingCall ? `ID: ${existingCall.id}` : 'NONE');
        
        if (!existingCall) {
            console.error('ERROR: Cannot update hangup - call record not found for:', callId);
            return;
        }

        const result = await dbRun(`
            UPDATE calls 
            SET status = 'completed', end_time = ?, duration = ?
            WHERE call_id = ?
        `, [endTime, duration, callId]);
        
        console.log('Call hangup processed for:', callId, 'Rows affected:', result?.changes || 0);
        
        if ((result?.changes || 0) === 0) {
            console.error('WARNING: Hangup update affected 0 rows for call:', callId);
        }
        
        // Verify the update worked
        const updatedCall = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
        console.log('Verified call after hangup:', {
            found: !!updatedCall,
            status: updatedCall?.status,
            duration: updatedCall?.duration,
            end_time: updatedCall?.end_time
        });
        
    } catch (error) {
        console.error('Error updating call hangup:', error);
    }

    activeCalls.delete(callId);

    // Clean up any conference rooms
    for (const [confId, conf] of conferenceRooms) {
        if (conf.customer === callId || conf.contractor === callId) {
            conferenceRooms.delete(confId);
            break;
        }
    }
}

// Handle recording saved - simplified
async function handleRecordingSaved(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    const recordingUrl = data.payload?.recording_urls?.mp3 || data.recording_urls?.mp3;
    const recordingId = data.payload?.recording_id || data.recording_id;
    
    console.log('Recording saved for call:', callId);
    console.log('Recording URL:', recordingUrl);
    console.log('Recording ID:', recordingId);
    
    // Try to update database with explicit transaction
    try {
        // First verify the record exists before updating
        const existingCall = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
        console.log('Found existing call for recording:', !!existingCall, existingCall ? `ID: ${existingCall.id}` : 'NONE');
        
        if (!existingCall) {
            console.error('ERROR: Cannot update recording - call record not found for:', callId);
            return;
        }

        await dbRun('BEGIN IMMEDIATE');
        
        const result = await dbRun(`
            UPDATE calls 
            SET recording_url = ?
            WHERE call_id = ?
        `, [recordingUrl, callId]);
        
        await dbRun('COMMIT');
        
        console.log('Database updated with recording URL, rows affected:', result?.changes || 0);
        
        if ((result?.changes || 0) === 0) {
            console.error('WARNING: Recording update affected 0 rows for call:', callId);
        }
        
        // Verify the update worked
        const updatedCall = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
        console.log('Updated call record - has recording URL:', {
            found: !!updatedCall,
            hasRecording: !!updatedCall?.recording_url
        });
        
    } catch (error) {
        console.error('Database update failed:', error);
        try {
            await dbRun('ROLLBACK');
        } catch (rollbackError) {
            console.error('Error rolling back transaction:', rollbackError);
        }
    }

    // Generate transcript
    await generateTranscript(callId, recordingUrl);
}

// Generate transcript using speech-to-text service
async function generateTranscript(callId, recordingUrl) {
    try {
        // You'll need to integrate with a speech-to-text service like:
        // - Google Cloud Speech-to-Text
        // - AWS Transcribe
        // - Azure Speech Services
        // - AssemblyAI
        
        console.log(`Transcript generation requested for call ${callId}`);
    } catch (error) {
        console.error('Transcript generation error:', error);
    }
}

// API Routes
// Make outbound call to customer
app.post('/api/call-customer', async (req, res) => {
    try {
        const { customerNumber, message } = req.body;
        const callResponse = await fetch('https://api.telnyx.com/v2/calls', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                to: customerNumber,
                from: process.env.TELNYX_PHONE_NUMBER,
                webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
            })
        });

        if (!callResponse.ok) {
            throw new Error(`Failed to create call: ${callResponse.status}`);
        }

        const call = await callResponse.json();

        // Store call record
        await dbRun(`
            INSERT INTO calls 
            (call_id, direction, from_number, to_number, status, start_time, call_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, 
        [
            call.data.call_control_id,
            'outbound',
            process.env.TELNYX_PHONE_NUMBER,
            customerNumber,
            'initiated',
            new Date().toISOString(),
            'customer_followup'
        ]);

        res.json({ success: true, callId: call.data.call_control_id });
    } catch (error) {
        console.error('Error making customer call:', error);
        res.status(500).json({ error: error.message });
    }
});

// Make outbound call to contractor
app.post('/api/call-contractor', async (req, res) => {
    try {
        const { contractorNumber, jobDetails } = req.body;
        const callResponse = await fetch('https://api.telnyx.com/v2/calls', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                to: contractorNumber,
                from: process.env.TELNYX_PHONE_NUMBER,
                webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
            })
        });

        if (!callResponse.ok) {
            throw new Error(`Failed to create call: ${callResponse.status}`);
        }

        const call = await callResponse.json();

        await dbRun(`
            INSERT INTO calls 
            (call_id, direction, from_number, to_number, status, start_time, call_type, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, 
        [
            call.data.call_control_id,
            'outbound',
            process.env.TELNYX_PHONE_NUMBER,
            contractorNumber,
            'initiated',
            new Date().toISOString(),
            'contractor_outreach',
            JSON.stringify(jobDetails)
        ]);

        res.json({ success: true, callId: call.data.call_control_id });
    } catch (error) {
        console.error('Error making contractor call:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create three-way call
app.post('/api/three-way-call', async (req, res) => {
    try {
        const { customerNumber, contractorNumber } = req.body;
        
        // Create conference room
        const conferenceId = `conf_${Date.now()}`;

        // Call customer
        const customerCallResponse = await fetch('https://api.telnyx.com/v2/calls', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                to: customerNumber,
                from: process.env.TELNYX_PHONE_NUMBER,
                webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
            })
        });

        // Call contractor
        const contractorCallResponse = await fetch('https://api.telnyx.com/v2/calls', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            },
            body: JSON.stringify({
                to: contractorNumber,
                from: process.env.TELNYX_PHONE_NUMBER,
                webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
            })
        });

        if (!customerCallResponse.ok || !contractorCallResponse.ok) {
            throw new Error('Failed to create conference calls');
        }

        const customerCall = await customerCallResponse.json();
        const contractorCall = await contractorCallResponse.json();

        // Store conference info
        conferenceRooms.set(conferenceId, {
            customer: customerCall.data.call_control_id,
            contractor: contractorCall.data.call_control_id,
            created: new Date()
        });

        res.json({ 
            success: true,
            conferenceId,
            customerCallId: customerCall.data.call_control_id,
            contractorCallId: contractorCall.data.call_control_id
        });
    } catch (error) {
        console.error('Error creating three-way call:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get call records with recording fallback
app.get('/api/calls', async (req, res) => {
    try {
        const { limit = 50, offset = 0, type } = req.query;
        
        // First check if database connection is working
        console.log('API calls endpoint hit - checking database...');
        
        let calls = [];
        let databaseWorking = false;
        
        try {
            // Test database connection with a small delay to ensure any pending writes complete
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const testQuery = await dbGet('SELECT COUNT(*) as count FROM calls');
            console.log('Database test - total calls:', testQuery);
            
            let query = 'SELECT * FROM calls';
            let params = [];

            if (type) {
                query += ' WHERE call_type = ?';
                params.push(type);
            }

            query += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
            params.push(parseInt(limit), parseInt(offset));
            
            console.log('Executing query:', query, 'with params:', params);
            calls = await dbAll(query, params);
            console.log('Query result - found calls:', calls.length);
            databaseWorking = true;
            
            // If we found calls, log them for debugging
            if (calls.length > 0) {
                console.log('Sample call:', JSON.stringify(calls[0], null, 2));
            }
            
        } catch (dbError) {
            console.log('Database not working, using memory fallback:', dbError.message);
            calls = [];
        }
        
        console.log('Final call details count:', calls.length);
        
        res.json({
            calls: calls,
            source: databaseWorking ? 'database' : 'memory',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /api/calls endpoint:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            error: error.message, 
            stack: error.stack,
            calls: [], // Simple fallback
            source: 'error'
        });
    }
});

// Get call details
app.get('/api/calls/:callId', async (req, res) => {
    try {
        const { callId } = req.params;
        const call = await dbGet('SELECT * FROM calls WHERE call_id = ?', [callId]);
        
        if (!call) {
            return res.status(404).json({ error: 'Call not found' });
        }
        
        res.json(call);
    } catch (error) {
        console.error('Error fetching call details:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add customer
app.post('/api/customers', async (req, res) => {
    try {
        const { phoneNumber, name, address, damageType, urgency, notes } = req.body;
        
        await dbRun(`
            INSERT OR REPLACE INTO customers 
            (phone_number, name, address, damage_type, urgency, notes)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [phoneNumber, name, address, damageType, urgency, notes]);

        res.json({ success: true });
    } catch (error) {
        console.error('Error adding customer:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add contractor
app.post('/api/contractors', async (req, res) => {
    try {
        const { phoneNumber, name, company, serviceArea, specialties, rating, availability, notes } = req.body;
        
        await dbRun(`
            INSERT OR REPLACE INTO contractors 
            (phone_number, name, company, service_area, specialties, rating, availability, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [phoneNumber, name, company, serviceArea, specialties, rating, availability, notes]);

        res.json({ success: true });
    } catch (error) {
        console.error('Error adding contractor:', error);
        res.status(500).json({ error: error.message });
    }
});

// Dashboard endpoint
app.get('/api/dashboard', async (req, res) => {
    try {
        console.log('=== DASHBOARD DEBUG START ===');
        
        const totalCalls = await dbGet('SELECT COUNT(*) as count FROM calls');
        console.log('Total calls in DB:', totalCalls);
        
        const todayCalls = await dbGet(`
            SELECT COUNT(*) as count FROM calls 
            WHERE DATE(start_time) = DATE('now')
        `);
        console.log('Today calls:', todayCalls);
        
        const activeCalls = await dbGet(`
            SELECT COUNT(*) as count FROM calls 
            WHERE status = 'answered' OR status = 'initiated'
        `);
        console.log('Active calls:', activeCalls);
        
        const totalCustomers = await dbGet('SELECT COUNT(*) as count FROM customers');
        const totalContractors = await dbGet('SELECT COUNT(*) as count FROM contractors');

        // Also get recent calls for debugging
        const recentCalls = await dbAll('SELECT * FROM calls ORDER BY start_time DESC LIMIT 10');
        console.log('Recent calls for dashboard:', recentCalls);
        
        // Additional debug query to see what's different
        const allCallsDebug = await dbAll('SELECT call_id, status, COUNT(*) as count FROM calls GROUP BY call_id, status');
        console.log('All calls grouped debug:', allCallsDebug);
        
        console.log('=== DASHBOARD DEBUG END ===');

        res.json({
            totalCalls: totalCalls.count,
            todayCalls: todayCalls.count,
            activeCalls: activeCalls.count,
            totalCustomers: totalCustomers.count,  
            totalContractors: totalContractors.count
        });
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve static files for dashboard
app.use(express.static('public'));

// Calls viewer page
app.get('/calls', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Weather Pro Solutions - Call Records</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 30px;
            text-align: center;
        }
        .calls-container {
            background: white;
            border-radius: 10px;
            padding: 30px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .call-record {
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            background: #fafafa;
        }
        .call-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .call-numbers {
            font-size: 18px;
            font-weight: bold;
            color: #333;
        }
        .call-status {
            padding: 6px 12px;
            border-radius: 20px;
            color: white;
            font-size: 12px;
            text-transform: uppercase;
        }
        .status-answered { background-color: #4CAF50; }
        .status-completed { background-color: #2196F3; }
        .status-initiated { background-color: #FF9800; }
        .call-details {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        .detail-item {
            display: flex;
            flex-direction: column;
        }
        .detail-label {
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
            margin-bottom: 5px;
        }
        .detail-value {
            font-weight: bold;
            color: #333;
        }
        .recording-button {
            background: #4CAF50;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            font-size: 14px;
        }
        .recording-button:hover {
            background: #45a049;
        }
        .recording-button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .no-calls {
            text-align: center;
            color: #666;
            font-style: italic;
            padding: 40px;
        }
        .refresh-button {
            background: #2196F3;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            margin-bottom: 20px;
        }
        .refresh-button:hover {
            background: #1976D2;
        }
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📞 Weather Pro Solutions</h1>
        <p>Call Records & Recordings</p>
    </div>

    <div class="calls-container">
        <button class="refresh-button" onclick="loadCalls()">🔄 Refresh Calls</button>
        
        <div id="calls-list" class="loading">
            Loading call records...
        </div>
    </div>

    <script>
        async function loadCalls() {
            const callsList = document.getElementById('calls-list');
            callsList.innerHTML = '<div class="loading">Loading call records...</div>';
            
            try {
                const response = await fetch('/api/calls');
                const data = await response.json();
                const calls = data.calls || [];
                
                if (calls.length === 0) {
                    callsList.innerHTML = '<div class="no-calls">No call records found</div>';
                    return;
                }
                
                let html = '';
                calls.forEach(call => {
                    const startTime = new Date(call.start_time).toLocaleString();
                    const duration = call.duration ? call.duration + 's' : 'N/A';
                    const endTime = call.end_time ? new Date(call.end_time).toLocaleString() : 'N/A';
                    
                    html += \`
                        <div class="call-record">
                            <div class="call-header">
                                <div class="call-numbers">
                                    \${call.from_number} → \${call.to_number}
                                </div>
                                <div class="call-status status-\${call.status}">
                                    \${call.status}
                                </div>
                            </div>
                            
                            <div class="call-details">
                                <div class="detail-item">
                                    <div class="detail-label">Call Type</div>
                                    <div class="detail-value">\${call.call_type || 'N/A'}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">Start Time</div>
                                    <div class="detail-value">\${startTime}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">Duration</div>
                                    <div class="detail-value">\${duration}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">End Time</div>
                                    <div class="detail-value">\${endTime}</div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">Recording</div>
                                    <div class="detail-value">
                                        \${call.recording_url ? 
                                            \`<a href="\${call.recording_url}" target="_blank" class="recording-button">🎵 Play Recording</a>\` :
                                            '<button class="recording-button" disabled>No Recording</button>'
                                        }
                                    </div>
                                </div>
                                <div class="detail-item">
                                    <div class="detail-label">Call ID</div>
                                    <div class="detail-value" style="font-size: 10px; font-family: monospace;">\${call.call_id}</div>
                                </div>
                            </div>
                            
                            \${call.transcript ? \`
                                <div style="margin-top: 15px; padding: 10px; background: #e8f5e8; border-radius: 5px;">
                                    <div class="detail-label">Transcript</div>
                                    <div class="detail-value">\${call.transcript}</div>
                                </div>
                            \` : ''}
                        </div>
                    \`;
                });
                
                callsList.innerHTML = html;
                
            } catch (error) {
                console.error('Error loading calls:', error);
                callsList.innerHTML = \`<div class="no-calls">Error loading calls: \${error.message}</div>\`;
            }
        }
        
        // Load calls when page loads
        loadCalls();
        
        // Auto-refresh every 30 seconds
        setInterval(loadCalls, 30000);
    </script>
</body>
</html>`);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        port: process.env.PORT || 3000,
        nodeVersion: process.version
    });
});

// Database debug endpoint
app.get('/api/debug/db', async (req, res) => {
    try {
        console.log('Database debug endpoint called');
        
        // Test basic database connection
        const totalCalls = await dbGet('SELECT COUNT(*) as count FROM calls');
        console.log('Total calls in DB:', totalCalls);
        
        // Get all calls with all columns
        const allCalls = await dbAll('SELECT * FROM calls ORDER BY id DESC');
        console.log('All calls in database:', allCalls);
        
        // Check table schema
        const schema = await dbAll("PRAGMA table_info(calls)");
        console.log('Calls table schema:', schema);
        
        res.json({
            totalCalls: totalCalls.count,
            calls: allCalls,
            schema: schema,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Database debug error:', error);
        res.status(500).json({ 
            error: error.message, 
            stack: error.stack,
            message: 'Database unavailable'
        });
    }
});

// Recordings endpoint - simple fallback
app.get('/api/recordings', (req, res) => {
    try {
        res.json({
            recordings: [],
            count: 0,
            source: 'disabled',
            message: 'Memory storage disabled for stability',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Configure human representative phone number
app.post('/api/configure-human', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }
        
        // Validate phone number format (basic validation)
        const phoneRegex = /^\+?1?[2-9]\d{2}[2-9]\d{2}\d{4}$/;
        if (!phoneRegex.test(phoneNumber.replace(/\D/g, ''))) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }
        
        // In a production environment, you'd want to store this in database
        // For now, we'll just confirm the environment variable should be set
        console.log('Human representative phone number configured:', phoneNumber);
        
        res.json({ 
            success: true, 
            message: 'Human representative phone number configured successfully',
            phoneNumber: phoneNumber,
            note: 'Make sure to set HUMAN_PHONE_NUMBER environment variable to: ' + phoneNumber
        });
    } catch (error) {
        console.error('Error configuring human phone number:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get current human representative configuration
app.get('/api/human-config', (req, res) => {
    const humanPhoneNumber = process.env.HUMAN_PHONE_NUMBER;
    
    res.json({
        configured: !!humanPhoneNumber && humanPhoneNumber !== '+1234567890',
        phoneNumber: humanPhoneNumber === '+1234567890' ? null : humanPhoneNumber,
        status: humanPhoneNumber === '+1234567890' ? 'not_configured' : 'configured'
    });
});

// Initialize and start server
async function startServer() {
    try {
        console.log('Starting server initialization...');
        
        // Initialize database first
        await initDatabase();
        
        const PORT = process.env.PORT || 3000;
        
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`Telnyx Lead Generation System running on port ${PORT}`);
            console.log(`Webhook URL: ${process.env.WEBHOOK_BASE_URL}/webhooks/calls`);
            console.log(`Telnyx phone number: ${process.env.TELNYX_PHONE_NUMBER || 'Not set'}`);
            console.log(`Database path: ${dbPath}`);
            console.log('Server is ready to receive calls!');
        });

        // Handle graceful shutdown
        process.on('SIGTERM', () => {
            console.log('SIGTERM received, closing database and server...');
            db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err);
                } else {
                    console.log('Database connection closed.');
                }
                server.close(() => {
                    console.log('Server closed.');
                    process.exit(0);
                });
            });
        });

        process.on('SIGINT', () => {
            console.log('SIGINT received, closing database and server...');
            db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err);
                } else {
                    console.log('Database connection closed.');
                }
                server.close(() => {
                    console.log('Server closed.');
                    process.exit(0);
                });
            });
        });
        
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer().catch(console.error);

export default app;
