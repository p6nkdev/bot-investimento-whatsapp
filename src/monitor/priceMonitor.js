const cron = require('node-cron');
const { fetchCoinPrice } = require('../services/prices');
const { formatMoney } = require('../utils/format');

function buildAlert(coin, difference, currentValue) {
    const direction = difference > 0 ? 'subiu' : 'caiu';
    return [
        `${coin.name} (${coin.symbol}/${coin.quote}) ${direction} ${formatMoney(Math.abs(difference), coin.quote)}.`,
        `Valor atual: ${formatMoney(currentValue, coin.quote)}`,
    ].join('\n> ');
}

function createPriceMonitor(store) {
    let started = false;
    let running = false;

    async function checkCoin(coin, currentValue, chatId, getSock) {
        await store.recordPrice(coin.symbol, currentValue);

        if (coin.lastValue === null) {
            await store.setLastValue(coin.symbol, currentValue);
            return;
        }

        const difference = currentValue - coin.lastValue;
        const threshold = difference > 0 ? coin.alertUp : coin.alertDown;
        if (!(threshold > 0 && Math.abs(difference) >= threshold)) return;

        if (!chatId) {
            console.warn(`[monitor] Alerta de ${coin.symbol} ignorado: chatId nao configurado no painel.`);
            return;
        }

        // lastValue only moves after a successful send, so a failed alert is retried next cycle.
        await getSock().sendMessage(chatId, { text: buildAlert(coin, difference, currentValue) });
        await store.setLastValue(coin.symbol, currentValue);
    }

    async function checkPrices(getSock) {
        if (running) {
            console.warn('[monitor] Ciclo anterior ainda em andamento, pulando.');
            return;
        }
        running = true;

        try {
            const { chatId, coins } = await store.getConfig();
            const enabled = coins.filter((coin) => coin.enabled);
            const prices = await Promise.all(
                enabled.map((coin) => fetchCoinPrice(coin.type, coin.symbol, coin.quote))
            );

            for (const [index, coin] of enabled.entries()) {
                if (prices[index] === null) continue;

                try {
                    await checkCoin(coin, prices[index], chatId, getSock);
                } catch (error) {
                    console.error(`[monitor] Erro ao processar ${coin.symbol}:`, error.message);
                }
            }
        } catch (error) {
            console.error('[monitor] Erro no ciclo:', error.message);
        } finally {
            running = false;
        }
    }

    function start(getSock) {
        if (started) return;
        started = true;

        checkPrices(getSock);
        cron.schedule('*/1 * * * *', () => checkPrices(getSock));
    }

    return { start, checkPrices };
}

module.exports = { createPriceMonitor };
