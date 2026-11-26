// Grab – popup: live downloads + media found in the active tab.

const $ = sel => document.querySelector(sel);
const ACTIVE = ['starting', 'downloading', 'merging', 'saving'];

let tab = null;
let helper = null;            // result of the helper check (null = still checking)
const jobs = new Map();

// ---------- formatting ----------

function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const pad = x => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fileNameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || url); }
  catch { return url; }
}
function qualityLabel(v) {
  const res = v.height ? `${v.height}p` : (v.resolution || 'auto');
  return res + (v.bandwidth ? ` · ${(v.bandwidth / 1e6).toFixed(1)} Mbps` : '');
}
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) if (c != null && c !== false) e.append(c);
  return e;
}
function youtubeIdFromPage(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host !== 'youtube.com') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch { return null; }
}
const ytDlpCommand = url => `yt-dlp -f "bv*+ba/b" -S "res,vcodec:h264,acodec:m4a" --merge-output-format mp4 "${url}"`;

async function copyText(btn, text) {
  const label = btn.textContent;
  await navigator.clipboard.writeText(text);
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = label), 1200);
}

// ---------- downloads section ----------

function jobStatus(j) {
  switch (j.status) {
    case 'starting': return 'Starting…';
    case 'downloading': {
      const bits = [j.progress > 0 ? `${Math.floor(j.progress * 100)}%` : 'Starting…'];
      if (j.bytes) bits.push(j.total ? `${fmtSize(j.bytes)} of ${fmtSize(j.total)}` : fmtSize(j.bytes));
      if (j.speed) bits.push(`${fmtSize(j.speed)}/s`);
      return bits.join(' · ');
    }
    case 'merging': return 'Merging video and audio…';
    case 'saving': return 'Saving file…';
    case 'done': return `Saved${j.bytes ? ` · ${fmtSize(j.bytes)}` : ''}`;
    case 'cancelled': return 'Cancelled';
    case 'error': return j.error || 'Failed';
  }
  return '';
}

function renderJobs() {
  const list = [...jobs.values()].sort((a, b) => b.time - a.time).slice(0, 6);
  $('#jobsSection').hidden = !list.length;
  $('#jobs').replaceChildren(...list.map(j => {
    const active = ACTIVE.includes(j.status);
    const actions = [];
    if (active) {
      const c = el('button', { className: 'link', textContent: 'Cancel' });
      c.onclick = () => chrome.runtime.sendMessage({ type: 'cancel', id: j.id });
      actions.push(c);
    } else if (j.status === 'done') {
      const s = el('button', { className: 'link', textContent: 'Show in folder' });
      s.onclick = () => chrome.runtime.sendMessage({ type: 'reveal', id: j.id });
      actions.push(s);
    }
    return el('li', { className: `job ${j.status}` },
      el('div', { className: 'row' },
        el('span', { className: 'name', textContent: j.title || 'video', title: j.title || '' }),
        j.label ? el('span', { className: 'meta', textContent: j.label }) : null),
      active ? el('div', { className: 'bar' }, el('div', { className: 'fill', style: `width:${Math.round((j.progress || 0) * 100)}%` })) : null,
      el('div', { className: 'row' },
        el('span', { className: `status ${j.status}`, textContent: jobStatus(j), title: j.error || '' }),
        ...actions),
    );
  }));
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'job') return;
  jobs.set(msg.job.id, msg.job);
  renderJobs();
});

// ---------- detected media ----------

async function start(btn, req) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Starting…';
  const res = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, ...req });
  btn.textContent = res?.ok ? 'Started' : 'Failed';
  if (!res?.ok) { btn.title = res?.error || ''; btn.disabled = false; }
  setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
}

function helperMissingNote() {
  return helper && !helper.ok
    ? el('div', { className: 'note', textContent: 'One-click needs the helper: run native-host\\install.ps1 once. Or copy the command.' })
    : null;
}

