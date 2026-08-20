const MODULE_NAME = 'secure_lock';
const EXTENSION_FOLDER = 'third-party/secure-lock-extension';
const SETTINGS_ROOT_ID = 'secure-lock-settings-root';
const VERSION = '0.2.0';
const FRAME_START = '[[SECURE_LOCK_SYNC_V1]]';
const FRAME_END = '[[/SECURE_LOCK_SYNC_V1]]';
const POCKET_PHONE_MODULE = 'pocket-phone';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    atmPin: '2580',
    card: {
        bankName: '',
        holder: '',
        number: '',
        expiry: '',
        cvv: '',
        network: 'SECURE',
        theme: 'obsidian',
    },
    generatedCard: {
        bankName: '',
        holder: '',
        number: '',
        expiry: '',
        cvv: '',
        network: '',
    },
    localWallet: {
        balance: 50000,
        currency: '$',
        account: '',
        history: [],
    },
    processedFrames: [],
});

const CARD_THEMES = new Set(['obsidian', 'sapphire', 'emerald', 'crimson', 'pearl']);
let currentAtmContext = null;
let atmState = 'insert';
let atmPinBuffer = '';
let atmDrag = { x: 0, y: 0 };
let frameWatchTimer = null;
let frameObserver = null;
let settingsStatusTimer = null;

function getContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch (error) {
        console.warn('[Secure Lock] Could not access SillyTavern context.', error);
        return null;
    }
}

