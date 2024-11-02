const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeInMemoryStore } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require('pino');
const NodeCache = require('node-cache');
const chalk = require('chalk');
const axios = require('axios');

// Import custom modules
const { setupAntidelete } = require('../Antidelete');
const antilinkCommand = require('../Commands/Bot/antilink');
const chatbotModule = require('../Commands/Bot/bot');
// const listonlineCommand = require('../Commands/Admin/listonline');
const { kordMsg } = require('../Plugin/kordMsg');
const { initializeKordEvents } = require('../Plugin/kordEvent');
const { loadCommands } = require('../Plugin/kordLoadCmd');
const { againstEventManager } = require('../Plugin/kordEventHandle');

// Constants
const SESSION_DIR = path.join(__dirname, '..','Session');
const STORE_FILE_PATH = path.join(__dirname, '..', 'store.json');
const LOGGER = pino({ level: process.env.LOG_LEVEL || 'silent' });
const MSG_RETRY_CACHE = new NodeCache();

let messagesSent = 0;
let heartbeatInterval;

// Heartbeat functionality
async function sendHeartbeat() {
    try {
      const botId = global.settings.OWNER_NAME;
        const response = await axios.post('https://kordai-dash.vercel.app/api/status/heartbeat', {
          botId,
          metadata: {
                version: '1.0.0',
                messagesSent,
                uptime: Math.floor(process.uptime()),
                lastActive: new Date().toISOString()
            }
        }, {
            headers: {
                'x-api-key': 'kordAi.key',
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });

        if (response.data.status === 'success') {
            console.log(chalk.green('Heartbeat recorded successfully'));
            console.log(chalk.blue('Last heartbeat:', response.data.data.lastHeartbeat));
        }
    } catch (error) {
        if (error.response) {
            // Handle specific error responses
            const status = error.response.status;
            const message = error.response.data?.message || 'Unknown error';
            
            switch (status) {
                case 400:
                    console.error(chalk.red('Invalid heartbeat data:', message));
                    break;
                case 401:
                    console.error(chalk.red('Authentication failed. Check API key'));
                    break;
                case 500:
                    console.error(chalk.red('Server error:', message));
                    break;
                default:
                    console.error(chalk.red(`Heartbeat failed (${status}):`, message));
            }
        } else if (error.request) {
            console.error(chalk.red('No response from heartbeat server'));
        } else {
            console.error(chalk.red('Error sending heartbeat:', error.message));
        }
    }
}

let heartbeatFailures = 0;
const MAX_FAILURES = 3;
const RETRY_DELAY = 5000; // 5 seconds

async function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    
    heartbeatFailures = 0;

    // Initial heartbeat
    const attemptInitialHeartbeat = async () => {
        try {
            await sendHeartbeat();
            console.log(chalk.green('Initial heartbeat established'));
            heartbeatFailures = 0;
        } catch (error) {
            heartbeatFailures++;
            if (heartbeatFailures < MAX_FAILURES) {
                console.log(chalk.yellow(`Retrying initial heartbeat (${heartbeatFailures}/${MAX_FAILURES})...`));
                setTimeout(attemptInitialHeartbeat, RETRY_DELAY);
                return;
            }
            console.error(chalk.red('Failed to establish initial heartbeat'));
        }
    };

    await attemptInitialHeartbeat();

    // Regular heartbeat interval
    heartbeatInterval = setInterval(async () => {
        try {
            await sendHeartbeat();
            heartbeatFailures = 0;
        } catch (error) {
            heartbeatFailures++;
            if (heartbeatFailures >= MAX_FAILURES) {
                console.error(chalk.red('Multiple heartbeat failures detected, stopping heartbeat service'));
                await stopHeartbeat();
            }
        }
    }, 5 * 60 * 1000); // 5 minutes
}

async function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        console.log(chalk.yellow('Heartbeat service stopped'));
        
        // Send final status update
        try {
        const botIdd = global.settings.OWNER_NAME;
            await axios.post('https://kordai-dash.vercel.app/api/status/heartbeat', {
                botIdd,
                metadata: {
                    version: '1.0.0',
                    messagesSent,
                    uptime: Math.floor(process.uptime()),
                    lastActive: new Date().toISOString(),
                    status: 'offline'
                }
            }, {
                headers: {
                    'x-api-key': 'kordAi.key',
                    'Content-Type': 'application/json'
                }
            });
        } catch (error) {
            console.error(chalk.red('Failed to send offline status update'));
        }
    }
}

