const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const { createCommandHandler } = require('./commands');

const AUTH_DIR = path.join(__dirname, '..', '..', 'botData');
const RECONNECT_DELAY_MS = 2000;

// Removes the saved WhatsApp session so the next connection asks for a new QR code.
function clearAuthState() {
    for (const file of fs.readdirSync(AUTH_DIR)) {
        if (file !== '.gitkeep') fs.rmSync(path.join(AUTH_DIR, file), { recursive: true, force: true });
    }
}

function createWhatsAppBot({ store, monitor }) {
    const { handleCommand } = createCommandHandler(store);
    let activeSock = null;
    let status = 'disconnected';
    let qr = null;

    async function startBot() {
        status = 'connecting';
        qr = null;

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const sock = makeWASocket({ auth: state });
        activeSock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            if (sock !== activeSock) return; // events from a socket that was already replaced

            if (update.qr) {
                status = 'qr';
                qr = update.qr;
                QRCode.toString(update.qr, { type: 'terminal', small: true }).then(console.log, () => {});
            }

            if (update.connection === 'open') {
                status = 'connected';
                qr = null;
                console.log('WhatsApp conectado.');
                monitor.start(() => activeSock);
            }

            if (update.connection === 'close') {
                const code = new Boom(update.lastDisconnect?.error)?.output?.statusCode;
                qr = null;

                if (code === DisconnectReason.loggedOut) {
                    console.log('WhatsApp desconectado (sessao encerrada). Conecte de novo pelo painel.');
                    status = 'disconnected';
                    activeSock = null;
                    clearAuthState();
                    return;
                }

                console.log('Conexao do WhatsApp caiu. Reconectando...');
                status = 'connecting';
                setTimeout(() => startBot().catch(onStartError), RECONNECT_DELAY_MS);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (!['notify', 'append'].includes(type)) return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                try {
                    await handleCommand(sock, msg);
                } catch (error) {
                    console.error('[command] Erro ao processar mensagem:', error.message);
                }
            }
        });

        return sock;
    }

    function onStartError(error) {
        console.error('Falha ao iniciar o WhatsApp:', error.message);
        status = 'disconnected';
    }

    async function getStatus() {
        return {
            status,
            qrSvg: qr ? await QRCode.toString(qr, { type: 'svg', margin: 1 }) : null,
            account: status === 'connected' && activeSock?.user
                ? { id: activeSock.user.id.replace(/[:@].*$/, ''), name: activeSock.user.name || null }
                : null,
        };
    }

    function connect() {
        if (status !== 'disconnected') return;
        startBot().catch(onStartError);
    }

    async function logout() {
        if (status !== 'connected') throw new Error('O WhatsApp não está conectado.');
        await activeSock.logout();
    }

    async function listGroups() {
        if (status !== 'connected') throw new Error('Conecte o WhatsApp para ver os grupos.');

        const groups = await activeSock.groupFetchAllParticipating();
        return Object.values(groups)
            .map((group) => ({ id: group.id, name: group.subject || group.id, size: group.participants?.length ?? null }))
            .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    }

    return { startBot: () => startBot().catch(onStartError), connect, logout, getStatus, listGroups };
}

module.exports = { createWhatsAppBot };
