// Loaded before page scripts: observe same-origin API responses without retrying them.
(() => {
    const originalFetch = window.fetch.bind(window);
    let redirecting = false;
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = new URL(args[0] instanceof Request ? args[0].url : args[0], window.location.origin);
        if (response.status === 401 && url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
            const body = await response.clone().json().catch(() => null);
            if (body?.code === 'TOKEN_EXPIRED' && !redirecting) {
                redirecting = true;
                localStorage.removeItem('token');
                sessionStorage.setItem('portal-session-expired', '1');
                // HttpOnly portal_media is expired by the server, never read by JavaScript.
                if (window.location.pathname !== '/') window.location.replace('/?session=expired');
                else showExpiry();
            }
        }
        return response;
    };
    function showExpiry() {
        const container = document.getElementById('alert-container');
        if (container) {
            container.textContent = 'セッションの有効期限が切れました。再度ログインしてください。';
            container.setAttribute('role', 'alert');
        }
    }
    document.addEventListener('DOMContentLoaded', () => {
        if (window.location.pathname === '/' && (sessionStorage.getItem('portal-session-expired') === '1'
            || new URLSearchParams(window.location.search).get('session') === 'expired')) {
            sessionStorage.removeItem('portal-session-expired');
            showExpiry();
            window.history.replaceState(null, '', '/');
        }
    });
})();
