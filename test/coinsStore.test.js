// Integration test: needs a real MySQL (DB_* env vars). Skipped when DB_PASSWORD is unset.
const test = require('node:test');
const assert = require('node:assert');

test('coinsStore no MySQL', { skip: !process.env.DB_PASSWORD && 'DB_PASSWORD nao definido' }, async () => {
    const { connect } = require('../src/db/mysql');
    const { createCoinsStore } = require('../src/db/coinsStore');
    const db = await connect();
    const store = createCoinsStore(db);

    try {
        await store.deleteCoin('TSTX');
        const created = await store.upsertCoin({ symbol: 'tst-x', name: 'Teste', alertUp: 2, alertDown: '1.5' });
        assert.strictEqual(created.symbol, 'TSTX');
        assert.strictEqual(created.alertDown, 1.5);
        assert.strictEqual(created.lastValue, null);

        await store.setLastValue('TSTX', 10.25);
        for (let i = 0; i < 25; i++) await store.recordPrice('TSTX', i);
        await store.recordPrice('TSTX', 24); // repetido, nao entra
        const updated = await store.upsertCoin({ symbol: 'TSTX', name: 'Renomeada', enabled: false });
        assert.strictEqual(updated.name, 'Renomeada');
        assert.strictEqual(updated.enabled, false);
        assert.strictEqual(updated.lastValue, 10.25, 'upsert preserva lastValue');
        assert.deepStrictEqual(updated.history, Array.from({ length: 20 }, (_, i) => i + 5));

        const config = await store.setChatId(' 123@g.us ');
        assert.strictEqual(config.chatId, '123@g.us');
        assert.ok(config.coins.some((coin) => coin.symbol === 'TSTX' && coin.history.length === 20));

        await store.deleteCoin('TSTX');
        assert.strictEqual(await store.findCoin('TSTX'), null);
        const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM coin_history WHERE symbol = 'TSTX'");
        assert.strictEqual(n, 0, 'historico apagado em cascata');
    } finally {
        await db.end();
    }
});
