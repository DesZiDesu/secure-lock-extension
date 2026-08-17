const MODULE_NAME = 'secure_lock';
const EXTENSION_FOLDER = 'third-party/secure-lock-extension';
const SETTINGS_ROOT_ID = 'secure-lock-settings-root';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
});

function getContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch (error) {
        console.warn('[Secure Lock] Could not access SillyTavern context.', error);
        return null;
    }
}

function getSettings(context) {
    if (!context?.extensionSettings) return { ...DEFAULT_SETTINGS };

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = context.extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in settings)) settings[key] = value;
    }

    return settings;
}

function findSettingsHost() {
    return document.querySelector('#extensions_settings2')
        ?? document.querySelector('#extensions_settings');
}

function bindSettings(context, root, settings) {
    const enabled = root.querySelector('#secure-lock-enabled');
    if (!(enabled instanceof HTMLInputElement)) return;

    enabled.checked = Boolean(settings.enabled);
    enabled.addEventListener('change', () => {
        settings.enabled = enabled.checked;
        try {
            context?.saveSettingsDebounced?.();
        } catch (error) {
            console.warn('[Secure Lock] Could not save settings.', error);
        }
    });
}

async function buildSettingsDrawer(context) {
    if (document.getElementById(SETTINGS_ROOT_ID)) return true;

    const host = findSettingsHost();
    if (!host) return false;

    let html = '';
    try {
        html = await context?.renderExtensionTemplateAsync?.(
            EXTENSION_FOLDER,
            'settings',
            { version: '0.1.0' },
        );
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

async function initialize() {
    const context = getContext();
    if (!context) {
        console.warn('[Secure Lock] SillyTavern context is unavailable; initialization skipped safely.');
        return;
    }

    getSettings(context);

    if (await buildSettingsDrawer(context)) {
        console.info('[Secure Lock] Foundation loaded.');
        return;
    }

    // Some SillyTavern layouts mount the Extensions tab after third-party scripts.
    // Observe briefly instead of depending on a fixed startup delay.
    const observer = new MutationObserver(async () => {
        if (await buildSettingsDrawer(context)) observer.disconnect();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 15000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
