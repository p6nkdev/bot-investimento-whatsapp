const { fetchCoinPrice, normalizeSymbol } = require('../services/prices');
const { formatMoney } = require('../utils/format');

function parseCommand(text) {
    const [command, symbol] = String(text || '').trim().split(/\s+/);

    return {
        command: command?.toLowerCase(),
        symbol: normalizeSymbol(symbol || 'BTC'),
    };
}

async function reply(sock, msg, text) {
    const remetente = msg.key.remoteJid;

    try {
        console.log(`[reply] Enviando para ${remetente}: ${text.slice(0, 15)}...`);
        await sock.sendMessage(remetente, { text }, { quoted: msg });
        console.log(`[reply] Enviado com sucesso para ${remetente}`);
    } catch (error) {
        console.error('[reply] Erro ao enviar mensagem:', error.message);
    }
}

function extractMessageText(message) {
    if (!message) return '';

    if (typeof message.conversation === 'string' && message.conversation.trim()) {
        return message.conversation.toLocaleLowerCase('pt-BR').trim();
    }

    if (typeof message.extendedTextMessage?.text === 'string' && message.extendedTextMessage.text.trim()) {
        return message.extendedTextMessage.text.toLocaleLowerCase('pt-BR').trim();
    }

    if (typeof message.imageMessage?.caption === 'string' && message.imageMessage.caption.trim()) {
        return message.imageMessage.caption.toLocaleLowerCase('pt-BR').trim();
    }

    if (typeof message.videoMessage?.caption === 'string' && message.videoMessage.caption.trim()) {
        return message.videoMessage.caption.toLocaleLowerCase('pt-BR').trim();
    }

    if (typeof message.buttonsResponseMessage?.selectedDisplayText === 'string' && message.buttonsResponseMessage.selectedDisplayText.trim()) {
        return message.buttonsResponseMessage.selectedDisplayText.toLocaleLowerCase('pt-BR').trim();
    }

    return '';
}

function createCommandHandler(store) {
    function getSenderId(msg) {
        const key = msg?.key || {};

        if (typeof key.remoteJidAlt === 'string' && key.remoteJidAlt.trim()) {
            return key.remoteJidAlt.trim();
        }

        if (typeof key.participant === 'string' && key.participant.trim()) {
            return key.participant.trim();
        }

        if (typeof key.remoteJid === 'string' && key.remoteJid.trim()) {
            return key.remoteJid.trim();
        }

        return null;
    }

    async function sendPrice(sock, msg, symbol) {
        const coin = (await store.findCoin(symbol)) || store.normalizeCoin({ symbol, quote: 'BRL' });
        const price = await fetchCoinPrice(coin.type, coin.symbol, coin.quote);

        if (price !== null) {
            await reply(
                sock,
                msg,
                `*Valor atual de ${coin.name} (${coin.symbol}/${coin.quote}):*\n> ${formatMoney(price, coin.quote)}`
            );
            return;
        }

        await reply(
            sock,
            msg,
            coin.type === 'acao'
                ? `*Nao consegui obter o valor de ${symbol}. Verifique se o ticker existe no Investidor10.*`
                : `*Nao consegui obter o valor de ${symbol}. Verifique se existe o par ${symbol}${coin.quote} na Binance.*`
        );
    }

    async function sendHistory(sock, msg, symbol) {
        const coin = await store.findCoin(symbol);

        if (!coin) {
            await reply(sock, msg, `*A moeda ${symbol} ainda nao esta cadastrada no painel.*`);
            return;
        }

        if (coin.history.length === 0) {
            await reply(sock, msg, `*Ainda nao ha historico para ${coin.symbol}.*`);
            return;
        }

        const values = coin.history.map((value) => `> ${formatMoney(value, coin.quote)}`).join('\n');
        await reply(sock, msg, `*Ultimos valores de ${coin.name} (${coin.symbol}/${coin.quote}):*\n${values}`);
    }

    async function handleCommand(sock, msg) {
        const rawText = extractMessageText(msg.message);
        const senderId = getSenderId(msg);
        const remetenteNum = senderId ? senderId.replace(/@.*$/, '') : 'desconhecido';
        // Only commands are logged; ordinary chat messages must not end up in the logs.
        if (!rawText.startsWith('!')) return;

        console.log(`Comando recebido de ${remetenteNum}: ${rawText}`);

        const { command, symbol } = parseCommand(rawText);
        if (command === '!btc') {
            await sendPrice(sock, msg, 'BTC');
            return;
        }

        if (command === '!preco' || command === '!preço') {
            await sendPrice(sock, msg, symbol);
            return;
        }

        if (command === '!historico') {
            await sendHistory(sock, msg, symbol);
            return;
        }

        if (command === '!moedas') {
            const config = await store.getConfig();
            console.log(`[command] !moedas recebido. Total de moedas: ${config.coins.length}`);
            const lines = config.coins
                .map((coin) => `> ${coin.symbol}/${coin.quote} - ${coin.enabled ? 'ativo' : 'pausado'}`)
                .join('\n');
            const response = `*Moedas cadastradas:*\n${lines || '> Nenhuma moeda cadastrada.'}`;
            await reply(sock, msg, response);
            return;
        }

        if (command === '!help') {
            await reply(sock, msg, [
                '*Comandos disponiveis:*',
                '> !preco BTC - Mostra o preco atual da moeda',
                '> !historico BTC - Mostra os ultimos 20 valores da moeda',
                '> !moedas - Lista as moedas monitoradas',
                '> !btc - Atalho antigo para o preco do Bitcoin',
                '> !help - Mostra esta mensagem',
            ].join('\n'));
        }
    }

    return { handleCommand };
}

module.exports = { createCommandHandler };
