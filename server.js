import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Telnyx from 'telnyx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Telnyx
const telnyx = new Telnyx(process.env.TELNYX_API_KEY);

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// In-memory storage for demo (use a database in production)
let callHistory = [];
let callStats = {
    total: 0,
    answered: 0,
    missed: 0,
    leads: 0
};

// Routes
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/api/stats', (req, res) => {
    res.json(callStats);
});

app.get('/api/calls', (req, res) => {
    res.json(callHistory.slice(-50)); // Return last 50 calls
});

// Webhook endpoint for Telnyx
app.post('/webhook', async (req, res) => {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    const { event_type, payload } = req.body.data;
    
    try {
        switch (event_type) {
            case 'call.initiated':
                await handleCallInitiated(payload);
                break;
            case 'call.answered':
                await handleCallAnswered(payload);
                break;
            case 'call.hangup':
                await handleCallHangup(payload);
                break;
            case 'call.gather.ended':
                await handleGatherEnded(payload);
                break;
            case 'call.recording.saved':
                await handleRecordingSaved(payload);
                break;
            case 'call.transcription.received':
                await handleTranscriptionReceived(payload);
                break;
            default:
                console.log(`Unhandled event type: ${event_type}`);
        }
    } catch (error) {
        console.error('Error handling webhook:', error);
    }
    
    res.sendStatus(200);
});

async function handleCallInitiated(payload) {
    console.log('Call initiated:', payload.call_control_id);
    
    const callData = {
        id: payload.call_control_id,
        from: payload.from,
        to: payload.to,
        status: 'initiated',
        timestamp: new Date().toISOString(),
        duration: 0
    };
    
    callHistory.unshift(callData);
    callStats.total++;
    
    try {
        // Answer the call
        console.log('Attempting to answer call:', payload.call_control_id);
        await telnyx.calls.answer({
            call_control_id: payload.call_control_id
        });
        
        console.log('Call answered successfully');
        
        // Start recording
        await telnyx.calls.recordStart({
            call_control_id: payload.call_control_id,
            format: 'mp3',
            channels: 'dual'
        });
        
        console.log('Recording started');
        
        // Wait a moment then play IVR menu
        setTimeout(async () => {
            try {
                await playIVRMenu(payload.call_control_id);
            } catch (error) {
                console.error('Error playing IVR menu:', error);
            }
        }, 1000);
        
    } catch (error) {
        console.error('Error answering call:', error);
        console.error('Error details:', error.response?.data || error.message);
    }
}

async function handleCallAnswered(payload) {
    console.log('Call answered event received:', payload.call_control_id);
    
    // Update call history
    const call = callHistory.find(c => c.id === payload.call_control_id);
    if (call) {
        call.status = 'answered';
        call.answeredAt = new Date().toISOString();
    }
    
    callStats.answered++;
}

async function handleCallHangup(payload) {
    console.log('Call hangup:', payload.call_control_id);
    
    // Update call history
    const call = callHistory.find(c => c.id === payload.call_control_id);
    if (call) {
        call.status = 'completed';
        call.hangupCause = payload.hangup_cause;
        call.duration = payload.call_duration || 0;
        call.endedAt = new Date().toISOString();
    }
    
    // Stop recording if it's still active
    try {
        await telnyx.calls.recordStop({
            call_control_id: payload.call_control_id
        });
    } catch (error) {
        console.log('Recording already stopped or call ended');
    }
}

async function playIVRMenu(callId) {
    console.log('Playing IVR menu for call:', callId);
    
    const menuText = `Hello! Thank you for calling Weather Pro Solutions, your trusted roofing and exterior specialists. 
    
    We're here to help with all your roofing needs, from repairs to full replacements, siding, gutters, and storm damage restoration.
    
    Please press 1 to speak with a roofing specialist about a free estimate.
    Press 2 for emergency roof repairs.
    Press 3 to check on an existing project.
    Or stay on the line to leave a detailed message about your roofing needs.`;
    
    try {
        await telnyx.calls.gatherUsingSpeak({
            call_control_id: callId,
            payload: menuText,
            voice: 'female',
            language: 'en-US',
            minimum_digits: 1,
            maximum_digits: 1,
            timeout_millis: 10000,
            invalid_audio_url: null
        });
        
        console.log('IVR menu sent successfully');
        
    } catch (error) {
        console.error('Error playing IVR menu:', error);
        
        // Fallback: just speak the message without gathering input
        try {
            await telnyx.calls.speak({
                call_control_id: callId,
                payload: "Hello! Thank you for calling Weather Pro Solutions. Please hold while we connect you to a specialist, or leave a message after the tone.",
                voice: 'female',
                language: 'en-US'
            });
        } catch (fallbackError) {
            console.error('Fallback speak also failed:', fallbackError);
        }
    }
}