function renderItems(items) {
  const list = $('#list');
  list.replaceChildren();
  $('#empty').hidden = items.length > 0;

  for (const it of items) {
    let tagText = it.kind === 'file' ? it.ext : it.kind;
    let name = fileNameFromUrl(it.url);
    const metaBits = [];
    let note = null, select = null, disabled = false, extra = null;
    let req = { item: it };

    if (it.kind === 'youtube') {
      tagText = 'YouTube';
      name = tab.title || `Video ${it.videoId}`;
      metaBits.push('Best quality MP4 via yt-dlp');
      note = helperMissingNote();
      extra = el('button', { className: 'ghost', textContent: 'Copy command' });
      extra.onclick = () => copyText(extra, ytDlpCommand(it.url));
    } else if (it.kind === 'file') {
      if (it.size) metaBits.push(fmtSize(it.size));
      if (it.mime) metaBits.push(it.mime);
    } else if (it.kind === 'hls') {
      const h = it.hls;
      if (!h) metaBits.push('Stream (best quality chosen automatically)');
      else if (h.master) {
        select = el('select', { title: 'Quality' });
        for (const v of h.variants) select.append(el('option', { value: v.url, textContent: qualityLabel(v) }));
        metaBits.push(`${h.variants.length} qualities`);
      } else {
        if (h.duration) metaBits.push(fmtDuration(h.duration));
        metaBits.push(h.fmp4 ? 'saves as .mp4' : 'saves as .ts');
        if (h.encryption === 'aes-128') metaBits.push('encrypted (ok)');
        if (h.encryption === 'drm') { note = el('div', { className: 'note', textContent: 'DRM-protected: cannot be downloaded.' }); disabled = true; }
        else if (h.live) note = el('div', { className: 'note', textContent: 'Live stream: only the part available now is saved.' });
      }
    } else if (it.kind === 'dash') {
      metaBits.push('Downloaded with yt-dlp');
      req = { item: { kind: 'page', url: tab.url } };
      note = helperMissingNote();
    }

    const dl = el('button', { className: 'primary', textContent: 'Download', disabled });
    dl.onclick = () => start(dl, {
      ...req,
      variantUrl: select?.value || '',
      label: select ? select.selectedOptions[0].textContent.split(' · ')[0] : '',
    });

    list.append(el('li', {},
      el('div', { className: 'row' },
        el('span', { className: `tag ${it.kind}`, textContent: tagText }),
        el('span', { className: 'name', textContent: name, title: it.url })),
      metaBits.length ? el('div', { className: 'meta', textContent: metaBits.join(' · ') }) : null,
      note,
      el('div', { className: 'row actions' }, select, extra, dl),
    ));
  }
}

function renderHelper() {
  const btn = $('#pageDl');
  const noteEl = $('#helperNote');
  if (!helper) { btn.disabled = true; noteEl.hidden = true; return; }
  btn.disabled = !helper.ok || !/^https?:/i.test(tab.url || '');
  noteEl.hidden = helper.ok;
  noteEl.textContent = helper.ok ? '' : 'yt-dlp helper not installed. Run native-host\\install.ps1 once to enable one-click YouTube and other sites.';
}

// ---------- boot ----------

async function main() {
  // popup.html?tab=<id> shows another tab's media (handy for debugging / opening the popup as a page)
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  $('#page').textContent = tab.title || tab.url || '';

  const [listRes, jobsRes] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'list', tabId: tab.id }),
    chrome.runtime.sendMessage({ type: 'jobs' }),
  ]);
  for (const j of jobsRes?.jobs || []) jobs.set(j.id, j);
  renderJobs();

  const items = listRes?.items || [];
  const ytId = youtubeIdFromPage(tab.url);
  if (ytId && !items.some(x => x.videoId === ytId)) {
    items.unshift({ kind: 'youtube', videoId: ytId, url: `https://www.youtube.com/watch?v=${ytId}` });
  }
  renderItems(items);
  renderHelper();

  chrome.runtime.sendMessage({ type: 'helper' }).then(h => {
    helper = h || { ok: false };
    renderItems(items);
    renderHelper();
  });

  $('#clear').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clear', tabId: tab.id });
    renderItems([]);
  };
  $('#clearJobs').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearJobs' });
    for (const [id, j] of jobs) if (!ACTIVE.includes(j.status)) jobs.delete(id);
    renderJobs();
  };
  $('#pageDl').onclick = () => start($('#pageDl'), { item: { kind: 'page', url: tab.url } });
}

main();
