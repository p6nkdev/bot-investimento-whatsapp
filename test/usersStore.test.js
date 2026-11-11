const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../src/db/usersStore');

test('hash de senha confere so com a senha certa', async () => {
    const stored = await hashPassword('senha-forte');
    assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.strictEqual(await verifyPassword('senha-forte', stored), true);
    assert.strictEqual(await verifyPassword('senha-errada', stored), false);
    assert.notStrictEqual(await hashPassword('senha-forte'), stored, 'salt aleatorio');
});

test('usuario inicial recusa a senha de exemplo do .env.example', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { createUsersStore } = require('../src/db/usersStore');
    const inserted = [];
    const fakeDb = {
        query: async (sql, params) => {
            if (sql.startsWith('SELECT COUNT')) return [[{ total: inserted.length }]];
            inserted.push(params[0]);
            return [{ insertId: inserted.length }];
        },
    };
    const users = createUsersStore(fakeDb);
    const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8').match(/^PANEL_PASSWORD=(.*)$/m)[1];

    await assert.rejects(users.ensureInitialUser('admin', example), /senha de exemplo/);
    assert.strictEqual(inserted.length, 0);
    await users.ensureInitialUser('admin', 'uma-senha-de-verdade');
    assert.strictEqual(inserted.length, 1);
});

// Integration test: needs a real MySQL (DB_* env vars). Skipped when DB_PASSWORD is unset.
test('usersStore no MySQL', { skip: !process.env.DB_PASSWORD && 'DB_PASSWORD nao definido' }, async () => {
    const { connect } = require('../src/db/mysql');
    const { createUsersStore } = require('../src/db/usersStore');
    const db = await connect();
    const users = createUsersStore(db);

    try {
        await db.query("DELETE FROM users WHERE username IN ('teste.a', 'teste.b')");
        const a = await users.createUser(' Teste.A ', 'senha-a-123');
        assert.strictEqual(a.username, 'teste.a');
        await assert.rejects(users.createUser('teste.a', 'outra-senha'), /já existe/);
        await assert.rejects(users.createUser('ab', 'senha-longa'), /3 a 32/);
        await assert.rejects(users.createUser('teste.c', 'curta'), /8 caracteres/);

        await assert.rejects(users.login('teste.a', 'errada'), /incorretos/);
        await assert.rejects(users.login('nao.existe', 'qualquer'), /incorretos/);
        const { token } = await users.login('TESTE.A', 'senha-a-123');
        assert.deepStrictEqual(await users.getSessionUser(token), { id: a.id, username: 'teste.a' });
        assert.strictEqual(await users.getSessionUser('token-falso'), null);

        await assert.rejects(users.deleteUser(a.id, a.id), /próprio/);
        const b = await users.createUser('teste.b', 'senha-b-123');
        await users.deleteUser(a.id, b.id);
        assert.strictEqual(await users.getSessionUser(token), null, 'sessao some junto com o usuario');

        const second = await users.login('teste.b', 'senha-b-123');
        await users.logout(second.token);
        assert.strictEqual(await users.getSessionUser(second.token), null);
    } finally {
        await db.query("DELETE FROM users WHERE username IN ('teste.a', 'teste.b')");
        await db.end();
    }
});