async function handleGatherEnded(payload) {
    console.log('Gather ended:', payload);
    const callId = payload.call_control_id;
    const digits = payload.digits;
    
    try {
        switch (digits) {
            case '1':
                await telnyx.calls.speak({
                    call_control_id: callId,
                    payload: "Thank you for your interest in our roofing services! You'll be connected to a specialist shortly. Please stay on the line to leave details about your project, including your address and the type of service you need.",
                    voice: 'female',
                    language: 'en-US'
                });
                
                // Mark as a qualified lead
                callStats.leads++;
                const call = callHistory.find(c => c.id === callId);
                if (call) {
                    call.leadType = 'roofing_estimate';
                    call.isLead = true;
                }
                break;
                
            case '2':
                await telnyx.calls.speak({
                    call_control_id: callId,
                    payload: "This is our emergency repair line. Please stay on the line and provide details about your roofing emergency, including your location and the nature of the damage. We'll prioritize your call.",
                    voice: 'female',
                    language: 'en-US'
                });
                
                callStats.leads++;
                const emergencyCall = callHistory.find(c => c.id === callId);
                if (emergencyCall) {
                    emergencyCall.leadType = 'emergency_repair';
                    emergencyCall.isLead = true;
                }
                break;
                
            case '3':
                await telnyx.calls.speak({
                    call_control_id: callId,
                    payload: "Thank you for checking on your project. Please leave your name, project address, and any questions you have. We'll get back to you with an update within 24 hours.",
                    voice: 'female',
                    language: 'en-US'
                });
                break;
                
            default:
                await telnyx.calls.speak({
                    call_control_id: callId,
                    payload: "Thank you for calling Weather Pro Solutions. Please leave a detailed message including your name, phone number, address, and the roofing services you're interested in. We'll call you back within 24 hours.",
                    voice: 'female',
                    language: 'en-US'
                });
        }
        
        // Start voicemail recording after the message
        setTimeout(async () => {
            try {
                await startVoicemailRecording(callId);
            } catch (error) {
                console.error('Error starting voicemail recording:', error);
            }
        }, 5000);
        
    } catch (error) {
        console.error('Error handling menu selection:', error);
    }
}

async function startVoicemailRecording(callId) {
    try {
        // Play a beep tone
        await telnyx.calls.playAudio({
            call_control_id: callId,
            audio_url: 'https://www.soundjay.com/misc/sounds/beep-28.wav'
        });
        
        // The call is already being recorded, so we just need to let them talk
        console.log('Voicemail recording active for call:', callId);
        
    } catch (error) {
        console.error('Error starting voicemail:', error);
    }
}

async function handleRecordingSaved(payload) {
    console.log('Recording saved:', payload);
    
    const call = callHistory.find(c => c.id === payload.call_control_id);
    if (call) {
        call.recordingUrl = payload.recording_urls?.mp3;
        call.recordingId = payload.recording_id;
    }
    
    // Request transcription if available
    if (payload.recording_id) {
        try {
            await telnyx.recordings.transcribe({
                recording_id: payload.recording_id
            });
        } catch (error) {
            console.error('Error requesting transcription:', error);
        }
    }
}

async function handleTranscriptionReceived(payload) {
    console.log('Transcription received:', payload);
    
    const call = callHistory.find(c => c.recordingId === payload.recording_id);
    if (call) {
        call.transcription = payload.transcription_text;
        
        // Analyze transcription for lead quality
        const text = payload.transcription_text.toLowerCase();
        if (text.includes('roof') || text.includes('leak') || text.includes('repair') || 
            text.includes('estimate') || text.includes('damage') || text.includes('replace')) {
            call.leadQuality = 'high';
            if (!call.isLead) {
                call.isLead = true;
                callStats.leads++;
            }
        }
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        port: PORT,
        nodeVersion: process.version
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Express error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook URL: ${process.env.WEBHOOK_URL || 'Not set'}`);
    console.log(`Telnyx phone number: ${process.env.TELNYX_PHONE_NUMBER || 'Not set'}`);
    console.log('Server is ready to receive calls!');
});
