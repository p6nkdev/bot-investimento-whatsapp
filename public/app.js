// ---------- API ----------

async function request(method, url, body) {
    const response = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
        location.href = '/login.html';
        throw new Error(data.error || 'Sessão expirada.');
    }
    if (!response.ok) {
        throw new Error(data.error || `Erro ${response.status} ao falar com o servidor.`);
    }
    return data;
}

const api = {
    me: () => request('GET', '/api/me'),
    logout: () => request('POST', '/api/logout'),
    listUsers: () => request('GET', '/api/users'),
    createUser: (user) => request('POST', '/api/users', user),
    deleteUser: (id) => request('DELETE', `/api/users/${id}`),
    whatsappStatus: () => request('GET', '/api/whatsapp'),
    whatsappConnect: () => request('POST', '/api/whatsapp/connect'),
    whatsappLogout: () => request('POST', '/api/whatsapp/logout'),
    whatsappGroups: () => request('GET', '/api/whatsapp/groups'),
    getConfig: () => request('GET', '/api/config'),
    saveChatId: (chatId) => request('PUT', '/api/config', { chatId }),
    getPrices: () => request('GET', '/api/prices'),
    deleteCoin: (symbol) => request('DELETE', `/api/coins/${symbol}`),
    saveCoin: (coin, editingSymbol) => editingSymbol
        ? request('PUT', `/api/coins/${editingSymbol}`, coin)
        : request('POST', '/api/coins', coin),
};

// ---------- Estado e utilitários ----------

const state = {
    me: null,
    coins: [],
    prices: new Map(),
    pricesAt: null,
    chatId: '',
    whatsapp: { status: 'connecting' },
    groups: [],
};

const $ = (selector) => document.querySelector(selector);
const chatForm = $('#group-form');
const usersDialog = $('#users-dialog');
const userForm = $('#user-form');
const coinDialog = $('#coin-dialog');
const coinForm = $('#coin-form');
const coinList = $('#coin-list');
const toast = $('#toast');

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function formatMoney(value, quote = 'BRL') {
    const number = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return 'Indisponível';

    if (quote === 'BRL') {
        return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }
    return `${number.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${quote}`;
}

function formatSigned(value, quote) {
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatMoney(Math.abs(value), quote)}`;
}

function formatPercent(value) {
    const text = Math.abs(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${text}%`;
}

// The toast is a popover so it renders above an open <dialog> instead of under its backdrop.
function showToast(message) {
    toast.textContent = message;
    if (toast.matches(':popover-open')) toast.hidePopover();
    toast.showPopover();
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => toast.hidePopover(), 2800);
}

// Every handler goes through here so failures show up instead of disappearing.
function handle(action) {
    return (event) => Promise.resolve(action(event)).catch((error) => showToast(error.message));
}

// ---------- Cálculo da faixa de alerta ----------

function currentPrice(coin) {
    return state.prices.get(coin.symbol) ?? coin.history.at(-1) ?? null;
}

// Where the price sits between the two triggers: position 0% = alerta de queda, 50% = referência, 100% = alerta de alta.
function alertBand(coin, price) {
    const reference = coin.lastValue;
    if (reference === null || price === null) {
        return { ready: false, progress: 0 };
    }

    const difference = price - reference;
    const rising = difference >= 0;
    const limit = rising ? coin.alertUp : coin.alertDown;
    const progress = limit > 0 ? Math.min(Math.abs(difference) / limit, 1) : 0;

    return {
        ready: true,
        reference,
        difference,
        rising,
        limit,
        progress,
        position: 50 + (rising ? 1 : -1) * progress * 50,
    };
}

function bandNote(coin, band) {
    const direction = band.rising ? 'alta' : 'queda';

    if (!coin.enabled) return 'Pausado. Nenhum alerta é enviado.';
    if (!band.ready) return 'Aguardando a primeira leitura de preço.';
    if (band.difference === 0) return 'No preço de referência.';
    if (band.limit === 0) return `Em ${direction}, mas o alerta de ${direction} está desligado.`;
    if (band.progress >= 1) return `Alerta de ${direction} sai na próxima checagem.`;
    return `Faltam ${formatMoney(band.limit - Math.abs(band.difference), coin.quote)} para o alerta de ${direction}.`;
}

// ---------- Renderização ----------

function sparkline(history) {
    if (history.length < 2) return '<span class="spark-empty">Sem histórico</span>';

    const min = Math.min(...history);
    const range = Math.max(...history) - min || 1;
    const points = history
        .map((value, index) => `${(index / (history.length - 1)) * 100},${30 - ((value - min) / range) * 30}`)
        .join(' ');

    return `
        <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img"
             aria-label="Últimos ${history.length} preços registrados">
            <polyline points="${points}" />
        </svg>`;
}