function cloneDefaults() {
    try { return structuredClone(DEFAULT_SETTINGS); }
    catch { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
}

function mergeDefaults(target, defaults) {
    if (!target || typeof target !== 'object') target = {};
    for (const [key, value] of Object.entries(defaults)) {
        if (!(key in target)) {
            target[key] = value && typeof value === 'object' && !Array.isArray(value)
                ? mergeDefaults({}, value)
                : Array.isArray(value) ? [...value] : value;
            continue;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            target[key] = mergeDefaults(target[key], value);
        }
    }
    return target;
}

function getSettings(context = getContext()) {
    if (!context?.extensionSettings) return cloneDefaults();
    if (!context.extensionSettings[MODULE_NAME]) context.extensionSettings[MODULE_NAME] = cloneDefaults();
    return mergeDefaults(context.extensionSettings[MODULE_NAME], DEFAULT_SETTINGS);
}

function saveSettings(context = getContext()) {
    try { context?.saveSettingsDebounced?.(); }
    catch (error) { console.warn('[Secure Lock] Could not save settings.', error); }
}

function sanitizeDigits(value, max = 19) {
    return String(value || '').replace(/\D/g, '').slice(0, max);
}

function normalizeExpiry(value) {
    const raw = String(value || '').replace(/[^0-9/]/g, '').slice(0, 5);
    if (/^\d{3,4}$/.test(raw)) return `${raw.slice(0, 2)}/${raw.slice(2)}`;
    return raw;
}

function formatCardNumber(value) {
    const digits = sanitizeDigits(value, 19);
    if (!digits) return '••••  ••••  ••••  ••••';
    return digits.replace(/(.{4})/g, '$1 ').trim();
}

function maskCvv(value) {
    const v = sanitizeDigits(value, 4);
    return v || '•••';
}

function currentUserName() {
    const c = getContext();
    try {
        return String(c?.name1 || c?.user_name || c?.powerUserSettings?.persona_name || 'CARD HOLDER').trim() || 'CARD HOLDER';
    } catch { return 'CARD HOLDER'; }
}

function fallbackCardNumber() {
    const c = getContext();
    const seed = `${c?.chatId ?? ''}:${c?.characterId ?? ''}:${currentUserName()}`;
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    let digits = '5412';
    let x = hash >>> 0;
    for (let i = 0; i < 12; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        digits += String(x % 10);
    }
    return digits;
}

function fallbackExpiry() {
    const d = new Date();
    const year = (d.getFullYear() + 4) % 100;
    return `12/${String(year).padStart(2, '0')}`;
}

function effectiveCard(settings = getSettings()) {
    const custom = settings.card || {};
    const generated = settings.generatedCard || {};
    return {
        bankName: String(custom.bankName || generated.bankName || 'Northstar Bank'),
        holder: String(custom.holder || generated.holder || currentUserName()).toUpperCase(),
        number: sanitizeDigits(custom.number || generated.number || fallbackCardNumber(), 19),
        expiry: normalizeExpiry(custom.expiry || generated.expiry || fallbackExpiry()),
        cvv: sanitizeDigits(custom.cvv || generated.cvv || '258', 4),
        network: String(custom.network || generated.network || 'SECURE').toUpperCase(),
        theme: CARD_THEMES.has(custom.theme) ? custom.theme : 'obsidian',
    };
}

function currentCharacterId() {
    const c = getContext();
    try {
        if (c && c.characterId != null && Array.isArray(c.characters)) {
            const ch = c.characters[c.characterId];
            if (ch) return ch.avatar || ch.name || String(c.characterId);
        }
    } catch {}
    return 'global';
}

function currentChatId() {
    const c = getContext();
    try {
        if (c?.chatId != null) return String(c.chatId);
        if (typeof c?.getCurrentChatId === 'function') {
            const id = c.getCurrentChatId();
            if (id != null) return String(id);
        }
    } catch {}
    return '';
}

function pocketPhoneConfig() {
    const c = getContext();
    const cfg = c?.extensionSettings?.[POCKET_PHONE_MODULE];
    return cfg && typeof cfg === 'object' ? cfg : null;
}

function pocketWalletRoute(cfg, create = false) {
    if (!cfg?.walletPerChat) return null;
    if (!cfg.walletRoutes || typeof cfg.walletRoutes !== 'object') {
        if (!create) return null;
        cfg.walletRoutes = {};
    }
    const cid = currentCharacterId();
    const chat = currentChatId();
    const key = chat ? `${cid}::${chat}` : String(cid || 'global');
    if (!cfg.walletRoutes[key] && create) {
        cfg.walletRoutes[key] = {
            balance: Math.round(Number(cfg.walletBalance) || 0),
            history: [],
            botWallets: {},
        };
    }
    const route = cfg.walletRoutes[key] || null;
    if (route && create) {
        if (!Array.isArray(route.history)) route.history = [];
        if (!route.botWallets || typeof route.botWallets !== 'object') route.botWallets = {};
    }
    return route;
}

function readWallet() {
    const settings = getSettings();
    const pp = pocketPhoneConfig();
    if (pp) {
        const route = pocketWalletRoute(pp, false);
        const balance = route ? Number(route.balance) || 0 : Number(pp.walletBalance) || 0;
        return {
            connected: true,
            source: 'Pocket Phone',
            balance,
            currency: String(pp.walletCurrency || '฿'),
            account: String(pp.walletAccount || ''),
            name: String(pp.walletName || currentUserName()),
            config: pp,
            route,
        };
    }
    const local = settings.localWallet || {};
    return {
        connected: false,
        source: 'Secure Lock local fallback',
        balance: Number(local.balance) || 0,
        currency: String(local.currency || currentAtmContext?.currency || '$'),
        account: String(local.account || ''),
        name: currentUserName(),
        config: null,
        route: null,
    };
}

function walletHistoryTarget(wallet, create = true) {
    if (wallet.connected) {
        const cfg = wallet.config;
        const route = pocketWalletRoute(cfg, create);
        if (route) return route.history;
        if (!Array.isArray(cfg.walletHistory) && create) cfg.walletHistory = [];
        return Array.isArray(cfg.walletHistory) ? cfg.walletHistory : [];
    }
    const settings = getSettings();
    if (!Array.isArray(settings.localWallet.history) && create) settings.localWallet.history = [];
    return settings.localWallet.history;
}

function writeWalletBalance(nextBalance, meta = {}) {
    const c = getContext();
    const wallet = readWallet();
    const next = Math.max(0, Math.round(Number(nextBalance) || 0));
    if (wallet.connected) {
        const route = pocketWalletRoute(wallet.config, true);
        if (route) route.balance = next;
        else wallet.config.walletBalance = next;
    } else {
        getSettings().localWallet.balance = next;
    }
    const amount = Math.max(0, Math.round(Number(meta.amount) || 0));
    if (amount > 0) {
        const history = walletHistoryTarget(wallet, true);
        history.push({
            id: `sl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            dir: meta.dir === 'in' ? 'in' : 'out',
            amount,
            cid: null,
            name: String(meta.name || currentAtmContext?.bankName || 'ATM'),
            note: String(meta.note || 'ATM transaction via Secure Lock'),
            ts: Date.now(),
        });
        if (history.length > 200) history.splice(0, history.length - 200);
    }
    saveSettings(c);
    const detail = { balance: next, currency: wallet.currency, source: wallet.source, ...meta };
    try { globalThis.dispatchEvent(new CustomEvent('secure-lock:wallet-changed', { detail })); } catch {}
    try { globalThis.dispatchEvent(new CustomEvent('pocket-phone:external-wallet-change', { detail })); } catch {}
    updateIntegrationStatus();
    return next;
}

function formatMoney(value, currency) {
    const n = Math.round(Number(value) || 0);
    const symbol = String(currency || '$');
    return `${symbol}${n.toLocaleString('en-US')}`;
}

function findSettingsHost() {
    return document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
}

function setInputValue(root, selector, value) {
    const el = root.querySelector(selector);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = value ?? '';
}

function bindSettings(context, root, settings) {
    const enabled = root.querySelector('#secure-lock-enabled');
    if (enabled instanceof HTMLInputElement) {
        enabled.checked = Boolean(settings.enabled);
        enabled.addEventListener('change', () => {
            settings.enabled = enabled.checked;
            saveSettings(context);
        });
    }

    const fields = [
        ['#secure-lock-card-bank', 'bankName'],
        ['#secure-lock-card-holder', 'holder'],
        ['#secure-lock-card-number', 'number'],
        ['#secure-lock-card-expiry', 'expiry'],
        ['#secure-lock-card-cvv', 'cvv'],
        ['#secure-lock-card-network', 'network'],
        ['#secure-lock-card-theme', 'theme'],
    ];
    for (const [selector, key] of fields) setInputValue(root, selector, settings.card?.[key] || '');
    setInputValue(root, '#secure-lock-atm-pin', settings.atmPin || '2580');

    root.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
        const cardKey = target.dataset.cardKey;
        if (cardKey) {
            let value = target.value;
            if (cardKey === 'number') value = sanitizeDigits(value, 19);
            if (cardKey === 'cvv') value = sanitizeDigits(value, 4);
            if (cardKey === 'expiry') value = normalizeExpiry(value);
            if (cardKey === 'theme' && !CARD_THEMES.has(value)) value = 'obsidian';
            settings.card[cardKey] = value;
            saveSettings(context);
            updateCardPreview();
            return;
        }
        if (target.id === 'secure-lock-atm-pin') {
            settings.atmPin = sanitizeDigits(target.value, 8) || '2580';
            target.value = settings.atmPin;
            saveSettings(context);
        }
    });

    root.querySelector('#secure-lock-open-card')?.addEventListener('click', openCardPreview);
    root.querySelector('#secure-lock-test-atm')?.addEventListener('click', () => {
        openAtm({
            bankName: effectiveCard(settings).bankName || 'Northstar Bank',
            branch: 'Preview Terminal',
            terminalId: 'SL-DEMO-01',
            location: 'Secure Lock test',
            currency: readWallet().currency,
            reason: 'manual_preview',
        });
    });
    root.querySelector('#secure-lock-clear-auto-card')?.addEventListener('click', () => {
        settings.generatedCard = cloneDefaults().generatedCard;
        saveSettings(context);
        updateCardPreview();
        showToast('AI-generated card fallback cleared');
    });

    updateIntegrationStatus();
}

async function buildSettingsDrawer(context) {
    if (document.getElementById(SETTINGS_ROOT_ID)) return true;
    const host = findSettingsHost();
    if (!host) return false;
    let html = '';
    try {
        html = await context?.renderExtensionTemplateAsync?.(EXTENSION_FOLDER, 'settings', { version: VERSION });
    } catch (error) {
        console.error('[Secure Lock] Failed to render settings drawer.', error);
        return false;
    }
    if (!html) return false;
    host.insertAdjacentHTML('beforeend', html);
    const root = document.getElementById(SETTINGS_ROOT_ID);
    if (!root) return false;
    bindSettings(context, root, getSettings(context));
    return true;
}

function updateIntegrationStatus() {
    const root = document.getElementById(SETTINGS_ROOT_ID);
    if (!root) return;
    const badge = root.querySelector('#secure-lock-pocket-status');
    const detail = root.querySelector('#secure-lock-pocket-detail');
    const wallet = readWallet();
    if (badge) {
        badge.textContent = wallet.connected ? 'Connected' : 'Fallback';
        badge.classList.toggle('is-connected', wallet.connected);
    }
    if (detail) {
        detail.textContent = wallet.connected
            ? `Pocket Phone wallet • ${formatMoney(wallet.balance, wallet.currency)}`
            : 'Pocket Phone not detected yet • ATM uses Secure Lock local fallback';
    }
}

function ensureOverlayRoot() {
    let root = document.getElementById('secure-lock-overlay-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'secure-lock-overlay-root';
    root.innerHTML = `
        <div class="sl-backdrop" id="sl-card-backdrop" hidden></div>
        <section class="sl-card-modal" id="sl-card-modal" hidden aria-label="ATM card preview">
            <div class="sl-modal-head">
                <div><strong>ATM Card</strong><span>Tap the card to flip</span></div>
                <button class="sl-icon-btn" id="sl-card-close" aria-label="Close">×</button>
            </div>
            <button class="sl-bank-card-wrap" id="sl-card-flip" type="button" aria-label="Flip ATM card">
                <div class="sl-bank-card" id="sl-bank-card">
                    <div class="sl-card-face sl-card-front" id="sl-card-front"></div>
                    <div class="sl-card-face sl-card-back" id="sl-card-back"></div>
                </div>
            </button>
            <div class="sl-card-actions"><button class="sl-button" id="sl-card-flip-btn">Flip card</button></div>
        </section>

        <div class="sl-atm-backdrop" id="sl-atm-backdrop" hidden></div>
        <section class="sl-atm-window" id="sl-atm-window" hidden aria-label="ATM interaction">
            <header class="sl-atm-titlebar" id="sl-atm-dragbar">
                <div class="sl-atm-title-copy"><strong id="sl-atm-title">ATM</strong><span id="sl-atm-subtitle">Secure terminal</span></div>
                <div class="sl-atm-window-actions">
                    <button class="sl-icon-btn" id="sl-atm-center" title="Center">◎</button>
                    <button class="sl-icon-btn" id="sl-atm-close" title="Close">×</button>
                </div>
            </header>
            <div class="sl-atm-layout">
                <main class="sl-atm-screen-panel">
                    <div class="sl-atm-bankline"><strong id="sl-atm-bank">Bank</strong><span id="sl-atm-terminal">TERMINAL</span></div>
                    <div class="sl-atm-screen" id="sl-atm-screen"></div>
                </main>
                <aside class="sl-atm-hardware">
                    <div class="sl-hardware-block">
                        <span class="sl-hardware-label">CARD READER</span>
                        <div class="sl-card-slot"><div class="sl-mini-card" id="sl-mini-card"></div></div>
                    </div>
                    <div class="sl-hardware-block">
                        <span class="sl-hardware-label">PIN PAD</span>
                        <div class="sl-pinpad" id="sl-pinpad"></div>
                    </div>
                </aside>
            </div>
        </section>
        <div class="sl-toast" id="sl-toast" aria-live="polite"></div>
    `;
    document.body.appendChild(root);
    bindOverlayEvents(root);
    return root;
}

function cardMarkup(card, back = false) {
    if (back) {
        return `
            <div class="sl-card-back-top"><span>${escapeHtml(card.bankName)}</span><span>${escapeHtml(card.network)}</span></div>
            <div class="sl-card-stripe"></div>
            <div class="sl-signature-row"><div class="sl-signature">AUTHORIZED SIGNATURE</div><div class="sl-cvv"><small>CVV</small><b>${escapeHtml(maskCvv(card.cvv))}</b></div></div>
            <div class="sl-card-back-copy">Use of this card is subject to the account agreement. If found, return to the issuing bank.</div>
            <div class="sl-card-back-footer"><span>${escapeHtml(card.bankName)}</span><span>SECURE • CONTACTLESS</span></div>
        `;
    }
    return `
        <div class="sl-card-top"><div class="sl-card-bank">${escapeHtml(card.bankName)}</div><div class="sl-contactless">)))</div></div>
        <div class="sl-gold-chip" aria-label="Gold chip"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="sl-card-number">${escapeHtml(formatCardNumber(card.number))}</div>
        <div class="sl-card-bottom">
            <div><small>CARD HOLDER</small><b>${escapeHtml(card.holder)}</b></div>
            <div><small>VALID THRU</small><b>${escapeHtml(card.expiry)}</b></div>
            <div class="sl-network">${escapeHtml(card.network)}</div>
        </div>
    `;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function updateCardPreview() {
    const root = ensureOverlayRoot();
    const card = effectiveCard();
    const bankCard = root.querySelector('#sl-bank-card');
    const front = root.querySelector('#sl-card-front');
    const back = root.querySelector('#sl-card-back');
    if (bankCard) bankCard.dataset.theme = card.theme;
    if (front) front.innerHTML = cardMarkup(card, false);
    if (back) back.innerHTML = cardMarkup(card, true);
}

function openCardPreview() {
    const root = ensureOverlayRoot();
    updateCardPreview();
    root.querySelector('#sl-bank-card')?.classList.remove('is-flipped');
    const backdrop = root.querySelector('#sl-card-backdrop');
    const modal = root.querySelector('#sl-card-modal');
    if (backdrop) backdrop.hidden = false;
    if (modal) modal.hidden = false;
}

function closeCardPreview() {
    const root = ensureOverlayRoot();
    const backdrop = root.querySelector('#sl-card-backdrop');
    const modal = root.querySelector('#sl-card-modal');
    if (backdrop) backdrop.hidden = true;
    if (modal) modal.hidden = true;
}

function flipCard() {
    ensureOverlayRoot().querySelector('#sl-bank-card')?.classList.toggle('is-flipped');
}

function bindOverlayEvents(root) {
    root.querySelector('#sl-card-close')?.addEventListener('click', closeCardPreview);
    root.querySelector('#sl-card-backdrop')?.addEventListener('click', closeCardPreview);
    root.querySelector('#sl-card-flip')?.addEventListener('click', flipCard);
    root.querySelector('#sl-card-flip-btn')?.addEventListener('click', flipCard);

    root.querySelector('#sl-atm-close')?.addEventListener('click', closeAtm);
    root.querySelector('#sl-atm-center')?.addEventListener('click', centerAtm);
    root.querySelector('#sl-atm-backdrop')?.addEventListener('click', () => showToast('Use × to close the ATM'));
    root.querySelector('#sl-atm-screen')?.addEventListener('click', onAtmScreenClick);
    root.querySelector('#sl-pinpad')?.addEventListener('click', onPinpadClick);
    bindAtmDrag(root.querySelector('#sl-atm-dragbar'));
}

function showToast(message) {
    const toast = ensureOverlayRoot().querySelector('#sl-toast');
    if (!toast) return;
    toast.textContent = String(message || '');
    toast.classList.add('is-visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

function centerAtm() {
    atmDrag = { x: 0, y: 0 };
    applyAtmPosition();
    showToast('ATM centered');
}

function applyAtmPosition() {
    const win = ensureOverlayRoot().querySelector('#sl-atm-window');
    if (!win) return;
    win.style.setProperty('--sl-drag-x', `${atmDrag.x}px`);
    win.style.setProperty('--sl-drag-y', `${atmDrag.y}px`);
}

function bindAtmDrag(handle) {
    if (!(handle instanceof HTMLElement)) return;
    let drag = null;
    handle.addEventListener('pointerdown', event => {
        if (event.target instanceof Element && event.target.closest('button')) return;
        const win = ensureOverlayRoot().querySelector('#sl-atm-window');
        if (!(win instanceof HTMLElement)) return;
        drag = { x: event.clientX, y: event.clientY, startX: atmDrag.x, startY: atmDrag.y };
        try { handle.setPointerCapture(event.pointerId); } catch {}
    });
    handle.addEventListener('pointermove', event => {
        if (!drag) return;
        const maxX = Math.max(50, window.innerWidth * 0.42);
        const maxY = Math.max(50, window.innerHeight * 0.38);
        atmDrag.x = Math.max(-maxX, Math.min(maxX, drag.startX + event.clientX - drag.x));
        atmDrag.y = Math.max(-maxY, Math.min(maxY, drag.startY + event.clientY - drag.y));
        applyAtmPosition();
    });
    for (const type of ['pointerup', 'pointercancel']) handle.addEventListener(type, () => { drag = null; });
}

function effectiveAtmBank() {
    return String(currentAtmContext?.bankName || currentAtmContext?.bank || effectiveCard().bankName || 'ATM');
}

function renderPinpad() {
    const pad = ensureOverlayRoot().querySelector('#sl-pinpad');
    if (!pad) return;
    pad.innerHTML = `
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="sl-key" data-pin="${n}">${n}</button>`).join('')}
        <button class="sl-key sl-key-cancel" data-atm-action="cancel">C</button>
        <button class="sl-key" data-pin="0">0</button>
        <button class="sl-key sl-key-enter" data-atm-action="enter">✓</button>
    `;
}

function renderAtm() {
    const root = ensureOverlayRoot();
    const screen = root.querySelector('#sl-atm-screen');
    const miniCard = root.querySelector('#sl-mini-card');
    const card = effectiveCard();
    const wallet = readWallet();
    const currency = wallet.connected ? wallet.currency : (currentAtmContext?.currency || wallet.currency);
    if (miniCard) {
        miniCard.classList.toggle('is-inserted', atmState !== 'insert');
        miniCard.dataset.theme = card.theme;
    }
    const bank = effectiveAtmBank();
    const bankEl = root.querySelector('#sl-atm-bank');
    const title = root.querySelector('#sl-atm-title');
    const subtitle = root.querySelector('#sl-atm-subtitle');
    const terminal = root.querySelector('#sl-atm-terminal');
    if (bankEl) bankEl.textContent = bank;
    if (title) title.textContent = bank;
    if (subtitle) subtitle.textContent = currentAtmContext?.location || currentAtmContext?.branch || 'Secure ATM terminal';
    if (terminal) terminal.textContent = currentAtmContext?.terminalId || 'ATM';
    renderPinpad();
    if (!screen) return;

    if (atmState === 'insert') {
        screen.innerHTML = `
            <div class="sl-atm-status"><strong>Insert your card</strong><span>${escapeHtml(bank)} is ready for a transaction.</span></div>
            <div class="sl-atm-card-preview" aria-label="${escapeHtml(card.bankName)} card">
                <div class="sl-bank-card sl-atm-card-display" data-theme="${escapeHtml(card.theme)}">
                    <div class="sl-card-face sl-card-front">${cardMarkup(card, false)}</div>
                </div>
            </div>
            <button class="sl-button sl-button-primary sl-full" data-atm-action="insert">Insert card</button>
        `;
        return;
    }
    if (atmState === 'pin') {
        screen.innerHTML = `
            <div class="sl-atm-status"><strong>Enter PIN</strong><span>Use the keypad on the right or below.</span></div>
            <div class="sl-pin-dots">${[0,1,2,3].map(i => `<i class="${i < atmPinBuffer.length ? 'on' : ''}"></i>`).join('')}</div>
            <div class="sl-mobile-pinpad">${[1,2,3,4,5,6,7,8,9,0].map(n => `<button class="sl-key" data-pin="${n}">${n}</button>`).join('')}<button class="sl-key sl-key-enter" data-atm-action="enter">✓</button></div>
            <button class="sl-button sl-full" data-atm-action="delete-pin">Delete digit</button>
        `;
        return;
    }
    if (atmState === 'menu') {
        screen.innerHTML = `
            <div class="sl-atm-status"><span>Available balance</span><div class="sl-balance">${escapeHtml(formatMoney(wallet.balance, currency))}</div><small>${wallet.connected ? 'Synced with Pocket Phone' : 'Secure Lock local fallback'}</small></div>
            <div class="sl-atm-menu">
                <button class="sl-atm-tile" data-atm-action="withdraw"><b>Withdraw</b><span>Take out cash</span></button>
                <button class="sl-atm-tile" data-atm-action="transfer"><b>Transfer</b><span>Send funds</span></button>
                <button class="sl-atm-tile" data-atm-action="balance"><b>Balance</b><span>Account details</span></button>
                <button class="sl-atm-tile" data-atm-action="deposit"><b>Deposit</b><span>Add cash</span></button>
            </div>
            <button class="sl-button sl-button-danger sl-full" data-atm-action="eject">Eject card</button>
        `;
        return;
    }
    if (atmState === 'balance') {
        const account = wallet.account || `•••• ${card.number.slice(-4)}`;
        screen.innerHTML = `
            <div class="sl-atm-status"><strong>Account overview</strong><div class="sl-balance">${escapeHtml(formatMoney(wallet.balance, currency))}</div><span>${escapeHtml(account)}</span></div>
            <button class="sl-button sl-button-primary sl-full" data-atm-action="menu">Back to menu</button>
        `;
        return;
    }
    if (atmState === 'withdraw') {
        screen.innerHTML = `
            <div class="sl-atm-status"><strong>Withdraw cash</strong><span>Choose an amount</span></div>
            <div class="sl-amount-grid">${[20,50,100,200].map(n => `<button class="sl-button" data-withdraw="${n}">${escapeHtml(formatMoney(n, currency))}</button>`).join('')}</div>
            <input id="sl-custom-withdraw" class="sl-field" inputmode="decimal" placeholder="Custom amount">
            <div class="sl-row"><button class="sl-button" data-atm-action="menu">Back</button><button class="sl-button sl-button-primary" data-atm-action="custom-withdraw">Withdraw</button></div>
        `;
        return;
    }
    if (atmState === 'transfer') {
        screen.innerHTML = `
            <div class="sl-atm-status"><strong>Transfer funds</strong><span>Funds are deducted from the Pocket Phone wallet when connected.</span></div>
            <input id="sl-transfer-to" class="sl-field" placeholder="Recipient / account">
            <input id="sl-transfer-amount" class="sl-field" inputmode="decimal" placeholder="Amount">
            <div class="sl-row"><button class="sl-button" data-atm-action="menu">Back</button><button class="sl-button sl-button-primary" data-atm-action="confirm-transfer">Confirm</button></div>
        `;
        return;
    }
    if (atmState === 'deposit') {
        screen.innerHTML = `
            <div class="sl-atm-status"><strong>Deposit cash</strong><span>Add an amount to the synced wallet.</span></div>
            <input id="sl-deposit-amount" class="sl-field" inputmode="decimal" placeholder="Amount">
            <div class="sl-row"><button class="sl-button" data-atm-action="menu">Back</button><button class="sl-button sl-button-primary" data-atm-action="confirm-deposit">Deposit</button></div>
        `;
        return;
    }
    if (atmState === 'cash') {
        screen.innerHTML = `
            <div class="sl-atm-status"><strong>Take your cash</strong><span>Transaction completed.</span></div>
            <button class="sl-button sl-button-primary sl-full" data-atm-action="menu">Continue</button>
        `;
    }
}

function openAtm(context = {}) {
    if (!getSettings().enabled) return;
    const root = ensureOverlayRoot();
    currentAtmContext = {
        bankName: String(context.bankName || context.bank || 'ATM'),
        branch: String(context.branch || ''),
        terminalId: String(context.terminalId || context.terminal || ''),
        location: String(context.location || ''),
        currency: String(context.currency || ''),
        reason: String(context.reason || ''),
    };
    atmState = 'insert';
    atmPinBuffer = '';
    centerAtm();
    renderAtm();
    const backdrop = root.querySelector('#sl-atm-backdrop');
    const win = root.querySelector('#sl-atm-window');
    if (backdrop) backdrop.hidden = false;
    if (win) win.hidden = false;
}

function closeAtm() {
    const root = ensureOverlayRoot();
    const backdrop = root.querySelector('#sl-atm-backdrop');
    const win = root.querySelector('#sl-atm-window');
    if (backdrop) backdrop.hidden = true;
    if (win) win.hidden = true;
    atmPinBuffer = '';
}

function withdraw(amount) {
    const wallet = readWallet();
    const n = Math.round(Number(amount) || 0);
    if (n <= 0) return showToast('Enter a valid amount');
    if (n > wallet.balance) return showToast('Insufficient balance');
    writeWalletBalance(wallet.balance - n, { dir: 'out', amount: n, name: effectiveAtmBank(), note: 'ATM withdrawal via Secure Lock' });
    atmState = 'cash';
    renderAtm();
    showToast('Cash dispensed');
}

function onAtmScreenClick(event) {
    const withdrawButton = event.target instanceof Element ? event.target.closest('[data-withdraw]') : null;
    if (withdrawButton) return withdraw(withdrawButton.dataset.withdraw);
    const pinButton = event.target instanceof Element ? event.target.closest('[data-pin]') : null;
    if (pinButton) return appendPin(pinButton.dataset.pin);
    const button = event.target instanceof Element ? event.target.closest('[data-atm-action]') : null;
    if (!button) return;
    handleAtmAction(button.dataset.atmAction);
}

function onPinpadClick(event) {
    const pinButton = event.target instanceof Element ? event.target.closest('[data-pin]') : null;
    if (pinButton) return appendPin(pinButton.dataset.pin);
    const button = event.target instanceof Element ? event.target.closest('[data-atm-action]') : null;
    if (button) handleAtmAction(button.dataset.atmAction);
}

function appendPin(digit) {
    if (atmState !== 'pin') return;
    if (atmPinBuffer.length >= 8) return;
    atmPinBuffer += String(digit || '').replace(/\D/g, '').slice(0, 1);
    renderAtm();
}

function handleAtmAction(action) {
    if (action === 'insert') {
        atmState = 'pin'; atmPinBuffer = ''; renderAtm(); return;
    }
    if (action === 'delete-pin') {
        atmPinBuffer = atmPinBuffer.slice(0, -1); renderAtm(); return;
    }
    if (action === 'cancel') {
        atmPinBuffer = ''; atmState = 'insert'; renderAtm(); return;
    }
    if (action === 'enter') {
        if (atmState !== 'pin') return;
        const expected = sanitizeDigits(getSettings().atmPin, 8) || '2580';
        if (atmPinBuffer === expected) {
            atmPinBuffer = ''; atmState = 'menu'; renderAtm(); showToast('Card authenticated');
        } else {
            atmPinBuffer = ''; renderAtm(); showToast(`Incorrect PIN`);
        }
        return;
    }
    if (['menu', 'withdraw', 'transfer', 'balance', 'deposit'].includes(action)) {
        atmState = action; renderAtm(); return;
    }
    if (action === 'eject') { closeAtm(); showToast('Card returned'); return; }
    if (action === 'custom-withdraw') {
        const input = ensureOverlayRoot().querySelector('#sl-custom-withdraw');
        return withdraw(input instanceof HTMLInputElement ? input.value : 0);
    }
    if (action === 'confirm-transfer') {
        const root = ensureOverlayRoot();
        const to = root.querySelector('#sl-transfer-to');
        const amount = root.querySelector('#sl-transfer-amount');
        const recipient = to instanceof HTMLInputElement ? to.value.trim() : '';
        const n = Math.round(Number(amount instanceof HTMLInputElement ? amount.value : 0) || 0);
        const wallet = readWallet();
        if (!recipient || n <= 0) return showToast('Recipient and amount required');
        if (n > wallet.balance) return showToast('Insufficient balance');
        writeWalletBalance(wallet.balance - n, { dir: 'out', amount: n, name: recipient, note: `ATM transfer to ${recipient}` });
        atmState = 'balance'; renderAtm(); showToast('Transfer completed'); return;
    }
    if (action === 'confirm-deposit') {
        const input = ensureOverlayRoot().querySelector('#sl-deposit-amount');
        const n = Math.round(Number(input instanceof HTMLInputElement ? input.value : 0) || 0);
        if (n <= 0) return showToast('Enter a valid amount');
        const wallet = readWallet();
        writeWalletBalance(wallet.balance + n, { dir: 'in', amount: n, name: effectiveAtmBank(), note: 'ATM deposit via Secure Lock' });
        atmState = 'balance'; renderAtm(); showToast('Deposit accepted');
    }
}

function applyGeneratedCardDefaults(defaults) {
    if (!defaults || typeof defaults !== 'object') return;
    const settings = getSettings();
    const generated = settings.generatedCard;
    const custom = settings.card;
    const allowed = ['bankName', 'holder', 'number', 'expiry', 'cvv', 'network'];
    let changed = false;
    for (const key of allowed) {
        if (custom[key]) continue;
        let value = String(defaults[key] ?? '').trim();
        if (!value) continue;
        if (key === 'number') value = sanitizeDigits(value, 19);
        if (key === 'cvv') value = sanitizeDigits(value, 4);
        if (key === 'expiry') value = normalizeExpiry(value);
        if (!value) continue;
        generated[key] = value;
        changed = true;
    }
    if (changed) {
        saveSettings();
        updateCardPreview();
    }
}

function applySyncPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const atm = payload.atm;
    if (!atm || typeof atm !== 'object') return;
    if (atm.cardDefaults) applyGeneratedCardDefaults(atm.cardDefaults);
    if (atm.open === true && getSettings().enabled) {
        openAtm(atm);
    }
}

