/* Secure Lock v0.2.1 reliability bootstrap.
 * Loads the v0.2.0 feature engine with a cache-busting token, then owns the two
 * Extensions-tab preview buttons through a capture-phase delegate. This avoids
 * stale DOM/listener state after SillyTavern third-party extension updates,
 * especially on iOS/WebKit, while leaving contextual AI frame handling in the
 * established engine.
 */

(() => {
    'use strict';

    const VERSION = '0.2.1';
    const MODULE_NAME = 'secure_lock';
    const ROOT_ID = 'secure-lock-overlay-root';
    const CARD_THEMES = new Set(['obsidian', 'sapphire', 'emerald', 'crimson', 'pearl']);

    let coreImportPromise = null;
    let manualAtm = {
        state: 'insert',
        pin: '',
        context: null,
    };

    function ctx() {
        try { return globalThis.SillyTavern?.getContext?.() ?? null; }
        catch { return null; }
    }

    function settings() {
        const c = ctx();
        if (!c?.extensionSettings) return null;
        if (!c.extensionSettings[MODULE_NAME] || typeof c.extensionSettings[MODULE_NAME] !== 'object') {
            c.extensionSettings[MODULE_NAME] = {};
        }
        const s = c.extensionSettings[MODULE_NAME];
        if (typeof s.enabled !== 'boolean') s.enabled = true;
        if (!s.card || typeof s.card !== 'object') s.card = {};
        if (!s.generatedCard || typeof s.generatedCard !== 'object') s.generatedCard = {};
        if (!s.localWallet || typeof s.localWallet !== 'object') s.localWallet = { balance: 50000, currency: '$', account: '', history: [] };
        if (!Array.isArray(s.localWallet.history)) s.localWallet.history = [];
        if (!s.atmPin) s.atmPin = '2580';
        return s;
    }

    function save() {
        try { ctx()?.saveSettingsDebounced?.(); } catch {}
    }

    function digits(value, max = 19) {
        return String(value ?? '').replace(/\D/g, '').slice(0, max);
    }

    function normalizeExpiry(value) {
        const raw = String(value ?? '').replace(/[^0-9/]/g, '').slice(0, 5);
        if (/^\d{4}$/.test(raw)) return `${raw.slice(0, 2)}/${raw.slice(2)}`;
        return raw;
    }

    function userName() {
        const c = ctx();
        return String(c?.name1 || c?.user_name || c?.powerUserSettings?.persona_name || 'CARD HOLDER').trim() || 'CARD HOLDER';
    }

    function fallbackCardNumber() {
        const c = ctx();
        const seed = `${c?.chatId ?? ''}:${c?.characterId ?? ''}:${userName()}`;
        let hash = 2166136261;
        for (let i = 0; i < seed.length; i++) {
            hash ^= seed.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        let out = '5412';
        let x = hash >>> 0;
        for (let i = 0; i < 12; i++) {
            x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
            out += String(x % 10);
        }
        return out;
    }

    function cardData() {
        const s = settings() || {};
        const custom = s.card || {};
        const generated = s.generatedCard || {};
        const year = String((new Date().getFullYear() + 4) % 100).padStart(2, '0');
        const theme = CARD_THEMES.has(custom.theme) ? custom.theme : 'obsidian';
        return {
            bankName: String(custom.bankName || generated.bankName || 'Northstar Bank'),
            holder: String(custom.holder || generated.holder || userName()).toUpperCase(),
            number: digits(custom.number || generated.number || fallbackCardNumber(), 19),
            expiry: normalizeExpiry(custom.expiry || generated.expiry || `12/${year}`),
            cvv: digits(custom.cvv || generated.cvv || '258', 4),
            network: String(custom.network || generated.network || 'SECURE').toUpperCase(),
            theme,
        };
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;' }[ch]));
    }

    function formatCardNumber(value) {
        return digits(value, 19).replace(/(.{4})/g, '$1 ').trim();
    }

    function cardMarkup(card, back = false) {
        if (back) {
            return `
                <div class="sl-card-back-top"><span>${escapeHtml(card.bankName)}</span><span>${escapeHtml(card.network)}</span></div>
                <div class="sl-card-stripe"></div>
                <div class="sl-signature-row"><div class="sl-signature">AUTHORIZED SIGNATURE</div><div class="sl-cvv"><small>CVV</small><b>${escapeHtml(card.cvv)}</b></div></div>
                <div class="sl-card-back-copy">Use of this card is subject to the account agreement. If found, return to the issuing bank.</div>
                <div class="sl-card-back-footer"><span>${escapeHtml(card.bankName)}</span><span>SECURE • CONTACTLESS</span></div>`;
        }
        return `
            <div class="sl-card-top"><div class="sl-card-bank">${escapeHtml(card.bankName)}</div><div class="sl-contactless">)))</div></div>
            <div class="sl-gold-chip" aria-label="Gold chip"><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <div class="sl-card-number">${escapeHtml(formatCardNumber(card.number))}</div>
            <div class="sl-card-bottom">
                <div><small>CARD HOLDER</small><b>${escapeHtml(card.holder)}</b></div>
                <div><small>VALID THRU</small><b>${escapeHtml(card.expiry)}</b></div>
                <div class="sl-network">${escapeHtml(card.network)}</div>
            </div>`;
    }

    function extensionBaseUrl() {
        const script = Array.from(document.scripts).find(el => /secure-lock-extension\/bootstrap\.js(?:\?|$)/.test(el.src));
        if (script?.src) return new URL('.', script.src);
        return new URL('/scripts/extensions/third-party/secure-lock-extension/', location.origin);
    }

    async function loadCore() {
        if (coreImportPromise) return coreImportPromise;
        coreImportPromise = (async () => {
            try {
                const url = new URL('index.js', extensionBaseUrl());
                url.searchParams.set('slv', VERSION);
                await import(url.href);
            } catch (error) {
                console.error('[Secure Lock] v0.2.1 could not import the core engine.', error);
            }
        })();
        return coreImportPromise;
    }

    function forceOverlayLayer(root) {
        if (!(root instanceof HTMLElement)) return;
        root.style.setProperty('display', 'block', 'important');
        root.style.setProperty('visibility', 'visible', 'important');
        root.style.setProperty('opacity', '1', 'important');
        root.style.setProperty('position', 'fixed', 'important');
        root.style.setProperty('inset', '0', 'important');
        root.style.setProperty('z-index', '2147483000', 'important');
    }

    function showElement(el) {
        if (!(el instanceof HTMLElement)) return;
        el.hidden = false;
        el.removeAttribute('hidden');
        el.style.removeProperty('display');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('opacity', '1', 'important');
    }

    function hideElement(el) {
        if (!(el instanceof HTMLElement)) return;
        el.hidden = true;
        el.setAttribute('hidden', '');
    }

    async function waitForOverlayRoot(timeout = 2500) {
        await loadCore();
        const existing = document.getElementById(ROOT_ID);
        if (existing) return existing;
        const start = performance.now();
        while (performance.now() - start < timeout) {
            await new Promise(resolve => setTimeout(resolve, 40));
            const root = document.getElementById(ROOT_ID);
            if (root) return root;
        }
        return null;
    }

    function toast(message) {
        const root = document.getElementById(ROOT_ID);
        const el = root?.querySelector('#sl-toast');
        if (!(el instanceof HTMLElement)) return;
        el.textContent = String(message || '');
        el.classList.add('is-visible');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => el.classList.remove('is-visible'), 1800);
    }

    function renderCard(root) {
        const card = cardData();
        const bankCard = root.querySelector('#sl-bank-card');
        const front = root.querySelector('#sl-card-front');
        const back = root.querySelector('#sl-card-back');
        if (bankCard instanceof HTMLElement) bankCard.dataset.theme = card.theme;
        if (front instanceof HTMLElement) front.innerHTML = cardMarkup(card, false);
        if (back instanceof HTMLElement) back.innerHTML = cardMarkup(card, true);
    }

    async function openCard() {
        const root = await waitForOverlayRoot();
        if (!root) {
            console.error('[Secure Lock] Overlay root was not created; card preview cannot open.');
            return;
        }
        forceOverlayLayer(root);
        renderCard(root);
        root.querySelector('#sl-bank-card')?.classList.remove('is-flipped');
        hideElement(root.querySelector('#sl-atm-backdrop'));
        hideElement(root.querySelector('#sl-atm-window'));
        showElement(root.querySelector('#sl-card-backdrop'));
        showElement(root.querySelector('#sl-card-modal'));
    }

    function currentCharacterId() {
        const c = ctx();
        try {
            if (c?.characterId != null && Array.isArray(c.characters)) {
                const ch = c.characters[c.characterId];
                if (ch) return ch.avatar || ch.name || String(c.characterId);
            }
        } catch {}
        return 'global';
    }

    function currentChatId() {
        const c = ctx();
        try {
            if (c?.chatId != null) return String(c.chatId);
            const id = c?.getCurrentChatId?.();
            if (id != null) return String(id);
        } catch {}
        return '';
    }

    function pocketPhoneConfig() {
        const c = ctx();
        return c?.extensionSettings?.['pocket-phone'] || null;
    }

    function pocketRoute(cfg, create = false) {
        if (!cfg?.walletPerChat) return null;
        if (!cfg.walletRoutes || typeof cfg.walletRoutes !== 'object') {
            if (!create) return null;
            cfg.walletRoutes = {};
        }
        const key = currentChatId() ? `${currentCharacterId()}::${currentChatId()}` : currentCharacterId();
        if (!cfg.walletRoutes[key] && create) {
            cfg.walletRoutes[key] = { balance: Math.round(Number(cfg.walletBalance) || 0), history: [], botWallets: {} };
        }
        const route = cfg.walletRoutes[key] || null;
        if (route && create && !Array.isArray(route.history)) route.history = [];
        return route;
    }

    function readWallet() {
        const pp = pocketPhoneConfig();
        if (pp && typeof pp === 'object') {
            const route = pocketRoute(pp, false);
            return {
                connected: true,
                source: 'Pocket Phone',
                balance: route ? Number(route.balance) || 0 : Number(pp.walletBalance) || 0,
                currency: String(pp.walletCurrency || '฿'),
                account: String(pp.walletAccount || ''),
                config: pp,
                route,
            };
        }
        const s = settings();
        return {
            connected: false,
            source: 'Secure Lock local fallback',
            balance: Number(s?.localWallet?.balance) || 0,
            currency: String(s?.localWallet?.currency || '$'),
            account: String(s?.localWallet?.account || ''),
            config: null,
            route: null,
        };
    }

    function writeWallet(nextBalance, meta = {}) {
        const wallet = readWallet();
        const next = Math.max(0, Math.round(Number(nextBalance) || 0));
        let history;
        if (wallet.connected) {
            const route = pocketRoute(wallet.config, true);
            if (route) {
                route.balance = next;
                history = route.history;
            } else {
                wallet.config.walletBalance = next;
                if (!Array.isArray(wallet.config.walletHistory)) wallet.config.walletHistory = [];
                history = wallet.config.walletHistory;
            }
        } else {
            const s = settings();
            s.localWallet.balance = next;
            history = s.localWallet.history;
        }
        const amount = Math.max(0, Math.round(Number(meta.amount) || 0));
        if (amount && Array.isArray(history)) {
            history.push({
                id: `sl021_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                dir: meta.dir === 'in' ? 'in' : 'out',
                amount,
                cid: null,
                name: String(meta.name || manualAtm.context?.bankName || 'ATM'),
                note: String(meta.note || 'ATM transaction via Secure Lock'),
                ts: Date.now(),
            });
            if (history.length > 200) history.splice(0, history.length - 200);
        }
        save();
        try {
            globalThis.dispatchEvent(new CustomEvent('pocket-phone:external-wallet-change', {
                detail: { balance: next, currency: wallet.currency, source: wallet.source, ...meta },
            }));
        } catch {}
        return next;
    }

    function money(value, currency) {
        return `${String(currency || '$')}${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
    }

    function setAtmChrome(root) {
        const card = cardData();
        const wallet = readWallet();
        const bank = manualAtm.context?.bankName || card.bankName || 'ATM';
        const title = root.querySelector('#sl-atm-title');
        const subtitle = root.querySelector('#sl-atm-subtitle');
        const bankEl = root.querySelector('#sl-atm-bank');
        const terminal = root.querySelector('#sl-atm-terminal');
        const mini = root.querySelector('#sl-mini-card');
        if (title) title.textContent = bank;
        if (bankEl) bankEl.textContent = bank;
        if (subtitle) subtitle.textContent = manualAtm.context?.location || 'Secure Lock test terminal';
        if (terminal) terminal.textContent = manualAtm.context?.terminalId || 'SL-DEMO-01';
        if (mini instanceof HTMLElement) {
            mini.dataset.theme = card.theme;
            mini.classList.toggle('is-inserted', manualAtm.state !== 'insert');
        }
        const pinpad = root.querySelector('#sl-pinpad');
        if (pinpad instanceof HTMLElement) {
            pinpad.innerHTML = `${[1,2,3,4,5,6,7,8,9].map(n => `<button class="sl-key" data-sl021-pin="${n}">${n}</button>`).join('')}<button class="sl-key sl-key-cancel" data-sl021-atm-action="cancel">C</button><button class="sl-key" data-sl021-pin="0">0</button><button class="sl-key sl-key-enter" data-sl021-atm-action="enter">✓</button>`;
        }
        return { card, wallet, bank };
    }

    function renderManualAtm(root) {
        const screen = root.querySelector('#sl-atm-screen');
        if (!(screen instanceof HTMLElement)) return;
        const { card, wallet, bank } = setAtmChrome(root);
        const currency = wallet.currency;

        if (manualAtm.state === 'insert') {
            screen.innerHTML = `<div class="sl-atm-status"><strong>Insert your card</strong><span>${escapeHtml(bank)} is ready for a transaction.</span></div><div class="sl-atm-card-preview" aria-label="${escapeHtml(card.bankName)} card"><div class="sl-bank-card sl-atm-card-display" data-theme="${escapeHtml(card.theme)}"><div class="sl-card-face sl-card-front">${cardMarkup(card, false)}</div></div></div><button class="sl-button sl-button-primary sl-full" data-sl021-atm-action="insert">Insert card</button>`;
            return;
        }
        if (manualAtm.state === 'pin') {
            screen.innerHTML = `<div class="sl-atm-status"><strong>Enter PIN</strong><span>Use the keypad.</span></div><div class="sl-pin-dots">${[0,1,2,3].map(i => `<i class="${i < manualAtm.pin.length ? 'on' : ''}"></i>`).join('')}</div><div class="sl-mobile-pinpad">${[1,2,3,4,5,6,7,8,9,0].map(n => `<button class="sl-key" data-sl021-pin="${n}">${n}</button>`).join('')}<button class="sl-key sl-key-enter" data-sl021-atm-action="enter">✓</button></div><button class="sl-button sl-full" data-sl021-atm-action="delete-pin">Delete digit</button>`;
            return;
        }
        if (manualAtm.state === 'menu') {
            screen.innerHTML = `<div class="sl-atm-status"><span>Available balance</span><div class="sl-balance">${escapeHtml(money(wallet.balance, currency))}</div><small>${wallet.connected ? 'Synced with Pocket Phone' : 'Secure Lock local fallback'}</small></div><div class="sl-atm-menu"><button class="sl-atm-tile" data-sl021-atm-action="withdraw"><b>Withdraw</b><span>Take out cash</span></button><button class="sl-atm-tile" data-sl021-atm-action="transfer"><b>Transfer</b><span>Send funds</span></button><button class="sl-atm-tile" data-sl021-atm-action="balance"><b>Balance</b><span>Account details</span></button><button class="sl-atm-tile" data-sl021-atm-action="deposit"><b>Deposit</b><span>Add cash</span></button></div><button class="sl-button sl-button-danger sl-full" data-sl021-atm-action="eject">Eject card</button>`;
            return;
        }
        if (manualAtm.state === 'balance') {
            const account = wallet.account || `•••• ${card.number.slice(-4)}`;
            screen.innerHTML = `<div class="sl-atm-status"><strong>Account overview</strong><div class="sl-balance">${escapeHtml(money(wallet.balance, currency))}</div><span>${escapeHtml(account)}</span></div><button class="sl-button sl-button-primary sl-full" data-sl021-atm-action="menu">Back to menu</button>`;
            return;
        }
        if (manualAtm.state === 'withdraw') {
            screen.innerHTML = `<div class="sl-atm-status"><strong>Withdraw cash</strong><span>Choose an amount</span></div><div class="sl-amount-grid">${[20,50,100,200].map(n => `<button class="sl-button" data-sl021-withdraw="${n}">${escapeHtml(money(n, currency))}</button>`).join('')}</div><input id="sl021-custom-withdraw" class="sl-field" inputmode="decimal" placeholder="Custom amount"><div class="sl-row"><button class="sl-button" data-sl021-atm-action="menu">Back</button><button class="sl-button sl-button-primary" data-sl021-atm-action="custom-withdraw">Withdraw</button></div>`;
            return;
        }
        if (manualAtm.state === 'transfer') {
            screen.innerHTML = `<div class="sl-atm-status"><strong>Transfer funds</strong><span>Uses the connected Pocket Phone wallet when available.</span></div><input id="sl021-transfer-to" class="sl-field" placeholder="Recipient / account"><input id="sl021-transfer-amount" class="sl-field" inputmode="decimal" placeholder="Amount"><div class="sl-row"><button class="sl-button" data-sl021-atm-action="menu">Back</button><button class="sl-button sl-button-primary" data-sl021-atm-action="confirm-transfer">Confirm</button></div>`;
            return;
        }
        if (manualAtm.state === 'deposit') {
            screen.innerHTML = `<div class="sl-atm-status"><strong>Deposit cash</strong><span>Add an amount to the synced wallet.</span></div><input id="sl021-deposit-amount" class="sl-field" inputmode="decimal" placeholder="Amount"><div class="sl-row"><button class="sl-button" data-sl021-atm-action="menu">Back</button><button class="sl-button sl-button-primary" data-sl021-atm-action="confirm-deposit">Deposit</button></div>`;
            return;
        }
        if (manualAtm.state === 'cash') {
            screen.innerHTML = `<div class="sl-atm-status"><strong>Take your cash</strong><span>Transaction completed.</span></div><button class="sl-button sl-button-primary sl-full" data-sl021-atm-action="menu">Continue</button>`;
        }
    }

    async function openAtmPreview() {
        const s = settings();
        if (s && s.enabled === false) {
            toast('Enable Secure Lock first');
            return;
        }
        const root = await waitForOverlayRoot();
        if (!root) {
            console.error('[Secure Lock] Overlay root was not created; ATM preview cannot open.');
            return;
        }
        forceOverlayLayer(root);
        const card = cardData();
        const wallet = readWallet();
        manualAtm = {
            state: 'insert',
            pin: '',
            context: {
                bankName: card.bankName || 'Northstar Bank',
                branch: 'Preview Terminal',
                terminalId: 'SL-DEMO-01',
                location: 'Secure Lock test',
                currency: wallet.currency,
            },
        };
        hideElement(root.querySelector('#sl-card-backdrop'));
        hideElement(root.querySelector('#sl-card-modal'));
        const win = root.querySelector('#sl-atm-window');
        if (win instanceof HTMLElement) {
            win.style.setProperty('--sl-drag-x', '0px');
            win.style.setProperty('--sl-drag-y', '0px');
        }
        renderManualAtm(root);
        showElement(root.querySelector('#sl-atm-backdrop'));
        showElement(win);
    }

    function closeCard() {
        const root = document.getElementById(ROOT_ID);
        hideElement(root?.querySelector('#sl-card-backdrop'));
        hideElement(root?.querySelector('#sl-card-modal'));
    }

    function closeAtm() {
        const root = document.getElementById(ROOT_ID);
        hideElement(root?.querySelector('#sl-atm-backdrop'));
        hideElement(root?.querySelector('#sl-atm-window'));
        manualAtm.pin = '';
    }

    function withdraw(root, amount) {
        const wallet = readWallet();
        const n = Math.round(Number(amount) || 0);
        if (n <= 0) return toast('Enter a valid amount');
        if (n > wallet.balance) return toast('Insufficient balance');
        writeWallet(wallet.balance - n, { dir: 'out', amount: n, name: manualAtm.context?.bankName || 'ATM', note: 'ATM withdrawal via Secure Lock' });
        manualAtm.state = 'cash';
        renderManualAtm(root);
        toast('Cash dispensed');
    }

    function handleManualAtmAction(root, action) {
        if (action === 'insert') {
            manualAtm.state = 'pin'; manualAtm.pin = ''; renderManualAtm(root); return;
        }
        if (action === 'delete-pin') {
            manualAtm.pin = manualAtm.pin.slice(0, -1); renderManualAtm(root); return;
        }
        if (action === 'cancel') {
            manualAtm.pin = ''; manualAtm.state = 'insert'; renderManualAtm(root); return;
        }
        if (action === 'enter') {
            if (manualAtm.state !== 'pin') return;
            const expected = digits(settings()?.atmPin || '2580', 8) || '2580';
            if (manualAtm.pin === expected) {
                manualAtm.pin = ''; manualAtm.state = 'menu'; renderManualAtm(root); toast('Card authenticated');
            } else {
                manualAtm.pin = ''; renderManualAtm(root); toast('Incorrect PIN');
            }
            return;
        }
        if (['menu', 'withdraw', 'transfer', 'balance', 'deposit'].includes(action)) {
            manualAtm.state = action; renderManualAtm(root); return;
        }
        if (action === 'eject') { closeAtm(); toast('Card returned'); return; }
        if (action === 'custom-withdraw') {
            const input = root.querySelector('#sl021-custom-withdraw');
            withdraw(root, input instanceof HTMLInputElement ? input.value : 0); return;
        }
        if (action === 'confirm-transfer') {
            const who = root.querySelector('#sl021-transfer-to');
            const amount = root.querySelector('#sl021-transfer-amount');
            const recipient = who instanceof HTMLInputElement ? who.value.trim() : '';
            const n = Math.round(Number(amount instanceof HTMLInputElement ? amount.value : 0) || 0);
            const wallet = readWallet();
            if (!recipient || n <= 0) return toast('Recipient and amount required');
            if (n > wallet.balance) return toast('Insufficient balance');
            writeWallet(wallet.balance - n, { dir: 'out', amount: n, name: recipient, note: `ATM transfer to ${recipient}` });
            manualAtm.state = 'balance'; renderManualAtm(root); toast('Transfer completed'); return;
        }
        if (action === 'confirm-deposit') {
            const input = root.querySelector('#sl021-deposit-amount');
            const n = Math.round(Number(input instanceof HTMLInputElement ? input.value : 0) || 0);
            if (n <= 0) return toast('Enter a valid amount');
            const wallet = readWallet();
            writeWallet(wallet.balance + n, { dir: 'in', amount: n, name: manualAtm.context?.bankName || 'ATM', note: 'ATM deposit via Secure Lock' });
            manualAtm.state = 'balance'; renderManualAtm(root); toast('Deposit accepted');
        }
    }

    function installReliabilityDelegate() {
        if (document.documentElement.dataset.secureLock021Delegate === '1') return;
        document.documentElement.dataset.secureLock021Delegate = '1';

        document.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;

            const openCardButton = target.closest('#secure-lock-open-card');
            if (openCardButton) {
                event.preventDefault();
                event.stopImmediatePropagation();
                void openCard();
                return;
            }

            const testAtmButton = target.closest('#secure-lock-test-atm');
            if (testAtmButton) {
                event.preventDefault();
                event.stopImmediatePropagation();
                void openAtmPreview();
                return;
            }

            const root = target.closest(`#${ROOT_ID}`);
            if (!(root instanceof HTMLElement)) return;

            if (target.closest('#sl-card-close') || target.closest('#sl-card-backdrop')) {
                event.preventDefault();
                event.stopImmediatePropagation();
                closeCard();
                return;
            }
            if (target.closest('#sl-card-flip') || target.closest('#sl-card-flip-btn')) {
                event.preventDefault();
                event.stopImmediatePropagation();
                root.querySelector('#sl-bank-card')?.classList.toggle('is-flipped');
                return;
            }
            if (target.closest('#sl-atm-close')) {
                event.preventDefault();
                event.stopImmediatePropagation();
                closeAtm();
                return;
            }
            if (target.closest('#sl-atm-center')) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const win = root.querySelector('#sl-atm-window');
                if (win instanceof HTMLElement) {
                    win.style.setProperty('--sl-drag-x', '0px');
                    win.style.setProperty('--sl-drag-y', '0px');
                }
                toast('ATM centered');
                return;
            }

            const pin = target.closest('[data-sl021-pin]');
            if (pin) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (manualAtm.state === 'pin' && manualAtm.pin.length < 8) {
                    manualAtm.pin += digits(pin.getAttribute('data-sl021-pin'), 1);
                    renderManualAtm(root);
                }
                return;
            }
            const preset = target.closest('[data-sl021-withdraw]');
            if (preset) {
                event.preventDefault();
                event.stopImmediatePropagation();
                withdraw(root, preset.getAttribute('data-sl021-withdraw'));
                return;
            }
            const action = target.closest('[data-sl021-atm-action]');
            if (action) {
                event.preventDefault();
                event.stopImmediatePropagation();
                handleManualAtmAction(root, action.getAttribute('data-sl021-atm-action'));
            }
        }, true);

        document.addEventListener('input', event => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
            const key = target.dataset.cardKey;
            if (!key) return;
            const s = settings();
            if (!s) return;
            let value = target.value;
            if (key === 'number') value = digits(value, 19);
            if (key === 'cvv') value = digits(value, 4);
            if (key === 'expiry') value = normalizeExpiry(value);
            if (key === 'theme' && !CARD_THEMES.has(value)) value = 'obsidian';
            s.card[key] = value;
            save();
            const root = document.getElementById(ROOT_ID);
            const modal = root?.querySelector('#sl-card-modal');
            if (root && modal instanceof HTMLElement && !modal.hidden) renderCard(root);
        }, true);
    }

    function patchVisibleVersion() {
        const patch = () => {
            const root = document.getElementById('secure-lock-settings-root');
            if (!root) return false;
            root.querySelectorAll('.secure-lock-settings__meta').forEach(el => {
                if (/ATM\s*&\s*card foundation v/i.test(el.textContent || '')) {
                    el.textContent = `ATM & card foundation v${VERSION}`;
                }
            });
            root.dataset.secureLockVersion = VERSION;
            return true;
        };
        if (patch()) return;
        const observer = new MutationObserver(() => {
            if (patch()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 15000);
    }

    globalThis.SecureLockUI = Object.freeze({
        version: VERSION,
        openCard,
        openAtmPreview,
        closeCard,
        closeAtm,
    });

    installReliabilityDelegate();
    patchVisibleVersion();
    void loadCore().then(() => {
        patchVisibleVersion();
        console.info('[Secure Lock] v0.2.1 reliability bootstrap loaded.');
    });
})();