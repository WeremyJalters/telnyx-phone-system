import express from 'express';
import bodyParser from 'body-parser';
import { promises as fs } from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import Telnyx from 'telnyx';

// Initialize Telnyx with your API key
const telnyx = new Telnyx(process.env.TELNYX_API_KEY);

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize SQLite database
const db = new sqlite3.Database('call_records.db');

// Promisify database methods
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

// Initialize database tables
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
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
}

// Call state management
const activeCalls = new Map();
const conferenceRooms = new Map();

// Webhook handler for incoming calls
app.post('/webhooks/calls', async (req, res) => {
    const { data } = req.body;
    const callId = data.payload?.call_control_id || data.call_control_id;
    console.log('Webhook received:', data.event_type, callId);

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

// Handle incoming calls
async function handleIncomingCall(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    const fromNumber = data.payload?.from || data.from;
    const toNumber = data.payload?.to || data.to;

    console.log('Handling incoming call:', callId, 'from', fromNumber, 'to', toNumber);

    // Store call record
    await dbRun(`
        INSERT OR REPLACE INTO calls 
        (call_id, direction, from_number, to_number, status, start_time, call_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [callId, 'inbound', fromNumber, toNumber, 'initiated', new Date().toISOString(), 'customer_inquiry']);

    // Answer the call
    await telnyx.calls.answer({
        call_control_id: callId
    });
        
    // Start recording
    await telnyx.calls.record_start({
        call_control_id: callId,
        format: 'mp3',
        channels: 'dual'
    });
        
    // Play greeting and gather input
    await telnyx.calls.gather_using_speak({
        call_control_id: callId,
        payload: "Thank you for calling Weather Pro Solutions, your trusted roofing and exterior specialists. If this is an emergency, press 1. For general inquiries about roofing, siding, or gutters, press 2. To speak with a representative, press 0.",
        voice: 'female',
        language: 'en-US',
        minimum_digits: 1,
        maximum_digits: 1,
        timeout_millis: 10000,
        terminating_digit: '#'
    });
}

// Handle call answered
async function handleCallAnswered(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    await dbRun(`
        UPDATE calls 
        SET status = 'answered'
        WHERE call_id = ?
    `, [callId]);

    activeCalls.set(callId, {
        status: 'active',
        startTime: new Date(),
        participants: 1
    });
}

// Handle DTMF (keypad) input
async function handleDTMF(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    const digit = data.payload?.digit || data.digit;
    
    console.log(`DTMF received: ${digit} for call ${callId}`);

    switch (digit) {
        case '1':
            // Emergency - immediate connection
            await telnyx.calls.speak({
                call_control_id: callId,
                payload: "This is an emergency roofing call. Please hold while we connect you with an available contractor for immediate assistance.",
                voice: 'female',
                language: 'en-US'
            });
            // Find and call emergency contractor
            await connectToEmergencyContractor(callId);
            break;
        case '2':
            // General inquiry - collect information
            await collectCustomerInfo(callId);
            break;
        case '0':
            // Speak with representative
            await telnyx.calls.speak({
                call_control_id: callId,
                payload: "Please hold while we connect you with a Weather Pro Solutions representative.",
                voice: 'female',
                language: 'en-US'
            });
            // You would implement your logic to connect to your team
            break;
    }
}

// Collect customer information
async function collectCustomerInfo(callId) {
    await telnyx.calls.gather_using_speak({
        call_control_id: callId,
        payload: "Please describe your roofing project or issue after the beep. Include your address and type of service needed. Press pound when finished.",
        voice: 'female',
        language: 'en-US',
        minimum_digits: 0,
        maximum_digits: 0,
        timeout_millis: 30000,
        terminating_digit: '#'
    });
}

// Connect to emergency contractor
async function connectToEmergencyContractor(callId) {
    try {
        // Get available emergency contractor
        const contractor = await dbGet(`
            SELECT * FROM contractors 
            WHERE availability = 'available'
            AND specialties LIKE '%emergency%'
            ORDER BY rating DESC 
            LIMIT 1
        `);

        if (!contractor) {
            await telnyx.calls.speak({
                call_control_id: callId,
                payload: "I apologize, but no emergency contractors are currently available. We are connecting you to our on-call service.",
                voice: 'female',
                language: 'en-US'
            });
            return;
        }

        // Create conference room
        const conferenceId = `conf_${Date.now()}`;
        conferenceRooms.set(conferenceId, {
            customer: callId,
            contractor: null,
            created: new Date()
        });

        // Add customer to conference
        await telnyx.calls.transfer({
            call_control_id: callId,
            to: `conference:${conferenceId}`
        });

        // Call contractor
        const contractorCall = await telnyx.calls.create({
            to: contractor.phone_number,
            from: process.env.TELNYX_PHONE_NUMBER,
            webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
        });

        // Store contractor call info
        await dbRun(`
            INSERT INTO calls 
            (call_id, direction, from_number, to_number, status, start_time, call_type, contractor_info)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, 
        [
            contractorCall.data.call_control_id,
            'outbound',
            process.env.TELNYX_PHONE_NUMBER,
            contractor.phone_number,
            'initiated',
            new Date().toISOString(),
            'contractor_connect',
            JSON.stringify(contractor)
        ]);

        conferenceRooms.get(conferenceId).contractor = contractorCall.data.call_control_id;

    } catch (error) {
        console.error('Error connecting to contractor:', error);
    }
}

// Handle call hangup
async function handleCallHangup(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    const endTime = new Date().toISOString();
    const callInfo = activeCalls.get(callId);
    const duration = callInfo ? Math.floor((new Date() - callInfo.startTime) / 1000) : 0;

    await dbRun(`
        UPDATE calls 
        SET status = 'completed', end_time = ?, duration = ?
        WHERE call_id = ?
    `, [endTime, duration, callId]);

    activeCalls.delete(callId);

    // Clean up any conference rooms
    for (const [confId, conf] of conferenceRooms) {
        if (conf.customer === callId || conf.contractor === callId) {
            conferenceRooms.delete(confId);
            break;
        }
    }
}

// Handle recording saved
async function handleRecordingSaved(data) {
    const callId = data.payload?.call_control_id || data.call_control_id;
    const recordingUrl = data.payload?.recording_url || data.recording_url;
    
    await dbRun(`
        UPDATE calls 
        SET recording_url = ?
        WHERE call_id = ?
    `, [recordingUrl, callId]);

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
        const call = await telnyx.calls.create({
            to: customerNumber,
            from: process.env.TELNYX_PHONE_NUMBER,
            webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
        });

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
        const call = await telnyx.calls.create({
            to: contractorNumber,
            from: process.env.TELNYX_PHONE_NUMBER,
            webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
        });

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
        const customerCall = await telnyx.calls.create({
            to: customerNumber,
            from: process.env.TELNYX_PHONE_NUMBER,
            webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
        });

        // Call contractor
        const contractorCall = await telnyx.calls.create({
            to: contractorNumber,
            from: process.env.TELNYX_PHONE_NUMBER,
            webhook_url: process.env.WEBHOOK_BASE_URL + '/webhooks/calls'
        });

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

// Get call records
app.get('/api/calls', async (req, res) => {
    try {
        const { limit = 50, offset = 0, type } = req.query;
        let query = 'SELECT * FROM calls';
        let params = [];

        if (type) {
            query += ' WHERE call_type = ?';
            params.push(type);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));
        
        const calls = await dbAll(query, params);
        res.json(calls);
    } catch (error) {
        console.error('Error fetching calls:', error);
        res.status(500).json({ error: error.message });
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
        const totalCalls = await dbGet('SELECT COUNT(*) as count FROM calls');
        const todayCalls = await dbGet(`
            SELECT COUNT(*) as count FROM calls 
            WHERE DATE(created_at) = DATE('now')
        `);
        const activeCalls = await dbGet(`
            SELECT COUNT(*) as count FROM calls 
            WHERE status = 'answered'
        `);
        const totalCustomers = await dbGet('SELECT COUNT(*) as count FROM customers');
        const totalContractors = await dbGet('SELECT COUNT(*) as count FROM contractors');

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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        port: process.env.PORT || 3000,
        nodeVersion: process.version
    });
});

// Initialize and start server
async function startServer() {
    await initDatabase();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Telnyx Lead Generation System running on port ${PORT}`);
        console.log(`Webhook URL: ${process.env.WEBHOOK_BASE_URL}/webhooks/calls`);
        console.log('Server is ready to receive calls!');
    });
}

startServer().catch(console.error);

export default app;
