const { normalizeSymbol } = require('../services/prices');

const HISTORY_LIMIT = 20;
const COIN_TYPES = ['crypto', 'acao'];

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeCoin(coin) {
    const symbol = normalizeSymbol(coin?.symbol);
    if (!symbol) return null;

    const type = String(coin?.type || 'crypto').trim();

    return {
        type: COIN_TYPES.includes(type) ? type : 'crypto',
        symbol,
        name: String(coin?.name || symbol).trim().slice(0, 100),
        quote: normalizeSymbol(coin?.quote || 'BRL') || 'BRL',
        alertUp: positiveNumber(coin?.alertUp, 0),
        alertDown: positiveNumber(coin?.alertDown, 0),
        enabled: coin?.enabled !== false,
    };
}

function rowToCoin(row, history = []) {
    return {
        type: row.type,
        symbol: row.symbol,
        name: row.name,
        quote: row.quote,
        alertUp: row.alert_up,
        alertDown: row.alert_down,
        enabled: Boolean(row.enabled),
        lastValue: row.ref_value,
        history,
    };
}

function createCoinsStore(db) {
    async function getChatId() {
        const [rows] = await db.query("SELECT value FROM settings WHERE name = 'chatId'");
        return rows[0]?.value || '';
    }

    async function getHistory(symbol) {
        const [rows] = await db.query(
            `SELECT symbol, price FROM (
                SELECT symbol, price, id, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY id DESC) AS rn
                FROM coin_history ${symbol ? 'WHERE symbol = ?' : ''}
            ) t WHERE rn <= ? ORDER BY id`,
            symbol ? [symbol, HISTORY_LIMIT] : [HISTORY_LIMIT]
        );

        const bySymbol = new Map();
        for (const row of rows) {
            if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
            bySymbol.get(row.symbol).push(row.price);
        }
        return bySymbol;
    }

    async function getConfig() {
        const [[coins], history, chatId] = await Promise.all([
            db.query('SELECT * FROM coins ORDER BY type, symbol'),
            getHistory(),
            getChatId(),
        ]);

        return {
            chatId,
            coins: coins.map((row) => rowToCoin(row, history.get(row.symbol))),
        };
    }

    async function setChatId(chatId) {
        await db.query(
            "INSERT INTO settings (name, value) VALUES ('chatId', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
            [String(chatId || '').trim()]
        );
        return getConfig();
    }

    async function findCoin(symbol) {
        const normalized = normalizeSymbol(symbol);
        const [rows] = await db.query('SELECT * FROM coins WHERE symbol = ?', [normalized]);
        if (!rows[0]) return null;

        const history = await getHistory(normalized);
        return rowToCoin(rows[0], history.get(normalized));
    }

    // Preserves the reference value (ref_value) and history of an existing coin.
    async function upsertCoin(payload) {
        const coin = normalizeCoin(payload);
        if (!coin) {
            throw new Error('Informe uma sigla válida (letras e números).');
        }

        await db.query(
            `INSERT INTO coins (symbol, type, name, quote, alert_up, alert_down, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE type = VALUES(type), name = VALUES(name), quote = VALUES(quote),
                alert_up = VALUES(alert_up), alert_down = VALUES(alert_down), enabled = VALUES(enabled)`,
            [coin.symbol, coin.type, coin.name, coin.quote, coin.alertUp, coin.alertDown, coin.enabled]
        );

        return findCoin(coin.symbol);
    }

    async function deleteCoin(symbol) {
        await db.query('DELETE FROM coins WHERE symbol = ?', [normalizeSymbol(symbol)]);
        return getConfig();
    }

    async function setLastValue(symbol, value) {
        await db.query('UPDATE coins SET ref_value = ? WHERE symbol = ?', [value, symbol]);
    }

    // Stores the price only if it differs from the latest one, then trims to HISTORY_LIMIT.
    async function recordPrice(symbol, price) {
        const [last] = await db.query(
            'SELECT price FROM coin_history WHERE symbol = ? ORDER BY id DESC LIMIT 1',
            [symbol]
        );
        if (last[0]?.price === price) return;

        await db.query('INSERT INTO coin_history (symbol, price) VALUES (?, ?)', [symbol, price]);
        await db.query(
            `DELETE FROM coin_history WHERE symbol = ? AND id NOT IN (
                SELECT id FROM (
                    SELECT id FROM coin_history WHERE symbol = ? ORDER BY id DESC LIMIT ?
                ) keep_rows
            )`,
            [symbol, symbol, HISTORY_LIMIT]
        );
    }

    return {
        getConfig,
        setChatId,
        findCoin,
        upsertCoin,
        deleteCoin,
        setLastValue,
        recordPrice,
        normalizeCoin,
    };
}

module.exports = { createCoinsStore, normalizeCoin };