function extractFrame(text) {
    const src = String(text || '');
    const start = src.indexOf(FRAME_START);
    if (start < 0) return null;
    const bodyStart = start + FRAME_START.length;
    const close = src.indexOf(FRAME_END, bodyStart);
    if (close < 0) return { found: true, start, end: src.length, error: 'unterminated Secure Lock frame' };
    const body = src.slice(bodyStart, close).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
        return { found: true, start, end: close + FRAME_END.length, payload: JSON.parse(body) };
    } catch (error) {
        return { found: true, start, end: close + FRAME_END.length, error: error?.message || 'invalid JSON' };
    }
}

function frameFingerprint(text, frame) {
    const body = String(text || '').slice(frame.start, frame.end);
    let hash = 2166136261;
    for (let i = 0; i < body.length; i++) {
        hash ^= body.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${body.length}:${(hash >>> 0).toString(16)}`;
}

function rememberFrame(fingerprint) {
    const settings = getSettings();
    if (!Array.isArray(settings.processedFrames)) settings.processedFrames = [];
    if (!settings.processedFrames.includes(fingerprint)) settings.processedFrames.push(fingerprint);
    if (settings.processedFrames.length > 60) settings.processedFrames.splice(0, settings.processedFrames.length - 60);
    saveSettings();
}

function processLatestFrame() {
    const c = getContext();
    if (!c || !Array.isArray(c.chat)) return false;
    for (let i = c.chat.length - 1; i >= Math.max(0, c.chat.length - 4); i--) {
        const msg = c.chat[i];
        if (!msg || msg.is_user) continue;
        const text = String(msg.mes || '');
        const frame = extractFrame(text);
        if (!frame?.found) continue;
        const fp = frameFingerprint(text, frame);
        const already = getSettings().processedFrames?.includes(fp);
        const cleaned = `${text.slice(0, frame.start)}${text.slice(frame.end)}`.replace(/\n{3,}/g, '\n\n').trimEnd();
        if (cleaned !== text) {
            msg.mes = cleaned;
            try { c.saveChatDebounced?.(); } catch {}
        }
        maskSyncFramesInDom(document);
        if (!already) {
            rememberFrame(fp);
            if (frame.error) console.warn('[Secure Lock] Ignored invalid sync frame:', frame.error);
            else applySyncPayload(frame.payload);
        }
        return true;
    }
    return false;
}

function removeTextRange(root, start, end) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let pos = 0;
    let node;
    while ((node = walker.nextNode())) {
        const len = node.nodeValue?.length || 0;
        nodes.push({ node, start: pos, end: pos + len });
        pos += len;
    }
    for (const item of nodes) {
        if (item.end <= start || item.start >= end) continue;
        const localStart = Math.max(0, start - item.start);
        const localEnd = Math.min(item.node.nodeValue.length, end - item.start);
        item.node.nodeValue = item.node.nodeValue.slice(0, localStart) + item.node.nodeValue.slice(localEnd);
    }
}

function maskSyncFramesInDom(root = document) {
    const blocks = [];
    if (root instanceof Element && root.matches('.mes_text')) blocks.push(root);
    root.querySelectorAll?.('.mes_text').forEach(el => blocks.push(el));
    for (const el of blocks) {
        for (let guard = 0; guard < 3; guard++) {
            const flat = String(el.textContent || '');
            const start = flat.indexOf(FRAME_START);
            if (start < 0) break;
            const closeAt = flat.indexOf(FRAME_END, start + FRAME_START.length);
            const end = closeAt < 0 ? flat.length : closeAt + FRAME_END.length;
            removeTextRange(el, start, end);
        }
    }
}

function scheduleFrameProcess(delay = 80) {
    clearTimeout(scheduleFrameProcess._timer);
    scheduleFrameProcess._timer = setTimeout(() => {
        maskSyncFramesInDom(document);
        processLatestFrame();
    }, delay);
}

function startFrameWatch(context) {
    if (frameWatchTimer) return;
    const scan = () => {
        maskSyncFramesInDom(document);
        const c = getContext();
        const last = Array.isArray(c?.chat) ? c.chat[c.chat.length - 1] : null;
        if (String(last?.mes || '').includes(FRAME_START)) processLatestFrame();
    };
    frameWatchTimer = setInterval(scan, 900);
    const target = document.getElementById('chat') || document.body;
    if (target && typeof MutationObserver === 'function') {
        frameObserver = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes || []) {
                    if (node.nodeType === Node.ELEMENT_NODE) maskSyncFramesInDom(node);
                }
            }
            scheduleFrameProcess(120);
        });
        frameObserver.observe(target, { childList: true, subtree: true, characterData: true });
    }
    if (context?.eventSource && context?.event_types) {
        const events = context.event_types;
        if (events.GENERATION_ENDED) context.eventSource.on(events.GENERATION_ENDED, () => scheduleFrameProcess(80));
        if (events.MESSAGE_RECEIVED) context.eventSource.on(events.MESSAGE_RECEIVED, () => scheduleFrameProcess(120));
        if (events.CHARACTER_MESSAGE_RENDERED) context.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, () => scheduleFrameProcess(120));
        if (events.CHAT_CHANGED) context.eventSource.on(events.CHAT_CHANGED, () => {
            closeAtm();
            scheduleFrameProcess(120);
            updateIntegrationStatus();
        });
    }
}

function cardPromptState() {
    const settings = getSettings();
    const c = settings.card || {};
    const blank = key => !String(c[key] || '').trim();
    const locked = {};
    for (const key of ['bankName', 'holder', 'number', 'expiry', 'cvv', 'network']) {
        if (!blank(key)) locked[key] = String(c[key]);
    }
    return {
        locked,
        missing: ['bankName', 'holder', 'number', 'expiry', 'cvv', 'network'].filter(blank),
    };
}

function walletPromptState() {
    const wallet = readWallet();
    return {
        source: wallet.source,
        currency: wallet.currency,
        balance: Math.round(wallet.balance),
        account: wallet.account || '',
    };
}

globalThis.secureLockGenInterceptor = function (chat, contextSize, abort, type) {
    try {
        const settings = getSettings();
        if (!settings.enabled || !Array.isArray(chat)) return;
        const generationType = String(type || 'normal').toLowerCase();
        if (['quiet', 'impersonate', 'continue'].some(x => generationType.includes(x))) return;
        const cardState = cardPromptState();
        const walletState = walletPromptState();
        const instruction = [
            '[Secure Lock v1 contextual ATM detector. This is part of the SAME normal SillyTavern response. Never make or imply a second model call.]',
            'After the normal roleplay prose, append exactly one plain data frame (not HTML, not a div, not a comment, not a code fence):',
            `${FRAME_START}{"v":1,"atm":{"open":false}}${FRAME_END}`,
            'The extension consumes and removes this frame from chat. Never mention it in prose.',
            'ATM trigger rule is strict: atm.open=true ONLY when the current scene contains immediate intent to OPERATE an ATM/cash machine now — e.g. inserting/reaching for a bank card to start, explicitly deciding to use it, beginning a withdrawal/deposit/transfer/balance check, or an NPC actively starts using the ATM.',
            'ATM trigger rule negatives: merely seeing, standing near, walking toward, walking past, entering the bank/lobby, talking about an ATM, or being close to it without beginning/intending an ATM operation MUST keep atm.open=false.',
            'When atm.open=true include contextual fields whenever inferable: bankName, branch, terminalId, location, currency, reason. Bank/terminal identity may change naturally with the roleplay location.',
            `Pocket Phone financial state is canonical when connected: ${JSON.stringify(walletState)}. Do not invent a different balance or currency when this source is Pocket Phone.`,
            cardState.missing.length
                ? `User card fields missing and eligible for contextual AI defaults: ${cardState.missing.join(', ')}. When atm.open=true, include atm.cardDefaults containing plausible values for ONLY these missing fields. Keep generated values consistent with the setting/world; card number digits only, expiry MM/YY, cvv 3-4 digits.`
                : 'All user card fields are customized; do not output cardDefaults that replace them.',
            Object.keys(cardState.locked).length ? `User-locked card fields that MUST NOT be changed: ${JSON.stringify(cardState.locked)}.` : null,
            'If Pocket Phone also requests its own data frame, output both frames after the prose. Do not merge the two protocols.',
        ].filter(Boolean).join('\n');
        chat.push({ is_user: false, is_system: true, name: 'SecureLockSyncV1', mes: instruction });
    } catch (error) {
        console.warn('[Secure Lock] Generation interceptor failed safely.', error);
    }
};

async function initialize() {
    const context = getContext();
    if (!context) {
        console.warn('[Secure Lock] SillyTavern context is unavailable; initialization skipped safely.');
        return;
    }
    getSettings(context);
    ensureOverlayRoot();
    startFrameWatch(context);

    if (!(await buildSettingsDrawer(context))) {
        const observer = new MutationObserver(async () => {
            if (await buildSettingsDrawer(context)) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.setTimeout(() => observer.disconnect(), 15000);
    }

    clearInterval(settingsStatusTimer);
    settingsStatusTimer = setInterval(updateIntegrationStatus, 2500);
    console.info(`[Secure Lock] v${VERSION} loaded — ATM + card + Pocket Phone bridge ready.`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
