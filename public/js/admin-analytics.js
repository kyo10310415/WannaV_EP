(() => {
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
    const number = value => value == null ? '算出不可' : Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
    const percent = value => value == null ? '対象なし／算出不可' : number(value) + '%';
    const date = value => value ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '未同期';
    async function get(url) {
        const response = await fetch(url, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
        if (!response.ok) throw new Error('情報を取得できませんでした。時間をおいて再度お試しください。');
        return response.json();
    }
    window.loadPaymentSyncStatus = async () => {
        const target = document.getElementById('payment-sync-status');
        try {
            const status = await get('/api/admin/payment-sync');
            target.textContent = 'アクセス制御：' + (status.enabled ? '有効' : '無効') +
                ' ／ 対象月：' + status.target_month.slice(0, 7) +
                ' ／ 最終正常同期：' + date(status.last_success_at) +
                (status.configured ? '' : ' ／ スプレッドシート未設定') +
                (status.last_error ? ' ／ 同期エラー：' + status.last_error : '') +
                ' ／ 要確認：' + (status.issues || []).length + '件';
            if (status.issues?.length) {
                const details = document.createElement('details');
                const summary = document.createElement('summary');
                summary.textContent = '同期で要確認となった生徒';
                details.append(summary);
                for (const issue of status.issues) {
                    const item = document.createElement('p');
                    item.textContent = '生徒ID ' + issue.user_id + '：' + issue.code;
                    details.append(item);
                }
                target.append(details);
            }
        } catch (error) { target.textContent = error.message; }
    };
    function kpiTable(k) {
        const entries = [
            ['教材完了', number(k.completed) + ' / ' + number(k.total) + '（' + percent(k.completion_rate) + '）'],
            ['アクセス可能教材', number(k.accessible) + ' / ' + number(k.total) + '（' + percent(k.unlock_rate) + '）'],
            ['動画を開いた教材', number(k.videos_opened) + ' / ' + number(k.video_total)],
            ['動画を開いた回数', number(k.video_views)],
            ['視聴完了（視聴率95%以上）', number(k.videos_watched) + ' / ' + number(k.video_total)],
            ['小テスト受験率', number(k.quiz_attempted) + ' / ' + number(k.quiz_total) + '（' + percent(k.quiz_attempt_rate) + '）'],
            ['小テスト最終合格率', number(k.quiz_passed) + ' / ' + number(k.quiz_total) + '（' + percent(k.quiz_final_pass_rate) + '）'],
            ['総受験回数 / 不合格回数', number(k.quiz_attempts) + ' / ' + number(k.quiz_failed_attempts)],
            ['平均受験回数 / 平均リトライ回数', number(k.average_attempts) + ' / ' + number(k.average_retries)],
            ['受験ベース合格率', percent(k.quiz_attempt_pass_rate)]
        ];
        return '<table class="table"><tbody>' + entries.map(([label, value]) =>
            '<tr><th>' + esc(label) + '</th><td>' + esc(value) + '</td></tr>').join('') + '</tbody></table>';
    }
    let request = 0;
    window.openCourseProgress = async userId => {
        const id = ++request;
        const dialog = document.getElementById('analytics-dialog');
        const body = document.getElementById('analytics-content');
        body.textContent = 'コース別進捗を読み込み中…';
        if (!dialog.open) dialog.showModal();
        try {
            const data = await get('/api/admin/users/' + userId + '/analytics');
            if (id !== request) return;
            const courses = data.learning.courses.filter(course => !course.special);
            body.innerHTML = '<h3>コース別進捗（通常コース）</h3>' +
                (courses.length ? '<table class="table"><thead><tr><th>コース</th><th>完了 / 総教材数</th><th>進捗率</th></tr></thead><tbody>' +
                courses.map(course => '<tr><td>' + esc(course.title) + '</td><td>' +
                    number(course.kpi.completed) + ' / ' + number(course.kpi.total) +
                    '</td><td>' + percent(course.kpi.completion_rate) + '</td></tr>').join('') +
                '</tbody></table>' : '<p>対象のコースはありません。</p>');
        } catch (error) { if (id === request) body.textContent = error.message; }
    };

    window.openStudentAnalytics = async userId => {
        const id = ++request;
        const dialog = document.getElementById('analytics-dialog');
        const target = document.getElementById('analytics-content');
        target.textContent = '読み込み中...';
        if (!dialog.open) dialog.showModal();
        try {
            const data = await get('/api/admin/users/' + userId + '/analytics');
            if (id !== request || !dialog.open) return;
            const p = data.payment;
            let html = '<h2>' + esc(data.student.name) + '</h2><h3 style="margin-top:20px">支払い状況</h3>';
            if (p) {
                html += '<p>学籍番号：' + esc(p.student_number || '未設定') + ' ／ 判定対象月：' +
                    esc(p.payment_month.slice(0, 7)) + '</p><p>同期済みステータス：' +
                    esc(p.payment_status ?? '未同期') + ' ／ ' +
                    (p.is_paid == null ? '未判定' : p.is_paid ? '支払い完了' : '支払い未完了') +
                    '</p><p>最終同期：' + esc(date(p.synced_at)) + '</p>' +
                    '<p>アクセス判定：' + (p.access.allowed ? '利用可能' : '利用制限') +
                    ' ／ ' + esc(p.access.reason) + '</p>' +
                    (p.issue ? '<p>要確認：' + esc(p.issue) + '</p>' : '');
            } else html += '<p>支払い情報なし</p>';
            html += '<h3 style="margin-top:24px">通常教材の学習状況</h3>' + kpiTable(data.learning.overall);
            html += '<h3 style="margin-top:24px">必須科目</h3>' + (data.learning.required_configured
                ? kpiTable(data.learning.required) : '<p>集計対象コースが未設定です。コース別の情報をご確認ください。</p>');
            html += '<p style="margin:20px 0;color:var(--gray-text)">平均回数は受験済み教材が対象です。過去の合否履歴がない場合、不合格回数・受験ベース合格率は算出不可です。視聴率は保存された再生位置または本人の完了操作を基にしており、小テストの合否とは別の指標です。</p>';
            for (const course of data.learning.courses) {
                const next = course.lessons.find(l => l.id === course.next_locked_lesson);
                html += '<details style="margin:20px 0"><summary>' + esc(course.title) +
                    (course.special ? '（スペシャル）' : '') + '</summary>' + kpiTable(course.kpi) +
                    '<p>次の未解放教材：' + esc(next?.title || 'なし') + '</p>' +
                    '<div style="overflow:auto"><table class="table"><thead><tr><th>教材</th><th>アクセス</th><th>表示回数</th><th>視聴率</th><th>教材完了</th><th>小テスト</th><th>受験 / 再受験 / 不合格</th></tr></thead><tbody>' +
                    course.lessons.map(l => '<tr><td>' + esc(l.title) + '</td><td>' + (l.can_access ? '可能' : '未解放') +
                        '</td><td>' + number(l.view_count) + '</td><td>' + (l.content_type === 'video' ? percent(l.watch_percent) : '対象外') +
                        '</td><td>' + (l.completed ? '完了' : '未完了') + '</td><td>' +
                        (!l.has_quiz ? 'なし' : l.quiz_passed ? '合格' : l.quiz_attempts > 0 ? '未合格' : '未受験') +
                        '</td><td>' + (l.has_quiz ? [l.quiz_attempts, l.quiz_retries, l.quiz_attempts === 0 ? 0 : l.quiz_failed_attempts].map(number).join(' / ') : '対象外') +
                        '</td></tr>').join('') + '</tbody></table></div></details>';
            }
            target.innerHTML = html;
        } catch (error) {
            if (id === request) target.textContent = error.message;
        }
    };
})();