function bandMarkup(coin, band) {
    const quote = coin.quote;
    const fillStart = Math.min(50, band.position ?? 50);
    const fillWidth = Math.abs((band.position ?? 50) - 50);
    // Without a reference price yet, show the configured variation instead of absolute trigger prices.
    const low = !coin.alertDown ? 'Sem alerta de queda'
        : band.ready ? formatMoney(band.reference - coin.alertDown, quote) : `−${formatMoney(coin.alertDown, quote)}`;
    const high = !coin.alertUp ? 'Sem alerta de alta'
        : band.ready ? formatMoney(band.reference + coin.alertUp, quote) : `+${formatMoney(coin.alertUp, quote)}`;

    return `
        <div class="band">
            <div class="band-track" aria-hidden="true">
                <span class="band-half ${coin.alertDown > 0 ? '' : 'off'}"></span>
                <span class="band-half ${coin.alertUp > 0 ? '' : 'off'}"></span>
                ${band.ready ? `
                    <span class="band-fill ${band.rising ? 'is-up' : 'is-down'}" style="left:${fillStart}%;width:${fillWidth}%"></span>
                    <span class="band-ref"></span>
                    <span class="band-marker" style="left:${band.position}%"></span>` : ''}
            </div>
            <div class="band-ends num"><span>${low}</span><span>${high}</span></div>
            <p class="band-note">${bandNote(coin, band)}</p>
        </div>`;
}

function coinRow({ coin, price, band }) {
    const change = band.ready && band.difference !== 0
        ? `<span class="change ${band.rising ? 'is-up' : 'is-down'}" title="Variação desde o último alerta">
               ${formatSigned(band.difference, coin.quote)} (${formatPercent(band.difference / band.reference * 100)})
           </span>`
        : '';

    return `
        <article class="coin-row ${coin.enabled ? '' : 'paused'}" data-symbol="${escapeHtml(coin.symbol)}">
            <div>
                <div class="coin-symbol">${escapeHtml(coin.symbol)}<small>/${escapeHtml(coin.quote)}</small></div>
                <div class="coin-name">${escapeHtml(coin.name)}, ${coin.type === 'acao' ? 'ação' : 'cripto'}</div>
            </div>
            <div class="spark-cell">${sparkline(coin.history)}</div>
            <div class="price num">${formatMoney(price, coin.quote)}${change}</div>
            ${bandMarkup(coin, band)}
            <div class="row-actions">
                <button class="link-button" type="button" data-action="edit">Editar</button>
                <button class="link-button danger" type="button" data-action="delete">Excluir</button>
            </div>
        </article>`;
}

// Active assets closest to firing come first; paused ones go last.
function sortedRows() {
    return state.coins
        .map((coin) => {
            const price = currentPrice(coin);
            return { coin, price, band: alertBand(coin, price) };
        })
        .sort((a, b) => (b.coin.enabled - a.coin.enabled)
            || (b.band.progress - a.band.progress)
            || a.coin.symbol.localeCompare(b.coin.symbol));
}