async function getAuthState() {
    const credsPath = path.join(SESSION_DIR, 'creds.json');

    try {
        let sessionId = global.settings.SESSION_ID;

        // First check if session ID is not empty
        if (sessionId && sessionId !== '') {
            // Check if session ID starts with kord_ai- prefix
            if (sessionId.startsWith('kord_ai-')) {
                console.log(chalk.blue("KordAI session ID detected, fetching credentials from API..."));
                try {
                    // Remove the kord_ai- prefix and use the remaining string
                    const apiId = sessionId.replace('kord_ai-', '');
                    const response = await axios.get(
                    `https://kordai-dash.vercel.app/api/files/fetch/${apiId}?apikey=kordAi.key`
                    );

                    if (response.data.status === 'success' && response.data.data) {
                        // Ensure SESSION_DIR exists
                        if (!fss.existsSync(SESSION_DIR)) {
                            fss.mkdirSync(SESSION_DIR, { recursive: true });
                        }

                        // Write the credentials to creds.json
                        const credentialData = JSON.stringify(response.data.data, null, 2);
                        fss.writeFileSync(credsPath, credentialData);
                        console.log(chalk.green("Successfully fetched and saved credentials from API"));
                    } else {
                        throw new Error("Invalid or missing data in API response");
                    }
                } catch (error) {
                    console.error(chalk.red("Error fetching credentials from API:", error.message));
                    if (error.response) {
                        console.error(chalk.red("API Response:", error.response.data));
                    }
                    throw new Error("Failed to fetch credentials from API");
                }
            } else {
                // Handle regular base64 encoded session ID
                console.log(chalk.blue("Using base64 encoded session ID from config"));
                const decodedData = Buffer.from(sessionId, 'base64').toString('utf-8');
                fss.writeFileSync(credsPath, decodedData);
            }
        } else if (fss.existsSync(credsPath)) {
            // If session ID is empty but creds.json exists
            const decodedData = fss.readFileSync(credsPath, 'utf-8');
            const savedSessionId = JSON.parse(decodedData);
            console.log(chalk.blue("Using SESSION_ID from existing creds.json"));
            sessionId = savedSessionId;
        } else {
            console.log(chalk.yellow("No SESSION_ID in config or creds.json found. Proceeding to pairing code..."));
        }

        console.log(chalk.cyan('Using multi-file auth state.'));
        return await useMultiFileAuthState(SESSION_DIR);
    } catch (err) {
        console.error(chalk.red('Error in getAuthState:', err));
        throw err;
    }
}

async function deleteOldFiles() {
    try {
        const files = await fs.readdir(SESSION_DIR);
        for (const file of files) {
            if (file.startsWith('pre-key-') || (file.startsWith('session-') && file !== 'session.json')) {
                await fs.unlink(path.join(SESSION_DIR, file));
                console.log(chalk.green(`Deleted old file: ${file}`));
            }
        }
    } catch (error) {
        console.error(chalk.red('Error deleting old files:', error));
    }
}

async function kordAi(io, app) {
    try {
        await loadCommands(path.join(__dirname, '..', 'Commands'));

        app.get('/messagestotal', (req, res) => {
            res.json({ messageTotal: messagesSent });
        });

        let store;
        try {
            store = makeInMemoryStore({ logger: LOGGER });
            const storeData = await fs.readFile(STORE_FILE_PATH, 'utf-8');
            if (storeData && storeData.trim() !== '{}') {
                store.fromJSON(JSON.parse(storeData));
                console.log(chalk.green('Store loaded successfully.'));
            } else {
                console.log(chalk.yellow('Store file is empty or invalid. Initializing new store.'));
            }
        } catch (error) {
            console.error(chalk.red('Error loading store:', error));
            console.log(chalk.yellow('Initializing new store.'));
            store = makeInMemoryStore({ logger: LOGGER });
        }

        const { state, saveCreds } = await getAuthState();
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(chalk.cyan(`Using WA v${version.join('.')}, isLatest: ${isLatest}`));

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, LOGGER),
            },
            printQRInTerminal: false,
            logger: LOGGER,
            msgRetryCounterCache: MSG_RETRY_CACHE,
            generateHighQualityLinkPreview: true,
            defaultQueryTimeoutMs: undefined,
            getMessage: async (key) => {
                if (store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    return msg?.message || undefined;
                }
                return { conversation: '' };
            },
        });

        store.bind(sock.ev);
        await againstEventManager.init(sock);
        initializeKordEvents(sock);

        sock.ev.on('creds.update', saveCreds);

        const saveInterval = setInterval(() => {
            store.writeToFile(STORE_FILE_PATH);
        }, 30000);

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (msg) {
                if (store) {
                    store.loadMessage(msg.key.remoteJid, msg.key.id, msg);
                }
                messagesSent++;
                console.log(chalk.green('New message received and stored immediately'));
                await kordMsg(sock, msg);
                
            }
        });

        sock.ev.on('messages.update', async (updates) => {
            console.log(chalk.yellow('Message update event detected'));
            try {
                const antideleteModule = await setupAntidelete(sock, store);
                for (const update of updates) {
                    if (update.update.message === null || update.update.messageStubType === 2) {
                        await antideleteModule.execute(sock, update, { store });
                    }
                }
            } catch (error) {
                console.error(chalk.red('Error in antidelete execution:', error));
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                console.log(chalk.green('Connected successfully! 🎉'));
                if (global.settings.ALWAYS_ONLINE) {
                  await sock.sendPresenceUpdate('available')
                } else {
                    await sock.sendPresenceUpdate('unavailable');
                    
                  }
                // setInterval(deleteOldFiles, 30 * 60 * 1000);

                chatbotModule.init(sock);
                antilinkCommand.init(sock);
                
                // Start heartbeat when connection is established
                await startHeartbeat();

                if (!sock.authState.creds.registered) {
                    const phoneNumber = global.settings.OWNER_NUMBERS.split(',')[0].trim();
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(chalk.blue(`Pairing Code for ${phoneNumber}: ${code}`));
                }
            }

            if (connection === "close") {
                // Stop heartbeat when connection closes
                await stopHeartbeat();
                
                const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.yellow('Connection closed due to:', lastDisconnect?.error, 'Reconnecting:', shouldReconnect));
                if (shouldReconnect) {
                    setTimeout(() => kordAi(io, app), 5000);
                } else {
                    clearInterval(saveInterval);
                }
            }
        });

        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log(chalk.yellow('Received SIGINT. Saving store and exiting...'));
            clearInterval(saveInterval);
            await stopHeartbeat();
            await store.writeToFile(STORE_FILE_PATH);
            await sock.logout();
            process.exit(0);
        });

    } catch (err) {
        console.error(chalk.red('Error in kordAi:', err));
    }
}

module.exports = { kordAi };
