/* Secure Lock v0.2.4 reliability entrypoint.
 *
 * Fixes three iOS/mobile issues observed in 0.2.3:
 * 1) Safari could make the reverse side of the bank card disappear after flip.
 * 2) The ATM could still be rasterized/blurred while centered with CSS transforms.
 * 3) Opening the card from SillyTavern's Wand/Extensions menu left that menu open.
 *
 * The older 0.2.3 controller is retained for card data, wallet sync and contextual
 * ATM behavior. This layer owns the presentation-critical pieces only.
 */

(async () => {
    'use strict';

    const VERSION = '0.2.4';
    const ROOT_ID = 'secure-lock-overlay-root';
    const SETTINGS_ROOT_ID = 'secure-lock-settings-root';
    const WAND_BUTTON_ID = 'secure-lock-wand-card';

    let atmDrag = { x: 0, y: 0 };
    let activeAtmDrag = null;
    let atmWasVisible = false;
    let rootObserver = null;
    let layoutFrame = 0;

    function extensionBaseUrl() {
        const script = Array.from(document.scripts).find(el => /secure-lock-extension\/bootstrap-v024\.js(?:\?|$)/.test(el.src));
        if (script?.src) return new URL('.', script.src);
        return new URL('/scripts/extensions/third-party/secure-lock-extension/', location.origin);
    }

    function root() {
        return document.getElementById(ROOT_ID);
    }

    function atmWindow() {
        return root()?.querySelector('#sl-atm-window') ?? null;
    }

    function atmVisible(win = atmWindow()) {
        if (!(win instanceof HTMLElement) || win.hidden) return false;
        const style = getComputedStyle(win);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function setImportant(el, property, value) {
        if (!(el instanceof HTMLElement)) return;
        el.style.setProperty(property, value, 'important');
    }

    function placeAtm({ reset = false } = {}) {
        const host = root();
        const win = atmWindow();
        if (!(host instanceof HTMLElement) || !(win instanceof HTMLElement) || !atmVisible(win)) return;

        if (reset) atmDrag = { x: 0, y: 0 };

        const hostWidth = Math.max(1, host.clientWidth);
        const hostHeight = Math.max(1, host.clientHeight);
        const winWidth = Math.max(1, win.offsetWidth);
        const winHeight = Math.max(1, win.offsetHeight);
        const margin = 8;

        const maxX = Math.max(0, (hostWidth - winWidth) / 2 - margin);
        const maxY = Math.max(0, (hostHeight - winHeight) / 2 - margin);
        atmDrag.x = Math.max(-maxX, Math.min(maxX, atmDrag.x));
        atmDrag.y = Math.max(-maxY, Math.min(maxY, atmDrag.y));

        // Use integer, direct pixel coordinates instead of translate(-50%, -50%).
        // This avoids Safari compositing the whole ATM into a softly scaled layer.
        const left = Math.round((hostWidth - winWidth) / 2 + atmDrag.x);
        const top = Math.round((hostHeight - winHeight) / 2 + atmDrag.y);

        setImportant(win, 'left', `${left}px`);
        setImportant(win, 'top', `${top}px`);
        setImportant(win, 'right', 'auto');
        setImportant(win, 'bottom', 'auto');
        setImportant(win, 'transform', 'none');
        setImportant(win, '-webkit-transform', 'none');
        setImportant(win, 'filter', 'none');
        setImportant(win, '-webkit-filter', 'none');
        win.dataset.secureLockDirectPosition = VERSION;
    }

    function scheduleAtmLayout(options = {}) {
        cancelAnimationFrame(layoutFrame);
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0;
            placeAtm(options);
        });
    }

    function syncAtmVisibility() {
        const win = atmWindow();
        const visible = atmVisible(win);
        if (visible && !atmWasVisible) {
            atmDrag = { x: 0, y: 0 };
            scheduleAtmLayout({ reset: true });
        } else if (visible) {
            scheduleAtmLayout();
        }
        atmWasVisible = visible;
    }

    function bindRootObserver() {
        const host = root();
        if (!(host instanceof HTMLElement)) return false;
        if (rootObserver?.__secureLockRoot === host) return true;

        rootObserver?.disconnect();
        rootObserver = new MutationObserver(() => syncAtmVisibility());
        rootObserver.__secureLockRoot = host;
        rootObserver.observe(host, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['hidden'],
        });
        syncAtmVisibility();
        return true;
    }

    function installAtmDirectPositioning() {
        document.addEventListener('pointerdown', event => {
            const target = event.target instanceof Element ? event.target : null;
            const handle = target?.closest(`#${ROOT_ID} #sl-atm-dragbar`);
            if (!(handle instanceof HTMLElement)) return;
            if (target?.closest('button')) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;

            const win = atmWindow();
            if (!(win instanceof HTMLElement) || !atmVisible(win)) return;

            activeAtmDrag = {
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startX: atmDrag.x,
                startY: atmDrag.y,
                handle,
            };
            try { handle.setPointerCapture(event.pointerId); } catch {}
        }, true);

        document.addEventListener('pointermove', event => {
            if (!activeAtmDrag || activeAtmDrag.pointerId !== event.pointerId) return;
            event.preventDefault();
            atmDrag.x = activeAtmDrag.startX + event.clientX - activeAtmDrag.startClientX;
            atmDrag.y = activeAtmDrag.startY + event.clientY - activeAtmDrag.startClientY;
            placeAtm();
        }, { capture: true, passive: false });

        const finish = event => {
            if (!activeAtmDrag || activeAtmDrag.pointerId !== event.pointerId) return;
            try { activeAtmDrag.handle.releasePointerCapture(event.pointerId); } catch {}
            activeAtmDrag = null;
        };
        document.addEventListener('pointerup', finish, true);
        document.addEventListener('pointercancel', finish, true);

        document.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;

            if (target.closest('#secure-lock-test-atm') || target.closest(`#${ROOT_ID} #sl-atm-center`)) {
                atmDrag = { x: 0, y: 0 };
                scheduleAtmLayout({ reset: true });
            }
        }, true);

        window.addEventListener('resize', () => scheduleAtmLayout(), { passive: true });
        window.addEventListener('orientationchange', () => scheduleAtmLayout(), { passive: true });
        window.visualViewport?.addEventListener('resize', () => scheduleAtmLayout(), { passive: true });
        window.visualViewport?.addEventListener('scroll', () => scheduleAtmLayout(), { passive: true });

        const pageObserver = new MutationObserver(() => {
            if (bindRootObserver()) syncAtmVisibility();
        });
        pageObserver.observe(document.documentElement, { childList: true, subtree: true });
        bindRootObserver();
    }

    function menuIsVisible(menu) {
        if (!(menu instanceof HTMLElement)) return false;
        const style = getComputedStyle(menu);
        return style.display !== 'none' && style.visibility !== 'hidden' && menu.getClientRects().length > 0;
    }

    function closeWandMenu() {
        const menu = document.getElementById('extensionsMenu');
        if (!(menu instanceof HTMLElement) || !menuIsVisible(menu)) return;

        const toggle = document.getElementById('extensionsMenuButton');
        if (toggle instanceof HTMLElement) {
            try { toggle.click(); } catch {}
        }

        // Fallback for custom/mobile SillyTavern skins where the toggle does not
        // synchronously hide the menu. Do not use !important so the next normal
        // Wand button press can reopen it without fighting our inline style.
        requestAnimationFrame(() => {
            if (menuIsVisible(menu)) {
                menu.style.display = 'none';
                menu.setAttribute('aria-hidden', 'true');
            }
        });
    }

    function installWandAutoClose() {
        document.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest(`#${WAND_BUTTON_ID}`)) return;
            closeWandMenu();
        }, true);
    }

    function patchVisibleVersion() {
        const settingsRoot = document.getElementById(SETTINGS_ROOT_ID);
        if (settingsRoot) {
            const desired = `ATM & card foundation v${VERSION}`;
            settingsRoot.querySelectorAll('.secure-lock-settings__meta').forEach(el => {
                if (/ATM\s*&\s*card foundation v/i.test(el.textContent || '') && el.textContent !== desired) {
                    el.textContent = desired;
                }
            });
            settingsRoot.dataset.secureLockVersion = VERSION;
        }

        const current = globalThis.SecureLockUI;
        if (current && current.version !== VERSION) {
            try { globalThis.SecureLockUI = Object.freeze({ ...current, version: VERSION }); } catch {}
        }
    }

    async function load023() {
        try {
            const url = new URL('bootstrap-v023.js', extensionBaseUrl());
            url.searchParams.set('slv', VERSION);
            await import(url.href);
        } catch (error) {
            console.error('[Secure Lock] v0.2.4 could not load the 0.2.3 interaction controller.', error);
        }
    }

    // Register our capture listeners before the older controller so the Wand
    // menu closes immediately and our drag state is ready before ATM handlers.
    installWandAutoClose();
    installAtmDirectPositioning();

    await load023();
    patchVisibleVersion();
    bindRootObserver();
    syncAtmVisibility();

    console.info('[Secure Lock] v0.2.4 flip/ATM clarity/Wand dismissal fixes loaded.');
})();