function renderSummary() {
    const total = state.coins.length;
    const paused = state.coins.filter((coin) => !coin.enabled).length;
    const parts = [`${total} ${total === 1 ? 'ativo' : 'ativos'}`];

    if (paused) parts.push(`${paused} ${paused === 1 ? 'pausado' : 'pausados'}`);
    if (state.pricesAt) {
        parts.push(`preços de ${state.pricesAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
    }
    $('#summary').textContent = total ? `${parts.join(', ')}.` : '';
}

function renderCoins() {
    renderSummary();

    coinList.innerHTML = state.coins.length
        ? sortedRows().map(coinRow).join('')
        : `<div class="empty-state">
               <p>Nenhum ativo monitorado ainda. Adicione uma cripto ou ação para o robô começar a acompanhar o preço.</p>
               <button class="button button-primary" type="button" data-action="new">Adicionar ativo</button>
           </div>`;
}

// ---------- Formulário de ativo ----------

function openCoinForm(coin) {
    coinForm.reset();
    coinForm.elements.editingSymbol.value = coin?.symbol ?? ''; // reset() does not clear hidden inputs
    coinForm.elements.symbol.readOnly = Boolean(coin);
    $('#form-title').textContent = coin ? `Editar ${coin.symbol}` : 'Novo ativo';

    if (coin) {
        for (const field of coinForm.elements) {
            if (!(field.name in coin)) continue;
            if (field.type === 'checkbox') field.checked = coin[field.name];
            else field.value = coin[field.name];
        }
    }

    coinDialog.showModal();
    (coin ? coinForm.elements.name : coinForm.elements.type).focus();
}

function readCoinForm() {
    const data = Object.fromEntries(new FormData(coinForm));
    return {
        type: data.type,
        symbol: data.symbol,
        name: data.name,
        quote: data.quote,
        alertUp: Number(data.alertUp),
        alertDown: Number(data.alertDown),
        enabled: data.enabled === 'on',
    };
}

// ---------- WhatsApp ----------

const MANUAL_CHAT = '__manual';
let whatsappTimer = null;

function renderWhatsapp() {
    const { status, qrSvg, account } = state.whatsapp;
    const views = {
        connected: `
            <p class="wa-line"><span class="dot is-on"></span>
                Conectado como <strong>${escapeHtml(account?.name || 'robô')}</strong>
                <span class="num">+${escapeHtml(account?.id || '')}</span></p>
            <button class="link-button danger" type="button" data-wa="logout">Desconectar</button>`,
        qr: `
            <div class="wa-qr">
                <div class="qr-code" role="img" aria-label="QR Code para conectar o WhatsApp">${qrSvg}</div>
                <ol>
                    <li>Abra o WhatsApp no celular do número que vai enviar os alertas.</li>
                    <li>Toque em Configurações, depois em Aparelhos conectados e em Conectar aparelho.</li>
                    <li>Aponte a câmera para este código. Ele se renova sozinho.</li>
                </ol>
            </div>`,
        connecting: '<p class="wa-line"><span class="dot"></span>Conectando ao WhatsApp…</p>',
        disconnected: `
            <p class="wa-line"><span class="dot is-off"></span>Desconectado. Nenhum alerta está sendo enviado.</p>
            <button class="button button-primary" type="button" data-wa="connect">Conectar WhatsApp</button>`,
        disabled: '<p class="wa-line">O WhatsApp está desativado neste servidor (PANEL_ONLY=true).</p>',
    };
    $('#whatsapp-status').innerHTML = views[status] ?? views.connecting;
}

function renderChatSelect() {
    const select = chatForm.elements.chatSelect;
    const input = chatForm.elements.chatId;
    const connected = state.whatsapp.status === 'connected';
    const known = state.groups.some((group) => group.id === state.chatId);

    select.innerHTML = [
        state.chatId ? '' : '<option value="" disabled>Escolha uma conversa</option>',
        ...state.groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}${group.size ? ` (${group.size} pessoas)` : ''}</option>`),
        `<option value="${MANUAL_CHAT}">Outra conversa (digitar o ID)</option>`,
    ].join('');

    select.value = known ? state.chatId : state.chatId ? MANUAL_CHAT : '';
    input.value = known ? '' : state.chatId;
    input.hidden = select.value !== MANUAL_CHAT;

    $('#chat-hint').textContent = !connected
        ? 'Conecte o WhatsApp para escolher um grupo da lista.'
        : !state.groups.length
            ? 'O número conectado não participa de nenhum grupo.'
            : state.chatId && !known
                ? 'A conversa salva não é um dos grupos deste número.'
                : '';
}

async function loadGroups() {
    state.groups = state.whatsapp.status === 'connected' ? await api.whatsappGroups() : [];
    renderChatSelect();
}

async function refreshWhatsapp() {
    const wasConnected = state.whatsapp.status === 'connected';
    state.whatsapp = await api.whatsappStatus();
    renderWhatsapp();

    if (wasConnected !== (state.whatsapp.status === 'connected')) await loadGroups();
}

// Polls fast while waiting for the QR scan, slowly otherwise.
async function pollWhatsapp() {
    clearTimeout(whatsappTimer);
    await refreshWhatsapp().catch((error) => showToast(error.message));
    clearTimeout(whatsappTimer);
    const waiting = ['connecting', 'qr'].includes(state.whatsapp.status);
    whatsappTimer = setTimeout(pollWhatsapp, waiting ? 2500 : 30000);
}

async function onWhatsappClick(event) {
    const action = event.target.closest('button[data-wa]')?.dataset.wa;

    if (action === 'connect') {
        await api.whatsappConnect();
        await pollWhatsapp();
    }

    if (action === 'logout' && confirm('Desconectar o WhatsApp? O robô para de enviar alertas até ser conectado de novo.')) {
        await api.whatsappLogout();
        showToast('WhatsApp desconectado.');
        await pollWhatsapp();
    }
}

