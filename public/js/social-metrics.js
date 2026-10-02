/* Shared student sidebar and staff popup. All data comes from the authenticated portal API. */
window.SocialMetricsWidget = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => Number(value).toLocaleString('ja-JP');
  const date = value => new Date(value).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
  const messages = {
    not_configured: 'NotionのIDが未設定です', invalid_id: 'NotionのIDの形式を確認してください',
    pending: '今週のデータを取得待ちです', api_error: '取得に失敗しました。次回の自動取得で再試行します',
    not_found: 'アカウントが見つかりませんでした', hidden: '登録者数は非公開です',
  };

  function chart(history, fromDate, title) {
    if (!history.length) return '<p class="social-empty">履歴は取得開始後から蓄積されます</p>';
    const width = 360, height = 190, left = 55, right = 12, top = 14, bottom = 35;
    const start = new Date(fromDate + 'T00:00:00+09:00').getTime();
    const end = Date.now();
    const values = history.map(point => Number(point.count));
    const min = Math.min(...values), max = Math.max(...values);
    const padding = Math.max((max - min) * 0.15, 1);
    const low = Math.max(0, Math.floor(min - padding)), high = Math.ceil(max + padding);
    const x = point => left + Math.max(0, Math.min(1, (new Date(point.fetchedAt).getTime() - start) / Math.max(1, end - start))) * (width - left - right);
    const y = point => top + (high - point.count) / (high - low) * (height - top - bottom);
    let path = '';
    history.forEach((point, index) => {
      const gap = index && new Date(point.weekStart) - new Date(history[index - 1].weekStart) > 7 * 86400000;
      path += `${!index || gap ? 'M' : 'L'}${x(point).toFixed(1)},${y(point).toFixed(1)} `;
    });
    const ticks = [low, Math.round((low + high) / 2), high];
    return `<svg class="social-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}の週次推移">
      ${ticks.map(tick => { const ty = y({ count: tick }); return `<line x1="${left}" y1="${ty}" x2="${width - right}" y2="${ty}" class="social-gridline"/><text x="${left - 7}" y="${ty + 4}" text-anchor="end">${esc(number(tick))}</text>`; }).join('')}
      <path d="${path}" class="social-chart-line"/>
      ${history.map(point => `<circle cx="${x(point)}" cy="${y(point)}" r="4" class="social-chart-point"><title>${esc(date(point.fetchedAt))}：${esc(number(point.count))}人</title></circle>`).join('')}
      <text x="${left}" y="${height - 8}">${esc(date(fromDate + 'T00:00:00+09:00'))}</text>
      <text x="${width - right}" y="${height - 8}" text-anchor="end">${esc(date(new Date()))}</text>
    </svg>`;
  }

  function render(container, data) {
    if (!data) { container.innerHTML = '<p class="social-empty">Notionの生徒情報との連携が必要です</p>'; return; }
    container.innerHTML = `<p class="social-period">今週（${esc(date(data.weekStart + 'T00:00:00+09:00'))}〜）<br>X：過去2か月 ／ YouTube：直近30日</p>` +
      ['x', 'youtube'].map(platform => {
        const metric = data.platforms[platform];
        const title = platform === 'x' ? 'X フォロワー数' : 'YouTube 登録者数';
        const url = metric.accountId ? platform === 'x'
          ? 'https://x.com/' + encodeURIComponent(metric.accountId.replace(/^@/, ''))
          : 'https://www.youtube.com/channel/' + encodeURIComponent(metric.accountId) : null;
        return `<section class="social-platform ${platform}">
          <h3>${title}</h3>
          ${url ? `<a class="social-account" href="${url}" target="_blank" rel="noopener noreferrer">${esc(platform === 'x' ? '@' + metric.accountId.replace(/^@/, '') : metric.accountId)} ↗</a>` : ''}
          <div class="social-count">${metric.status === 'ok' ? esc(number(metric.count)) + '<span> 人</span>' : '—'}</div>
          <p class="social-status">${metric.status === 'ok' ? '取得日：' + esc(new Date(metric.fetchedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })) : esc(messages[metric.status] || '未取得')}</p>
          ${chart(metric.history, metric.fromDate || data.fromDate, title)}
          ${metric.history.length ? `<details class="social-history"><summary>週ごとの数値を見る</summary><table><thead><tr><th>取得日</th><th>人数</th></tr></thead><tbody>${metric.history.map(point => `<tr><td>${esc(date(point.fetchedAt))}</td><td>${esc(number(point.count))}</td></tr>`).join('')}</tbody></table></details>` : ''}
          ${platform === 'youtube' ? '<p class="social-note">YouTubeの公開登録者数は有効数字3桁で表示されます。</p>' : ''}
        </section>`;
      }).join('');
  }
  return { render };
})();
