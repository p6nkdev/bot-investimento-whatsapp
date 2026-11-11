const axios = require('axios');

function normalizeSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildPair(symbol, quote = 'BRL') {
    return `${normalizeSymbol(symbol)}${normalizeSymbol(quote) || 'BRL'}`;
}

function extractLatestPrice(payload) {
    const series = payload?.real;

    if (!Array.isArray(series) || series.length === 0) {
        return null;
    }

    const latestPoint = series[series.length - 1];
    const price = latestPoint?.price ?? latestPoint?.value;

    if (price === null || price === undefined || price === '') {
        return null;
    }

    const numericPrice = Number(price);
    return Number.isFinite(numericPrice) ? numericPrice : null;
}

async function fetchCoinPrice(type, symbol, quote = 'BRL') {
    const pair = buildPair(symbol, quote);

    if (!pair || pair.length < 6) {
        return null;
    }

    if (type === 'crypto') {
        return fetchCryptoPrice(type, symbol, quote);
    } else if (type === 'acao') {
        return fetchAcaoPrice(type, symbol, quote);
    }

    return null;
}

async function fetchCryptoPrice(type, symbol, quote = 'BRL') {
    const pair = buildPair(symbol, quote);

    if (!pair || pair.length < 6) {
        return null;
    }

    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price', {
            params: { symbol: pair },
            timeout: 10000,
        });

        return Number(response.data.price);
    } catch (error) {
        const reason = error.response?.data?.msg || error.message;
        console.error(`Erro ao obter valor de ${pair}:`, reason);
        return null;
    }
}

async function fetchAcaoPrice(type, symbol, quote = 'BRL') {
    try {
        const response = await axios.get(`https://investidor10.com.br/api/quotations/one-day/${symbol.toUpperCase()}/`, {
            timeout: 10000,
        });
        return extractLatestPrice(response.data);
    } catch (error) {
        const reason = error.response?.data?.msg || error.message;
        console.error(`Erro ao obter valor de ${symbol}:`, reason);
        return null;
    }
}

module.exports = { fetchCoinPrice, normalizeSymbol, buildPair };