// ---------- Usuários ----------

async function renderUsers() {
    const users = await api.listUsers();
    $('#user-list').innerHTML = users.map((user) => {
        const isMe = user.id === state.me.id;
        return `
            <li>
                <span>${escapeHtml(user.username)}${isMe ? ' <small>(você)</small>' : ''}</span>
                ${isMe || users.length === 1 ? '' : `<button class="link-button danger" type="button"
                    data-user-id="${user.id}" data-username="${escapeHtml(user.username)}">Excluir</button>`}
            </li>`;
    }).join('');
}

async function openUsers() {
    await renderUsers();
    usersDialog.showModal();
    userForm.elements.username.focus();
}

async function addUser(event) {
    event.preventDefault();
    const user = await api.createUser(Object.fromEntries(new FormData(userForm)));
    userForm.reset();
    showToast(`${user.username} adicionado.`);
    await renderUsers();
}

async function onUserListClick(event) {
    const button = event.target.closest('button[data-user-id]');
    if (!button || !confirm(`Excluir o usuário ${button.dataset.username}? Ele perde o acesso ao painel na hora.`)) return;

    await api.deleteUser(button.dataset.userId);
    showToast(`${button.dataset.username} excluído.`);
    await renderUsers();
}

async function logout() {
    await api.logout();
    location.href = '/login.html';
}

// ---------- Ações ----------

async function loadConfig() {
    const config = await api.getConfig();
    state.coins = config.coins;
    state.chatId = config.chatId;
    renderChatSelect();
    renderCoins();
}

async function refreshPrices() {
    const button = $('#refresh-prices');
    button.setAttribute('aria-busy', 'true');

    try {
        const prices = await api.getPrices();
        state.prices = new Map(prices.filter((item) => item.price !== null).map((item) => [item.symbol, item.price]));
        state.pricesAt = new Date();
        renderCoins();
    } finally {
        button.removeAttribute('aria-busy');
    }
}

async function saveChatId(event) {
    event.preventDefault();
    const { chatSelect, chatId } = chatForm.elements;
    const value = (chatSelect.value === MANUAL_CHAT ? chatId.value : chatSelect.value).trim();
    if (!value) throw new Error('Escolha a conversa que vai receber os alertas.');

    state.chatId = (await api.saveChatId(value)).chatId;
    renderChatSelect();
    showToast('Conversa salva.');
}

async function saveCoin(event) {
    event.preventDefault();
    const coin = await api.saveCoin(readCoinForm(), coinForm.elements.editingSymbol.value);

    coinDialog.close();
    showToast(`${coin.symbol} salvo.`);
    await loadConfig();
}

async function onCoinListClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    if (button.dataset.action === 'new') {
        openCoinForm();
        return;
    }

    const symbol = button.closest('.coin-row')?.dataset.symbol;
    if (!symbol) return;

    if (button.dataset.action === 'edit') {
        openCoinForm(state.coins.find((coin) => coin.symbol === symbol));
    }

    if (button.dataset.action === 'delete' && confirm(`Excluir ${symbol} e todo o histórico de preços?`)) {
        await api.deleteCoin(symbol);
        showToast(`${symbol} excluído.`);
        await loadConfig();
    }
}

// ---------- Inicialização ----------

chatForm.addEventListener('submit', handle(saveChatId));
chatForm.elements.chatSelect.addEventListener('change', () => {
    const manual = chatForm.elements.chatSelect.value === MANUAL_CHAT;
    chatForm.elements.chatId.hidden = !manual;
    if (manual) chatForm.elements.chatId.focus();
});
coinForm.addEventListener('submit', handle(saveCoin));
coinList.addEventListener('click', handle(onCoinListClick));
$('#new-coin').addEventListener('click', () => openCoinForm());
$('#cancel-form').addEventListener('click', () => coinDialog.close());
$('#refresh-prices').addEventListener('click', handle(refreshPrices));
$('#whatsapp-status').addEventListener('click', handle(onWhatsappClick));
$('#open-users').addEventListener('click', handle(openUsers));
$('#close-users').addEventListener('click', () => usersDialog.close());
$('#user-list').addEventListener('click', handle(onUserListClick));
userForm.addEventListener('submit', handle(addUser));
$('#logout').addEventListener('click', handle(logout));

handle(async () => {
    state.me = await api.me();
    $('#current-user').textContent = state.me.username;
    pollWhatsapp();
    await loadConfig();
    await refreshPrices();
})();
