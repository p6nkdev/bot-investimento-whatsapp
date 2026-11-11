const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SESSION_DAYS = 7;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const EXAMPLE_PASSWORD = 'troque-esta-senha'; // keep in sync with .env.example

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function validateCredentials(username, password) {
    if (!USERNAME_PATTERN.test(username)) {
        throw new Error('Usuário deve ter de 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) {
        throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
    }
}

function createUsersStore(db) {
    // shortcut: in-memory, per process and per username; an attacker can lock a known username out for 15 min.
    const failures = new Map();
    let dummyHash = null;

    function isLocked(username) {
        const entry = failures.get(username);
        if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) {
            failures.delete(username);
            return false;
        }
        return entry.count >= MAX_FAILURES;
    }

    function recordFailure(username) {
        const entry = failures.get(username);
        if (entry && Date.now() - entry.since <= FAILURE_WINDOW_MS) entry.count += 1;
        else failures.set(username, { count: 1, since: Date.now() });
    }

    async function countUsers() {
        const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM users');
        return total;
    }

    async function listUsers() {
        const [rows] = await db.query('SELECT id, username, created_at AS createdAt FROM users ORDER BY username');
        return rows;
    }

    async function createUser(rawUsername, password) {
        const username = normalizeUsername(rawUsername);
        validateCredentials(username, password);

        try {
            const [result] = await db.query(
                'INSERT INTO users (username, password_hash) VALUES (?, ?)',
                [username, await hashPassword(password)]
            );
            return { id: result.insertId, username };
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') throw new Error(`O usuário ${username} já existe.`);
            throw error;
        }
    }

    async function deleteUser(id, currentUserId) {
        if (Number(id) === currentUserId) {
            throw new Error('Você não pode excluir o seu próprio usuário.');
        }
        if (await countUsers() <= 1) {
            throw new Error('Não é possível excluir o último usuário.');
        }
        await db.query('DELETE FROM users WHERE id = ?', [id]);
    }

    // Creates the first user from the environment when the table is empty.
    async function ensureInitialUser(username, password) {
        if (await countUsers() > 0) return;
        if (!username || !password) {
            throw new Error('Nenhum usuário cadastrado. Defina PANEL_USER e PANEL_PASSWORD para criar o primeiro.');
        }
        // The .env.example value is public; accepting it would leave the panel open to anyone who read the repo.
        if (password === EXAMPLE_PASSWORD) {
            throw new Error('PANEL_PASSWORD ainda é a senha de exemplo do .env.example. Troque por uma senha sua.');
        }
        const user = await createUser(username, password);
        console.log(`Usuário inicial "${user.username}" criado a partir do .env.`);
    }

    async function login(rawUsername, password) {
        const username = normalizeUsername(rawUsername);
        if (isLocked(username)) {
            throw new Error('Muitas tentativas. Aguarde 15 minutos e tente de novo.');
        }

        const [rows] = await db.query('SELECT id, username, password_hash FROM users WHERE username = ?', [username]);
        // Unknown users still pay for a scrypt run, so response time does not reveal which usernames exist.
        dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
        const valid = await verifyPassword(String(password || ''), rows[0]?.password_hash ?? dummyHash);

        if (!rows[0] || !valid) {
            recordFailure(username);
            throw new Error('Usuário ou senha incorretos.');
        }

        failures.delete(username);
        const token = crypto.randomBytes(32).toString('base64url');
        await db.query(
            'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
            [hashToken(token), rows[0].id, SESSION_DAYS]
        );
        return { token, maxAgeSeconds: SESSION_DAYS * 86400 };
    }

    async function getSessionUser(token) {
        if (!token) return null;
        const [rows] = await db.query(
            `SELECT users.id, users.username FROM sessions
             JOIN users ON users.id = sessions.user_id
             WHERE sessions.token_hash = ? AND sessions.expires_at > NOW()`,
            [hashToken(token)]
        );
        return rows[0] || null;
    }

    async function logout(token) {
        if (token) await db.query('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
        await db.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    }

    return { listUsers, createUser, deleteUser, ensureInitialUser, login, getSessionUser, logout };
}

module.exports = { createUsersStore, hashPassword, verifyPassword };
