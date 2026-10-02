(() => {
    let started = false;
    const messages = {
        normal: 'あなたの発信が、一人ひとりの心に届いています。今日までの積み重ねに胸を張って、次の一歩もあなたらしく進んでいきましょう！',
        thousand: 'ついに1,000人！ あなたの声や世界観を楽しみにしている人が、こんなにも増えました。ここから始まる新しい景色へ。あなたの挑戦を、WannaVはこれからも応援しています！',
        tenThousand: 'ついに10,000人！ 一つひとつの挑戦が、大きな輪になりました。あなたにしか届けられない楽しさを、これからも世界へ。この大きな節目を、思いきり誇ってください！'
    };

    function show(event) {
        return new Promise(resolve => {
            const special = event.threshold === 1000 || event.threshold === 10000;
            const dialog = document.createElement('dialog');
            dialog.className = 'social-celebration' + (special ? ' social-celebration-special' : '');
            dialog.setAttribute('aria-labelledby', 'celebration-title');
            const canvas = document.createElement('canvas');
            canvas.className = 'celebration-confetti';
            canvas.setAttribute('aria-hidden', 'true');
            const card = document.createElement('div');
            card.className = 'celebration-card';
            const badge = document.createElement('p');
            badge.className = 'celebration-badge';
            badge.textContent = special ? '🎊 SPECIAL MILESTONE 🎊' : '🎉 CONGRATULATIONS 🎉';
            const title = document.createElement('h2');
            title.id = 'celebration-title';
            title.textContent = `${event.platform === 'youtube' ? 'YouTubeの登録者数' : 'Xのフォロワー数'}が${event.threshold.toLocaleString('ja-JP')}人達成しました！`;
            const body = document.createElement('p');
            body.className = 'celebration-message';
            body.textContent = messages[event.threshold === 1000 ? 'thousand' : event.threshold === 10000 ? 'tenThousand' : 'normal'];
            const button = document.createElement('button');
            button.className = 'btn btn-primary';
            button.textContent = '次の目標へ！';
            card.append(badge, title, body, button);
            dialog.append(canvas, card);
            document.body.append(dialog);
            let frame = 0;
            dialog.addEventListener('close', () => {
                cancelAnimationFrame(frame);
                dialog.remove();
                resolve();
            }, { once: true });
            button.addEventListener('click', () => dialog.close());
            dialog.showModal();
            button.focus();
            if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const width = innerWidth, height = innerHeight;
            const ratio = Math.min(devicePixelRatio || 1, 2);
            canvas.width = width * ratio;
            canvas.height = height * ratio;
            ctx.scale(ratio, ratio);
            const colors = ['#ffcf40', '#ff5d99', '#51e2ff', '#a87cff', '#ffffff', '#78f3b1'];
            const particles = Array.from({ length: special ? 280 : 130 }, (_, i) => {
                const angle = Math.random() * Math.PI * 2;
                const speed = (140 + Math.random() * (special ? 600 : 380)) * Math.min(width / 700, 1);
                return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                    size: 4 + Math.random() * 6, spin: Math.random() * 10 - 5,
                    delay: special ? Math.floor(i / 95) * 0.32 : 0, color: colors[i % colors.length] };
            });
            let start;
            const duration = special ? 5 : 3.5;
            function draw(now) {
                if (start === undefined) start = now;
                const elapsed = (now - start) / 1000;
                ctx.clearRect(0, 0, width, height);
                for (const p of particles) {
                    const t = elapsed - p.delay;
                    if (t < 0) continue;
                    const spread = (1 - Math.exp(-1.1 * t)) / 1.1;
                    ctx.save();
                    ctx.globalAlpha = Math.max(0, 1 - t / duration);
                    ctx.fillStyle = p.color;
                    ctx.translate(width / 2 + p.vx * spread, height / 2 + p.vy * spread + 95 * t * t);
                    ctx.rotate(t * p.spin);
                    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
                    ctx.restore();
                }
                if (elapsed < duration + 0.7) frame = requestAnimationFrame(draw);
                else ctx.clearRect(0, 0, width, height);
            }
            frame = requestAnimationFrame(draw);
        });
    }

    window.SocialCelebration = {
        async start(user) {
            if (started || user.role !== '生徒' || user.needsPasswordChange) return;
            started = true;
            // Important announcements and other modal dialogs take precedence.
            const waitUntilReady = () => new Promise(resolve => {
                const check = () => {
                    if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) resolve();
                    else setTimeout(check, 300);
                };
                setTimeout(check, 500);
            });
            try {
                await window.ImportantMessageReady;
                // Claim YouTube only after X closes, so leaving early does not consume both.
                for (const platform of ['x', 'youtube']) {
                    await waitUntilReady();
                    const res = await fetch('/api/social-metrics/milestones/claim', {
                        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                        body: JSON.stringify({ platform })
                    });
                    if (!res.ok) continue;
                    const data = await res.json();
                    for (const event of data.celebrations || []) {
                        if (event.platform !== platform || !Number.isSafeInteger(event.threshold) || event.threshold < 100) continue;
                        await waitUntilReady();
                        await show(event);
                    }
                }
            } catch (_) { /* A celebration must never prevent the student from studying. */ }
        }
    };
})();
