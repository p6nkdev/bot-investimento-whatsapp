const { connect } = require('./src/db/mysql');
const { createCoinsStore } = require('./src/db/coinsStore');
const { createUsersStore } = require('./src/db/usersStore');
const { createPriceMonitor } = require('./src/monitor/priceMonitor');
const { startPanelServer } = require('./src/server/panelServer');
const { createWhatsAppBot } = require('./src/bot/whatsapp');

const PORT = Number(process.env.PORT || 4738);

async function main() {
    const db = await connect();
    const store = createCoinsStore(db);
    const users = createUsersStore(db);
    await users.ensureInitialUser(process.env.PANEL_USER, process.env.PANEL_PASSWORD);

    let bot = null;
    if (process.env.PANEL_ONLY !== 'true') {
        bot = createWhatsAppBot({ store, monitor: createPriceMonitor(store) });
        bot.startBot();
    }

    startPanelServer({ store, users, bot, port: PORT });
}

main().catch((error) => {
    console.error('Falha ao iniciar:', error.message || error.code || error);
    process.exit(1);
});
