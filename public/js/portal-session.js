/* Actual foreground activity only; the database owns visit deduplication. */
(() => {
    let started = false;
    let sending = false;
    let lastSent = 0;
    const throttleMs = 30000;
    window.PortalSession = {
        start(user) {
            if (started || user.role !== '生徒' || user.needsPasswordChange) return;
            started = true;
            const activity = async () => {
                if (document.visibilityState !== 'visible' || sending || Date.now() - lastSent < throttleMs) return;
                sending = true;
                lastSent = Date.now();
                try {
                    await fetch('/api/usage/open', {
                        method: 'POST',
                        headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
                    });
                } catch (_) {
                    // Network failure must not prevent studying. Retry on a later real action.
                } finally { sending = false; }
            };
            for (const event of ['visibilitychange', 'pointerdown', 'keydown', 'scroll']) {
                document.addEventListener(event, activity, { passive: true });
            }
            for (const event of ['pageshow', 'focus']) window.addEventListener(event, activity);
            activity();
        }
    };
    // Centralized payment handling also covers direct lesson/special-content entry.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (response.status === 403 || response.status === 503) {
            const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.origin);
            if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
                const data = await response.clone().json().catch(() => ({}));
                if (['PAYMENT_REQUIRED', 'PORTAL_ACCESS_UNAVAILABLE'].includes(data.code)) {
                    location.replace('/access-restricted' +
                        (data.code === 'PORTAL_ACCESS_UNAVAILABLE' ? '?reason=unavailable' : ''));
                    // Prevent existing page error handlers from clearing a valid login token.
                    return new Promise(() => {});
                }
            }
        }
        return response;
    };
})();
