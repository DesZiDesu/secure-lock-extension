/* Secure Lock v0.2.3 interaction polish entrypoint.
 *
 * Loads the viewport-safe v0.2.2 entrypoint, while registering the v0.2.3
 * gesture guards first so a drag on the ATM card never becomes an accidental
 * flip click. Also adds a native Wand/Extensions Menu shortcut for the card.
 */

(async () => {
    'use strict';

    const VERSION = '0.2.3';
    const ROOT_ID = 'secure-lock-overlay-root';
    const SETTINGS_ROOT_ID = 'secure-lock-settings-root';
    const WAND_BUTTON_ID = 'secure-lock-wand-card';

    let cardDrag = { x: 0, y: 0 };
    let activeCardDrag = null;
    let suppressCardClickUntil = 0;
    let wandObserver = null;
    let repairTimer = 0;

    function extensionBaseUrl() {
        const script = Array.from(document.scripts).find(el => /secure-lock-extension\/bootstrap-v023\.js(?:\?|$)/.test(el.src));
        if (script?.src) return new URL('.', script.src);
        return new URL('/scripts/extensions/third-party/secure-lock-extension/', location.origin);
    }

    function cardModal() {
        return document.querySelector(`#${ROOT_ID} #sl-card-modal`);
    }

    function cardRoot() {
        return document.getElementById(ROOT_ID);
    }

    function applyCardPosition() {
        const modal = cardModal();
        if (!(modal instanceof HTMLElement)) return;
        modal.style.setProperty('--sl-card-drag-x', `${cardDrag.x}px`);
        modal.style.setProperty('--sl-card-drag-y', `${cardDrag.y}px`);
    }

    function clampCardPosition() {
        const root = cardRoot();
        const modal = cardModal();
        if (!(root instanceof HTMLElement) || !(modal instanceof HTMLElement) || modal.hidden) return;

        const margin = 8;
        const maxX = Math.max(0, (root.clientWidth - modal.offsetWidth) / 2 - margin);
        const maxY = Math.max(0, (root.clientHeight - modal.offsetHeight) / 2 - margin);
        cardDrag.x = Math.max(-maxX, Math.min(maxX, cardDrag.x));
        cardDrag.y = Math.max(-maxY, Math.min(maxY, cardDrag.y));
        applyCardPosition();
    }

    function resetCardPosition() {
        cardDrag = { x: 0, y: 0 };
        applyCardPosition();
    }

    function scheduleClamp() {
        cancelAnimationFrame(repairTimer);
        repairTimer = requestAnimationFrame(() => {
            repairTimer = 0;
            clampCardPosition();
        });
    }

    function installCardGestureGuards() {
        // IMPORTANT: this listener is registered before v0.2.2/bootstrap.js.
        // It therefore gets first refusal on the synthetic click Safari emits
        // after a drag and can prevent the older flip handler from running.
        document.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;

            if (target.closest('#secure-lock-open-card')) {
                resetCardPosition();
            }

            if (target.closest('#sl-card-flip') && performance.now() < suppressCardClickUntil) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);

        document.addEventListener('pointerdown', event => {
            const target = event.target instanceof Element ? event.target : null;
            const handle = target?.closest(`#${ROOT_ID} #sl-card-flip`);
            if (!(handle instanceof HTMLElement)) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;

            const modal = cardModal();
            if (!(modal instanceof HTMLElement) || modal.hidden) return;

            activeCardDrag = {
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startX: cardDrag.x,
                startY: cardDrag.y,
                moved: false,
                handle,
            };

            try { handle.setPointerCapture(event.pointerId); } catch {}
        }, true);

        document.addEventListener('pointermove', event => {
            if (!activeCardDrag || activeCardDrag.pointerId !== event.pointerId) return;

            const dx = event.clientX - activeCardDrag.startClientX;
            const dy = event.clientY - activeCardDrag.startClientY;
            if (!activeCardDrag.moved && Math.hypot(dx, dy) >= 5) {
                activeCardDrag.moved = true;
            }
            if (!activeCardDrag.moved) return;

            event.preventDefault();
            cardDrag.x = activeCardDrag.startX + dx;
            cardDrag.y = activeCardDrag.startY + dy;
            clampCardPosition();
        }, { capture: true, passive: false });

        const finishDrag = event => {
            if (!activeCardDrag || activeCardDrag.pointerId !== event.pointerId) return;
            if (activeCardDrag.moved) {
                suppressCardClickUntil = performance.now() + 700;
            }
            try { activeCardDrag.handle.releasePointerCapture(event.pointerId); } catch {}
            activeCardDrag = null;
        };

        document.addEventListener('pointerup', finishDrag, true);
        document.addEventListener('pointercancel', finishDrag, true);

        window.addEventListener('resize', scheduleClamp, { passive: true });
        window.addEventListener('orientationchange', scheduleClamp, { passive: true });
        window.visualViewport?.addEventListener('resize', scheduleClamp, { passive: true });
    }

    function patchVisibleVersion() {
        const settingsRoot = document.getElementById(SETTINGS_ROOT_ID);
        if (settingsRoot) {
            settingsRoot.querySelectorAll('.secure-lock-settings__meta').forEach(el => {
                if (/ATM\s*&\s*card foundation v/i.test(el.textContent || '')) {
                    el.textContent = `ATM & card foundation v${VERSION}`;
                }
            });
            settingsRoot.dataset.secureLockVersion = VERSION;
        }

        const current = globalThis.SecureLockUI;
        if (current && current.version !== VERSION) {
            try {
                globalThis.SecureLockUI = Object.freeze({ ...current, version: VERSION });
            } catch {}
        }
    }

    function openCardFromWand(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        resetCardPosition();
        const ui = globalThis.SecureLockUI;
        if (ui?.openCard) {
            void ui.openCard();
        }
    }

    function ensureWandButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!(menu instanceof HTMLElement)) return false;
        if (document.getElementById(WAND_BUTTON_ID)) return true;

        const button = document.createElement('div');
        button.id = WAND_BUTTON_ID;
        button.className = 'list-group-item flex-container flexGap5 interactable secure-lock-wand-card';
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        button.setAttribute('title', 'View Secure Lock ATM card');
        button.setAttribute('aria-label', 'View Secure Lock ATM card');
        button.innerHTML = '<i class="fa-solid fa-credit-card fa-fw" aria-hidden="true"></i><span>Secure Lock Card</span>';
        button.addEventListener('click', openCardFromWand);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') openCardFromWand(event);
        });
        menu.appendChild(button);
        return true;
    }

    function watchWandMenu() {
        ensureWandButton();
        if (wandObserver) return;
        wandObserver = new MutationObserver(() => {
            ensureWandButton();
            patchVisibleVersion();
        });
        wandObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    async function loadViewportController() {
        try {
            const url = new URL('bootstrap-v022.js', extensionBaseUrl());
            url.searchParams.set('slv', VERSION);
            await import(url.href);
        } catch (error) {
            console.error('[Secure Lock] v0.2.3 could not load the viewport-safe controller.', error);
        }
    }

    installCardGestureGuards();
    watchWandMenu();
    await loadViewportController();
    patchVisibleVersion();
    ensureWandButton();
    scheduleClamp();

    console.info('[Secure Lock] v0.2.3 card polish + Wand Menu shortcut loaded.');
})();
