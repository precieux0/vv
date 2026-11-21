// ============================================================
//  Bot Baileys - Correctif 405 (plateforme macOS) + reconnexion
// ============================================================

const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const {
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    fetchLatestBaileysVersion,
    Browsers,                // <-- Indispensable pour le correctif 405
} = baileys;

const qrcode = require('qrcode-terminal');

// ⚠️ REMPLACEZ PAR VOTRE NUMÉRO (format international, sans le +)
const OWNER_NUMBER = '243894697490';
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;

// Dossiers "enveloppes" qui contiennent le vrai message
const WRAPPERS = [
    'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'viewOnceMessage',
    'ephemeralMessage', 'documentWithCaptionMessage'
];

// Extrait le média caché dans les wrappers
function extractPayload(message) {
    let current = message;
    let isViewOnce = false;
    for (let i = 0; i < 6 && current; i++) {
        let next = null;
        for (const key of WRAPPERS) {
            if (current[key]?.message) {
                next = current[key].message;
                if (key.startsWith('viewOnce')) isViewOnce = true;
                break;
            }
        }
        if (!next) break;
        current = next;
    }
    return { payload: current, isViewOnce };
}

// Télécharge le média en mémoire
async function streamToBuffer(mediaNode, mediaType) {
    const stream = await downloadContentFromMessage(mediaNode, mediaType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function startBot() {
    // 1. Chargement de l'état d'authentification
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // 2. Récupération de la version de protocole WhatsApp la plus récente
    //    (évite les erreurs 405 dues à une version obsolète)
    const { version } = await fetchLatestBaileysVersion();
    console.log('Version WhatsApp utilisée :', version);

    // 3. Création du socket avec les correctifs essentiels
    const sock = makeWASocket({
        auth: state,
        version: version,                 // <-- version fraîche
        browser: Browsers.macOS('Chrome'), // <-- CORRECTIF 405 : plateforme MACOS
        // printQRInTerminal: true  -> supprimé (déprécié en v7)
    });

    sock.ev.on('creds.update', saveCreds);

    // 4. Gestion de la connexion et des reconnexions
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ Bot connecté. En attente de la commande .vv...');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reasonTag = lastDisconnect?.error?.data?.tag;
            console.log(`🔌 Connexion fermée. Code: ${statusCode}, Raison: ${reasonTag || 'inconnue'}`);

            // --- Erreurs fatales : on NE reconnecte PAS ---
            if (statusCode === DisconnectReason.loggedOut) { // 401
                console.error('❌ Session révoquée (401). Supprimez le dossier "auth_info_baileys" et relancez le bot.');
                return;
            }
            if (statusCode === 405) {
                console.error('❌ Erreur 405 (plateforme/version refusée). Vérifiez que le correctif macOS est bien appliqué.');
                return;
            }
            if (statusCode === DisconnectReason.restartRequired) { // 515
                console.log('🔄 Redémarrage requis par WhatsApp. Reconnexion...');
                startBot();
                return;
            }

            // --- Autres erreurs : reconnexion après un court délai ---
            console.log('🔄 Reconnexion dans 3 secondes...');
            setTimeout(() => startBot(), 3000);
        }
    });

    // 5. Traitement des messages (commande .vv)
    sock.ev.on('messages.upsert', async (event) => {
        if (event.type !== 'notify') return;

        for (const msg of event.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            const sender = msg.key.participant || from;

            const text = msg.message.conversation ||
                         msg.message.extendedTextMessage?.text || '';

            if (text.trim().toLowerCase() === '.vv') {

                // Vérification propriétaire
                if (sender !== OWNER_JID) {
                    await sock.sendMessage(from, {
                        text: "Accès refusé. Commande réservée au propriétaire."
                    }, { quoted: msg });
                    continue;
                }

                // Vérification message cité
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) {
                    await sock.sendMessage(from, {
                        text: "Réponds à un média 'vue unique' avec .vv"
                    }, { quoted: msg });
                    continue;
                }

                try {
                    const { payload } = extractPayload(quotedMsg);
                    const mediaKey = Object.keys(payload || {}).find(k =>
                        /^(image|video|audio|document)Message$/.test(k)
                    );

                    if (!mediaKey) {
                        await sock.sendMessage(from, {
                            text: "Type de média non supporté."
                        }, { quoted: msg });
                        continue;
                    }

                    const mediaData = payload[mediaKey];
                    const mediaType = mediaKey.replace('Message', '');
                    const buffer = await streamToBuffer(mediaData, mediaType);
                    const caption = `Source: ${sender.split('@')[0]}${from.endsWith('@g.us') ? ' (Groupe)' : ''}`;

                    const outgoing = {};
                    if (mediaType === 'image') outgoing.image = buffer;
                    else if (mediaType === 'video') outgoing.video = buffer;
                    else if (mediaType === 'audio') {
                        outgoing.audio = buffer;
                        outgoing.mimetype = mediaData.mimetype || 'audio/mp4';
                        outgoing.ptt = mediaData.ptt;
                    } else if (mediaType === 'document') {
                        outgoing.document = buffer;
                        outgoing.mimetype = mediaData.mimetype || 'application/octet-stream';
                        outgoing.fileName = mediaData.fileName || 'fichier';
                    }

                    if (mediaType !== 'audio') outgoing.caption = caption;

                    await sock.sendMessage(OWNER_JID, outgoing);
                    if (mediaType === 'audio') {
                        await sock.sendMessage(OWNER_JID, { text: caption });
                    }

                    await sock.sendMessage(from, {
                        react: { text: '📥', key: msg.key }
                    });

                } catch (err) {
                    console.error('Erreur .vv:', err);
                    await sock.sendMessage(OWNER_JID, {
                        text: `Échec de la récupération : ${err.message}`
                    });
                }
            }
        }
    });
}

startBot();