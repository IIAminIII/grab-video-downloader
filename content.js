// Grab – floating "Download" button over videos. Runs in every frame.
(() => {
  if (window.__grabInjected) return;
  window.__grabInjected = true;

  const MIN_W = 220, MIN_H = 130;
  const IS_YT = /(^|\.)youtube(-nocookie)?\.com$/i.test(location.hostname);

  function youtubeId() {
    if (!IS_YT) return null;
    const p = location.pathname;
    if (p === '/watch') return new URLSearchParams(location.search).get('v');
    const m = p.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  // ---------- messaging (survives extension reloads gracefully) ----------

  let dead = false;
  async function send(msg) {
    if (dead) return null;
    try { return await chrome.runtime.sendMessage(msg); }
    catch (e) {
      if (/context invalidated/i.test(String(e))) { dead = true; root?.remove(); }
      return null;
    }
  }

  // ---------- UI (shadow DOM so page CSS can't touch it) ----------

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; top: 0; left: 0; opacity: 0; transform: translateY(-4px);
            transition: opacity .15s, transform .15s; pointer-events: none;
            font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .wrap.on { opacity: 1; transform: none; pointer-events: auto; }
    .btn { position: relative; overflow: hidden; display: flex; align-items: center; gap: 7px;
           height: 32px; padding: 0 13px 0 10px; border: 1px solid rgba(255,255,255,.18); border-radius: 16px;
           background: rgba(17,19,23,.82); color: #fff; cursor: pointer; font: inherit;
           backdrop-filter: blur(8px); box-shadow: 0 4px 14px rgba(0,0,0,.35); white-space: nowrap; }
    .btn:hover { background: rgba(22,163,74,.95); border-color: transparent; }
    .btn svg { width: 16px; height: 16px; flex: none; }
    .bar { position: absolute; left: 0; bottom: 0; height: 3px; width: 0; background: #22c55e; transition: width .25s; }
    .btn.busy .bar { width: var(--p, 0%); }
    .btn.done { background: rgba(22,163,74,.95); }
    .btn.err { background: rgba(185,28,28,.92); }
    .menu { position: absolute; top: 38px; right: 0; min-width: 240px; max-width: 340px; max-height: 320px; overflow: auto;
            background: #1b1e23; color: #e8eaee; border: 1px solid #33373f; border-radius: 10px; padding: 6px;
            box-shadow: 0 12px 32px rgba(0,0,0,.45); }
    .menu[hidden] { display: none; }
    .wrap.center .menu { right: auto; left: 50%; transform: translateX(-50%); }
    .opt { display: block; width: 100%; text-align: left; padding: 8px 10px; border: 0; border-radius: 6px;
           background: transparent; color: inherit; font: inherit; cursor: pointer; }
    .opt:hover, .opt:focus-visible { background: #2a2e35; outline: none; }
    .opt .t { display: block; font-weight: 600; }
    .opt .s { display: block; margin-top: 3px; font-weight: 400; font-size: 12px; color: #9aa0ab;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .opt.fallback { border-top: 1px solid #33373f; border-radius: 0 0 6px 6px; margin-top: 4px; }
    .msg { padding: 10px; font-weight: 400; line-height: 1.45; color: #c4c8d0; }
    .msg b { color: #fff; }
    code { background: #2a2e35; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
  `;
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>';

  let root, wrap, btn, lbl, menu;
  function build() {
    if (root) return;
    root = document.createElement('grab-overlay');
    const shadow = root.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="wrap"><button class="btn" type="button">${ICON}<span class="lbl">Download</span><span class="bar"></span></button>
      <div class="menu" hidden></div></div>`;
    wrap = shadow.querySelector('.wrap');
    btn = shadow.querySelector('.btn');
    lbl = shadow.querySelector('.lbl');
    menu = shadow.querySelector('.menu');
    // keep the page's player from reacting to our clicks
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'])
      wrap.addEventListener(ev, e => e.stopPropagation());
    btn.addEventListener('click', onButton);
    wrap.addEventListener('mouseenter', () => { overUi = true; clearTimeout(hideTimer); });
    wrap.addEventListener('mouseleave', () => { overUi = false; scheduleHide(); });
    mount();
  }

  function mount() {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (root.parentNode !== parent) parent.appendChild(root);
  }
  document.addEventListener('fullscreenchange', () => { if (root) { mount(); place(); } });

  // ---------- show / hide / position ----------

  let target = null, overUi = false, menuOpen = false, hideTimer = 0, raf = 0, mx = -1, my = -1;

  function eligible(v) {
    const r = v.getBoundingClientRect();
    return r.width >= MIN_W && r.height >= MIN_H && r.bottom > 0 && r.top < innerHeight ? r : null;
  }

  function show(v, ms) {
    if (dead) return;
    if (IS_YT && !youtubeId()) return; // YouTube home/feed previews: nothing sensible to download
    build();
    target = v;
    mount();
    place();
    wrap.classList.add('on');
    clearTimeout(hideTimer);
    if (ms) scheduleHide(ms);
  }

  function hide() {
    if (!wrap || menuOpen || overUi) return;
    wrap.classList.remove('on');
    target = null;
  }

  function scheduleHide(ms = 1200) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, ms);
  }

  function place() {
    if (!target || !wrap) return;
    const r = target.getBoundingClientRect();
    if (!r.width) return hide();
    const w = btn.offsetWidth || 120;
    const center = IS_YT; // YouTube's own icons sit in the top corners
    wrap.classList.toggle('center', center);
    let left = center ? r.left + r.width / 2 - w / 2 : r.right - w - 12;
    let top = Math.max(r.top + 12, 6);
    left = Math.max(6, Math.min(left, innerWidth - w - 6));
    top = Math.min(top, innerHeight - 40);
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
  }

  function check() {
    raf = 0;
    if (menuOpen || dead) return;
    let hit = null;
    for (const v of document.getElementsByTagName('video')) {
      const r = eligible(v);
      if (r && mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) { hit = v; break; }
    }
    if (hit) show(hit);
    else if (!overUi && wrap?.classList.contains('on')) scheduleHide();
  }

  document.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    if (!raf) raf = requestAnimationFrame(check);
  }, { passive: true, capture: true });

  // Flash the button for a few seconds when a video starts playing.
  document.addEventListener('play', e => {
    const v = e.target;
    if (v instanceof HTMLVideoElement && eligible(v) && !menuOpen) show(v, 3500);
  }, true);

  addEventListener('scroll', () => { if (wrap?.classList.contains('on')) place(); }, { passive: true, capture: true });
  addEventListener('resize', () => { if (wrap?.classList.contains('on')) place(); }, { passive: true });

  // ---------- menu ----------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function openMenu(nodes) {
    menu.replaceChildren(...nodes);
    menu.hidden = false;
    menuOpen = true;
    clearTimeout(hideTimer);
    menu.querySelector('.opt')?.focus({ preventScroll: true });
  }
  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    menuOpen = false;
    if (!overUi) scheduleHide();
  }
  document.addEventListener('pointerdown', e => {
    if (menuOpen && !e.composedPath().includes(root)) closeMenu();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && menuOpen) closeMenu(); }, true);

  function option(title, sub, onPick, cls = '') {
    const b = el('button', `opt ${cls}`);
    b.type = 'button';
    b.append(el('span', 't', title));
    if (sub) b.append(el('span', 's', sub));
    b.addEventListener('click', () => { closeMenu(); onPick(); });
    return b;
  }

  const fmtSize = n => {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < 3) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || !i ? 0 : 1)} ${u[i]}`;
  };
  const fmtDur = s => {
    if (!s) return '';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  };
  const fileName = u => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()) || u; } catch { return u; } };

  /** Turn detected media into menu choices, best first. */
  async function buildOptions() {
    const { items = [] } = (await send({ type: 'list' })) || {};
    const opts = [];
    const src = target?.currentSrc;
    if (src && /^https?:/i.test(src) && !items.some(i => i.url === src)) {
      const ext = (src.match(/\.(\w{2,4})(\?|#|$)/) || [])[1] || 'mp4';
      items.unshift({ kind: 'file', url: src, ext, size: 0 });
    }
    for (const it of items) {
      if (it.kind === 'youtube') {
        opts.push({ title: 'YouTube video', sub: 'Best quality, MP4', item: it });
      } else if (it.kind === 'hls') {
        const h = it.hls;
        if (h?.encryption === 'drm') continue;
        if (h?.master) {
          for (const v of h.variants) {
            const q = v.height ? `${v.height}p` : (v.resolution || 'Stream');
            opts.push({ title: q, sub: `Stream${v.bandwidth ? ` · ${(v.bandwidth / 1e6).toFixed(1)} Mbps` : ''}`, item: it, variantUrl: v.url, label: q });
          }
        } else {
          opts.push({ title: 'Stream', sub: [fmtDur(h?.duration), h?.fmp4 ? 'MP4' : 'TS'].filter(Boolean).join(' · ') || 'HLS', item: it });
        }
      } else if (it.kind === 'dash') {
        opts.push({ title: 'DASH stream', sub: 'Downloaded with yt-dlp', item: { kind: 'page', url: location.href } });
      } else {
        opts.push({ title: `${(it.ext || 'file').toUpperCase()}${it.size ? ` · ${fmtSize(it.size)}` : ''}`, sub: fileName(it.url), item: it });
      }
    }
    return opts;
  }

  async function onButton() {
    if (menuOpen) return closeMenu();

    if (current && ['starting', 'downloading', 'merging', 'saving'].includes(current.status)) {
      return openMenu([
        el('div', 'msg', [statusText(current), current.title].filter(Boolean).join(' · ')),
        option('Cancel download', null, () => send({ type: 'cancel', id: current.id })),
      ]);
    }

    const yt = youtubeId();
    if (yt) return start({ item: { kind: 'youtube', url: `https://www.youtube.com/watch?v=${yt}`, videoId: yt } });

    setLabel('Looking…');
    const opts = await buildOptions();
    setLabel('Download');
    if (opts.length === 1) return start(opts[0]);

    const nodes = opts.map(o => option(o.title, o.sub, () => start(o)));
    if (!opts.length) nodes.push(el('div', 'msg', 'Nothing detected yet. Let the video play for a moment, or try yt-dlp:'));
    nodes.push(option('Try yt-dlp on this page', 'Works on 1000+ sites (needs the helper)',
      () => start({ item: { kind: 'page', url: location.href } }), opts.length ? 'fallback' : ''));
    openMenu(nodes);
  }

  async function start(o) {
    setLabel('Starting…');
    const res = await send({ type: 'start', item: o.item, variantUrl: o.variantUrl, label: o.label });
    if (!res?.ok) setLabel('Failed', 'err');
  }

  // ---------- progress from the background ----------

  let current = null;
  let resetTimer = 0;

  function setLabel(text, state = '', pct = null) {
    if (!btn) return;
    lbl.textContent = text;
    btn.classList.toggle('busy', pct != null);
    btn.classList.toggle('done', state === 'done');
    btn.classList.toggle('err', state === 'err');
    if (pct != null) btn.style.setProperty('--p', `${Math.round(pct * 100)}%`);
    if (target) place();
  }

  function statusText(j) {
    if (j.status === 'downloading') return j.progress > 0 ? `${Math.floor(j.progress * 100)}%` : 'Starting…';
    return { starting: 'Starting…', merging: 'Merging…', saving: 'Saving…' }[j.status] || '';
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'job' || !btn) return;
    const j = msg.job;
    if (current && current.id !== j.id && j.time < current.time) return; // older job, ignore
    current = j;
    clearTimeout(resetTimer);
    if (['starting', 'downloading', 'merging', 'saving'].includes(j.status)) {
      setLabel(statusText(j), '', j.progress || 0);
    } else if (j.status === 'done') {
      setLabel('Saved', 'done');
      if (target) show(target, 4000);
      resetTimer = setTimeout(() => setLabel('Download'), 4000);
    } else if (j.status === 'error') {
      setLabel('Failed', 'err');
      if (target) {
        show(target);
        const nodes = [el('div', 'msg', j.error || 'Download failed')];
        if (j.needsHelper) {
          const m = el('div', 'msg');
          m.innerHTML = '<b>One-time setup:</b> run <code>native-host\\install.ps1</code> from the extension folder, then try again.';
          nodes.splice(0, 1, m);
        }
        openMenu(nodes);
      }
      resetTimer = setTimeout(() => setLabel('Download'), 5000);
    } else {
      setLabel('Download');
    }
  });
})();
