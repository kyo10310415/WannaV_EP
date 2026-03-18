const API_URL = '/api';

// ログインフォーム処理
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('login-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        try {
            const response = await fetch(`${API_URL}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (!response.ok) {
                showAlert(data.error || 'ログインに失敗しました', 'error');
                return;
            }

            // トークンを保存
            localStorage.setItem('token', data.token);

            // ダッシュボードへリダイレクト
            showAlert('ログイン成功！リダイレクトしています...', 'success');
            setTimeout(() => {
                window.location.href = '/dashboard';
            }, 1000);

        } catch (error) {
            console.error('ログインエラー:', error);
            showAlert('ログインに失敗しました。もう一度お試しください。', 'error');
        }
    });
});

// アラート表示関数
function showAlert(message, type) {
    const container = document.getElementById('alert-container');
    if (!container) return;

    container.innerHTML = `
        <div class="alert alert-${type === 'error' ? 'error' : 'success'}">
            ${message}
        </div>
    `;

    setTimeout(() => {
        container.innerHTML = '';
    }, 5000);
}
