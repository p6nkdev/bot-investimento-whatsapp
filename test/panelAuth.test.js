const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { startPanelServer } = require('../src/server/panelServer');

const fakeUsers = {
    login: async (username, password) => {
        if (username === 'admin' && password === 'segredo123') return { token: 'tok', maxAgeSeconds: 60 };
        throw new Error('Usuário ou senha incorretos.');
    },
    getSessionUser: async (token) => (token === 'tok' ? { id: 1, username: 'admin' } : null),
    logout: async () => {},
};

async function withServer(run, store = {}) {
    const server = startPanelServer({
        store: { getConfig: async () => ({ chatId: '', coins: [] }), ...store },
        users: fakeUsers,
        port: 0,
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await run(base, server.address().port);
    } finally {
        server.close();
    }
}

const session = { Cookie: 'sid=tok' };
const json = { 'Content-Type': 'application/json' };

test('sem sessao: API responde 401 e paginas redirecionam para o login', () => withServer(async (base) => {
    assert.strictEqual((await fetch(`${base}/api/config`)).status, 401);
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.get('location'), '/login.html');
    assert.strictEqual((await fetch(`${base}/login.html`)).status, 200);
    assert.strictEqual((await fetch(`${base}/api/config`, { headers: { Cookie: 'sid=falso' } })).status, 401);
}));

test('login cria cookie de sessao HttpOnly e SameSite=Strict', () => withServer(async (base) => {
    const wrong = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: '{"username":"admin","password":"x"}' });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(wrong.headers.get('set-cookie'), null);

    const ok = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: '{"username":"admin","password":"segredo123"}' });
    assert.strictEqual(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /^sid=tok; HttpOnly; SameSite=Strict; Path=\/; Max-Age=60$/);

    assert.strictEqual((await fetch(`${base}/api/config`, { headers: session })).status, 200);
    assert.deepStrictEqual(await (await fetch(`${base}/api/me`, { headers: session })).json(), { id: 1, username: 'admin' });
    assert.deepStrictEqual(await (await fetch(`${base}/api/whatsapp`, { headers: session })).json(), { status: 'disabled' });
}));

test('Host ou URL malformados nao derrubam o servidor', () => withServer(async (base, port) => {
    const raw = (text) => new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
        let out = '';
        socket.on('data', (chunk) => (out += chunk));
        socket.on('close', () => resolve(out.split('\r\n')[0]));
    });

    assert.match(await raw('GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'), / 302 /);
    assert.match(await raw('GET //[ HTTP/1.1\r\nHost: [\r\nCookie: sid=tok\r\nConnection: close\r\n\r\n'), / 400 /);
    assert.strictEqual((await fetch(`${base}/api/config`, { headers: session })).status, 200);
}));

test('API rejeita corpo sem Content-Type JSON (CSRF via form)', async () => {
    const upserts = [];
    await withServer(async (base) => {
        const body = '{"symbol":"BTC","enabled":false,"x":"="}';
        const csrf = await fetch(`${base}/api/coins`, { method: 'POST', headers: { ...session, 'Content-Type': 'text/plain' }, body });
        assert.strictEqual(csrf.status, 400);
        assert.strictEqual(upserts.length, 0);

        const ok = await fetch(`${base}/api/coins`, { method: 'POST', headers: { ...session, ...json }, body });
        assert.strictEqual(ok.status, 201);
    }, { upsertCoin: async (coin) => { upserts.push(coin); return coin; } });
});
