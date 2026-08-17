/* Secure Lock v0.2.2 visual-viewport entrypoint.
 *
 * v0.2.1 proved the UI itself works, but iOS Safari can place position:fixed
 * descendants against a layout viewport that does not match the visible
 * browser viewport. That is why the Card/Test ATM could render near the top
 * of the chat instead of in the center of the screen.
 *
 * This entrypoint keeps the working v0.2.1 interaction controller, then moves
 * Secure Lock's overlay root to documentElement and pins that root to the
 * *visual* viewport with document coordinates. Card/ATM children are absolute
 * inside that host, so browser chrome, page scrolling, and SillyTavern layout
 * transforms cannot change their centering.
 */

(async () => {
    'use strict';

    const VERSION = '0.2.2';
    const ROOT_ID = 'secure-lock-overlay-root';
    const SETTINGS_ROOT_ID = 'secure-lock-settings-root';
    const HOST_Z = '2147483000';

    let rootObserver = null;
    let repairFrame = 0;

    function extensionBaseUrl() {
        const script = Array.from(document.scripts).find(el => /secure-lock-extension\/bootstrap-v022\.js(?:\?|$)/.test(el.src));
        if (script?.src) return new URL('.', script.src);
        return new URL('/scripts/extensions/third-party/secure-lock-extension/', location.origin);
    }

    async function loadController() {
        try {
            const url = new URL('bootstrap.js', extensionBaseUrl());
            url.searchParams.set('slv', VERSION);
            await import(url.href);
        } catch (error) {
            console.error('[Secure Lock] v0.2.2 could not load the interaction controller.', error);
        }
    }

    function setImportant(el, property, value) {
        if (!(el instanceof HTMLElement)) return;
        if (el.style.getPropertyValue(property) === value && el.style.getPropertyPriority(property) === 'important') return;
        el.style.setProperty(property, value, 'important');
    }

    function visualViewportRect() {
        const vv = window.visualViewport;
        const doc = document.documentElement;
        const width = Math.max(1, Number(vv?.width) || doc.clientWidth || window.innerWidth || 1);
        const height = Math.max(1, Number(vv?.height) || window.innerHeight || doc.clientHeight || 1);
        const left = (window.scrollX || window.pageXOffset || 0) + (Number(vv?.offsetLeft) || 0);
        const top = (window.scrollY || window.pageYOffset || 0) + (Number(vv?.offsetTop) || 0);
        return { left, top, width, height };
    }

    function patchVisibleVersion() {
        const settingsRoot = document.getElementById(SETTINGS_ROOT_ID);
        if (!settingsRoot) return;
        settingsRoot.querySelectorAll('.secure-lock-settings__meta').forEach(el => {
            if (/ATM\s*&\s*card foundation v/i.test(el.textContent || '')) {
                el.textContent = `ATM & card foundation v${VERSION}`;
            }
        });
        settingsRoot.dataset.secureLockVersion = VERSION;
    }

    function upgradePublicUiVersion() {
        const current = globalThis.SecureLockUI;
        if (!current || current.version === VERSION) return;
        try {
            globalThis.SecureLockUI = Object.freeze({
                ...current,
                version: VERSION,
            });
        } catch {}
    }

    function observeRoot(root) {
        if (!(root instanceof HTMLElement)) return;
        if (rootObserver?.__slRoot === root) return;
        rootObserver?.disconnect();
        rootObserver = new MutationObserver(() => scheduleRepair());
        rootObserver.__slRoot = root;
        rootObserver.observe(root, {
            attributes: true,
            attributeFilter: ['style', 'hidden', 'class'],
            childList: true,
            subtree: true,
        });
    }

    function repairViewportHost() {
        patchVisibleVersion();
        upgradePublicUiVersion();

        const root = document.getElementById(ROOT_ID);
        if (!(root instanceof HTMLElement)) return;

        // Escape SillyTavern/body transformed containers entirely. Global ID
        // lookups and existing event listeners survive this DOM move.
        if (root.parentElement !== document.documentElement) {
            document.documentElement.appendChild(root);
        }

        const { left, top, width, height } = visualViewportRect();

        // v0.2.1's forceOverlayLayer() may re-apply fixed/inset:0 each time a
        // preview is opened. Remove that shorthand first, then restore the
        // actual visual-viewport host. The observer re-runs this immediately
        // after any later v0.2.1 inline-style mutation.
        root.style.removeProperty('inset');
        setImportant(root, 'position', 'absolute');
        setImportant(root, 'left', `${left}px`);
        setImportant(root, 'top', `${top}px`);
        setImportant(root, 'right', 'auto');
        setImportant(root, 'bottom', 'auto');
        setImportant(root, 'width', `${width}px`);
        setImportant(root, 'height', `${height}px`);
        setImportant(root, 'margin', '0');
        setImportant(root, 'transform', 'none');
        setImportant(root, 'display', 'block');
        setImportant(root, 'visibility', 'visible');
        setImportant(root, 'opacity', '1');
        setImportant(root, 'z-index', HOST_Z);
        setImportant(root, 'pointer-events', 'none');
        root.dataset.secureLockViewportHost = VERSION;

        observeRoot(root);
    }

    function scheduleRepair() {
        if (repairFrame) return;
        repairFrame = requestAnimationFrame(() => {
            repairFrame = 0;
            repairViewportHost();
        });
    }

    // Install viewport listeners before loading the old controller so the host
    // is repaired as soon as the core creates it.
    const pageObserver = new MutationObserver(() => scheduleRepair());
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('resize', scheduleRepair, { passive: true });
    window.addEventListener('scroll', scheduleRepair, { passive: true });
    window.addEventListener('orientationchange', scheduleRepair, { passive: true });
    window.visualViewport?.addEventListener('resize', scheduleRepair, { passive: true });
    window.visualViewport?.addEventListener('scroll', scheduleRepair, { passive: true });

    await loadController();
    upgradePublicUiVersion();
    patchVisibleVersion();
    scheduleRepair();

    console.info('[Secure Lock] v0.2.2 visual viewport host loaded.');
})();
