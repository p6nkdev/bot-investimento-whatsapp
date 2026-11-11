const fs = require('fs');
const http = require('http');
const path = require('path');
const { fetchCoinPrice, normalizeSymbol } = require('../services/prices');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/styles.css']);
const SESSION_COOKIE = 'sid';

function sendJson(res, statusCode, data, headers = {}) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(data));
}

function readRequestBody(req) {
    // Forces a CORS preflight for cross-site requests, which blocks <form enctype="text/plain"> CSRF.
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return Promise.reject(new Error('Envie Content-Type: application/json.'));
    }

    return new Promise((resolve, reject) => {
        let body = '';

        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1_000_000) {
                req.destroy();
                reject(new Error('Payload muito grande.'));
            }
        });

        req.on('end', () => {
            if (!body) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error('JSON invalido.'));
            }
        });
    });
}

function readSessionToken(req) {
    const cookie = String(req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : null;
}

function sessionCookie(req, token, maxAgeSeconds) {
    // Behind an HTTPS reverse proxy the browser talks HTTPS even though this server speaks HTTP.
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function createApiHandler({ store, users, bot }) {
    return async function handleApi(req, res, pathname, user) {
        const route = `${req.method} ${pathname}`;

        // ---------- Sessão ----------

        if (route === 'POST /api/login') {
            const body = await readRequestBody(req);
            try {
                const session = await users.login(body.username, body.password);
                sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, session.token, session.maxAgeSeconds) });
            } catch (error) {
                sendJson(res, 401, { error: error.message });
            }
            return;
        }

        if (route === 'POST /api/logout') {
            await users.logout(readSessionToken(req));
            sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
            return;
        }

        if (route === 'GET /api/me') {
            sendJson(res, 200, user);
            return;
        }

        // ---------- Usuários ----------

        if (route === 'GET /api/users') {
            sendJson(res, 200, await users.listUsers());
            return;
        }

        if (route === 'POST /api/users') {
            const body = await readRequestBody(req);
            sendJson(res, 201, await users.createUser(body.username, body.password));
            return;
        }

        const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
        if (userMatch && req.method === 'DELETE') {
            await users.deleteUser(Number(userMatch[1]), user.id);
            sendJson(res, 200, { ok: true });
            return;
        }

        // ---------- WhatsApp ----------

        if (route === 'GET /api/whatsapp') {
            sendJson(res, 200, bot ? await bot.getStatus() : { status: 'disabled' });
            return;
        }

        if (pathname.startsWith('/api/whatsapp/') && !bot) {
            sendJson(res, 409, { error: 'O WhatsApp está desativado (PANEL_ONLY=true).' });
            return;
        }

        if (route === 'POST /api/whatsapp/connect') {
            bot.connect();
            sendJson(res, 200, await bot.getStatus());
            return;
        }

        if (route === 'POST /api/whatsapp/logout') {
            await bot.logout();
            sendJson(res, 200, { ok: true });
            return;
        }

        if (route === 'GET /api/whatsapp/groups') {
            sendJson(res, 200, await bot.listGroups());
            return;
        }

        // ---------- Ativos ----------

        if (route === 'GET /api/config') {
            sendJson(res, 200, await store.getConfig());
            return;
        }

        if (route === 'PUT /api/config') {
            const body = await readRequestBody(req);
            sendJson(res, 200, await store.setChatId(body.chatId));
            return;
        }

        if (route === 'POST /api/coins') {
            const body = await readRequestBody(req);
            sendJson(res, 201, await store.upsertCoin(body));
            return;
        }

        const coinMatch = pathname.match(/^\/api\/coins\/([A-Z0-9]+)$/i);
        if (coinMatch && req.method === 'PUT') {
            const symbol = normalizeSymbol(coinMatch[1]);
            const existing = await store.findCoin(symbol);

            if (!existing) {
                sendJson(res, 404, { error: 'Ativo não encontrado.' });
                return;
            }

            const body = await readRequestBody(req);
            sendJson(res, 200, await store.upsertCoin({ ...existing, ...body, symbol }));
            return;
        }

        if (coinMatch && req.method === 'DELETE') {
            sendJson(res, 200, await store.deleteCoin(normalizeSymbol(coinMatch[1])));
            return;
        }

        if (route === 'GET /api/prices') {
            const { coins } = await store.getConfig();
            const prices = await Promise.all(coins.map(async (coin) => ({
                symbol: coin.symbol,
                quote: coin.quote,
                price: await fetchCoinPrice(coin.type, coin.symbol, coin.quote),
            })));
            sendJson(res, 200, prices);
            return;
        }

        sendJson(res, 404, { error: 'Rota nao encontrada.' });
    };
}

function serveStatic(req, res, pathname) {
    const safePath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403);
        res.end('Acesso negado');
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(404);
            res.end('Arquivo nao encontrado');
            return;
        }

        const contentType = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
        }[path.extname(filePath)] || 'text/plain; charset=utf-8';

        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        res.end(content);
    });
}

function startPanelServer({ store, users, bot = null, port = 3000 }) {
    const handleApi = createApiHandler({ store, users, bot });

    // Any uncaught error here would be an unhandled rejection and kill the whole process.
    const server = http.createServer(async (req, res) => {
        try {
            // Fixed base: the Host header is client-controlled and may not be a valid URL.
            const { pathname } = new URL(req.url, 'http://localhost');
            const isApi = pathname.startsWith('/api/');
            const isPublic = PUBLIC_FILES.has(pathname) || (pathname === '/api/login' && req.method === 'POST');
            const user = isPublic ? null : await users.getSessionUser(readSessionToken(req));

            if (!isPublic && !user) {
                if (isApi) sendJson(res, 401, { error: 'Sessão expirada. Entre de novo.' });
                else {
                    res.writeHead(302, { Location: '/login.html' });
                    res.end();
                }
                return;
            }

            if (isApi) {
                await handleApi(req, res, pathname, user);
                return;
            }

            serveStatic(req, res, pathname);
        } catch (error) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            sendJson(res, 400, { error: error.message });
        }
    });

    server.listen(port, () => {
        console.log(`Painel rodando em http://localhost:${port}`);
    });

    return server;
}

module.exports = { startPanelServer };
