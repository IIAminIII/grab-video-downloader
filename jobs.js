// Grab – download job manager (runs in the background service worker).
// One "job" per download, whatever engine runs it:
//   file  -> chrome.downloads            (direct mp4/webm/mp3 links)
//   hls   -> offscreen document           (m3u8 streams, merged in memory)
//   ytdlp -> native helper running yt-dlp (YouTube, DASH, anything else)

const HOST_NAME = 'com.grab.ytdlp';
const MAX_JOBS = 25;

// ---------- state ----------

let jobs = null; // id -> job
async function load() {
  if (!jobs) {
    const { jobs: saved = [] } = await chrome.storage.session.get('jobs');
    jobs = new Map(saved.map(j => [j.id, j]));
  }
  return jobs;
}
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ jobs: [...jobs.values()] }), 200);
}

const ACTIVE = new Set(['starting', 'downloading', 'merging', 'saving']);
const isActive = j => ACTIVE.has(j.status);

/** Push a job update to popup + the tab's floating button (throttled for progress ticks). */
const lastEmit = new Map();
function emit(job, force = false) {
  const now = Date.now();
  if (!force && now - (lastEmit.get(job.id) || 0) < 200) { persist(); return; }
  lastEmit.set(job.id, now);
  persist();
  chrome.runtime.sendMessage({ type: 'job', job }).catch(() => {});
  if (job.tabId >= 0) chrome.tabs.sendMessage(job.tabId, { type: 'job', job }).catch(() => {});
}

async function update(id, patch, force = false) {
  await load();
  const job = jobs.get(id);
  if (!job) return null;
  const wasActive = isActive(job);
  const prevStatus = job.status;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) job[k] = v;
  const finished = wasActive && !isActive(job);
  emit(job, force || finished || job.status !== prevStatus);
  if (finished) onFinished(job);
  return job;
}

async function create(fields) {
  await load();
  const job = {
    id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    status: 'starting', progress: 0, bytes: 0, total: 0, speed: null, label: '',
    time: Date.now(), ...fields,
  };
  jobs.set(job.id, job);
  // trim oldest finished jobs
  const finished = [...jobs.values()].filter(j => !isActive(j)).sort((a, b) => a.time - b.time);
  while (jobs.size > MAX_JOBS && finished.length) jobs.delete(finished.shift().id);
  emit(job, true);
  return job;
}

function onFinished(job) {
  removeRule(job);
  // file/hls jobs end in chrome.downloads, which shows its own "done" UI
  if (job.status === 'done' && job.kind === 'ytdlp') {
    chrome.notifications.create(`grab:${job.id}`, {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'Download complete', message: job.title || 'Video saved',
      contextMessage: 'Click to show the file',
    });
  } else if (job.status === 'error') {
    chrome.notifications.create(`grab:${job.id}`, {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'Download failed', message: job.error || 'Unknown error',
    });
  }
  maybeCloseHelper();
}

chrome.notifications.onClicked.addListener(nid => {
  if (nid.startsWith('grab:')) { reveal(nid.slice(5)); chrome.notifications.clear(nid); }
});

export async function listJobs() {
  await load();
  return [...jobs.values()].sort((a, b) => b.time - a.time);
}

export async function clearFinished() {
  await load();
  for (const j of [...jobs.values()]) if (!isActive(j)) jobs.delete(j.id);
  persist();
}

// ---------- naming ----------

export function safeName(name) {
  return (name || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'video';
}

// ---------- engine: chrome.downloads (direct files + finished HLS blobs) ----------

let pollTimer = null;
function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await load();
    const active = [...jobs.values()].filter(j => j.downloadId != null && (j.status === 'downloading' || j.status === 'saving'));
    if (!active.length) { clearInterval(pollTimer); pollTimer = null; return; }
    for (const j of active) {
      const [d] = await chrome.downloads.search({ id: j.downloadId });
      if (!d || j.kind !== 'file') continue;
      const elapsed = (Date.now() - j.time) / 1000;
      update(j.id, {
        bytes: d.bytesReceived, total: d.totalBytes || 0,
        progress: d.totalBytes > 0 ? d.bytesReceived / d.totalBytes : 0,
        speed: elapsed > 0.5 ? d.bytesReceived / elapsed : null,
      });
    }
  }, 700);
}

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state) return;
  await load();
  const job = [...jobs.values()].find(j => j.downloadId === delta.id);
  if (!job) return;
  if (delta.state.current === 'complete') {
    const [d] = await chrome.downloads.search({ id: delta.id });
    update(job.id, { status: 'done', progress: 1, bytes: d?.fileSize || job.bytes, filePath: d?.filename || null });
    if (job.kind === 'hls') offscreenSend({ type: 'hls-revoke', id: job.id });
  } else if (delta.state.current === 'interrupted') {
    const reason = delta.error?.current || 'interrupted';
    update(job.id, reason === 'USER_CANCELED' ? { status: 'cancelled' } : { status: 'error', error: `Download ${reason.toLowerCase().replace(/_/g, ' ')}` });
    if (job.kind === 'hls') offscreenSend({ type: 'hls-revoke', id: job.id });
  }
});

async function startFile(job, item) {
  const downloadId = await chrome.downloads.download({
    url: item.url,
    filename: `${safeName(job.title)}.${item.ext || 'mp4'}`,
    conflictAction: 'uniquify',
  });
  await update(job.id, { status: 'downloading', downloadId });
  ensurePolling();
}

// ---------- engine: offscreen HLS ----------

let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Download and merge HLS video segments in the background',
  }).finally(() => { creating = null; });
  await creating;
}
function offscreenSend(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}

// Referer/Origin header rules for offscreen fetches (tabId -1). Rule ids are per job.
const ruleIds = new Map(); // job id -> numeric rule id
let nextRule = 5000;
async function setRule(jobId, ref, hosts) {
  if (!ref || !hosts.length) return;
  let origin;
  try { origin = new URL(ref).origin; } catch { return; }
  if (!ruleIds.has(jobId)) ruleIds.set(jobId, nextRule++);
  const id = ruleIds.get(jobId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: ref },
        { header: 'Origin', operation: 'set', value: origin },
      ] },
      condition: { tabIds: [chrome.tabs.TAB_ID_NONE], requestDomains: hosts, resourceTypes: ['xmlhttprequest'] },
    }],
  });
}
function removeRule(job) {
  const id = ruleIds.get(job.id);
  if (id == null) return;
  ruleIds.delete(job.id);
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

async function startHls(job, item, variantUrl) {
  await ensureOffscreen();
  await update(job.id, { status: 'downloading' });
  offscreenSend({ type: 'hls-start', id: job.id, src: item.url, variant: variantUrl || '', ref: job.pageUrl || '' });
}

/** Messages coming back from the offscreen document. Returns true if handled. */
export async function handleOffscreen(msg) {
  switch (msg.type) {
    case 'hls-rule': { await load(); const j = jobs.get(msg.id); await setRule(msg.id, msg.ref || j?.pageUrl, msg.hosts); return true; }
    case 'hls-info':
      update(msg.id, { label: [msg.height ? `${msg.height}p` : '', `${msg.segments} segments`, msg.live ? 'live' : ''].filter(Boolean).join(' · ') }, true);
      return true;
    case 'hls-progress':
      update(msg.id, { progress: msg.progress, bytes: msg.bytes, speed: msg.speed });
      return true;
    case 'hls-ready': {
      const job = await update(msg.id, { status: 'saving', progress: 1, bytes: msg.size }, true);
      if (!job) return true;
      const downloadId = await chrome.downloads.download({
        url: msg.blobUrl, filename: `${safeName(job.title)}.${msg.ext}`, conflictAction: 'uniquify',
      });
      update(msg.id, { downloadId, ext: msg.ext });
      return true;
    }
    case 'hls-error': update(msg.id, { status: 'error', error: msg.error }, true); return true;
    case 'hls-cancelled': update(msg.id, { status: 'cancelled' }, true); return true;
  }
  return false;
}

// ---------- engine: native helper (yt-dlp) ----------

let port = null;
let helper = { checked: false, ok: false };
const helloWaiters = [];

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    helper = { checked: true, ok: false, error: String(e.message || e) };
    return null;
  }
  port.onMessage.addListener(onNative);
  port.onDisconnect.addListener(async () => {
    const err = chrome.runtime.lastError?.message || 'Helper closed';
    port = null;
    helper = { checked: true, ok: false, error: err };
    while (helloWaiters.length) helloWaiters.shift()(helper);
    await load();
    for (const j of jobs.values()) if (j.kind === 'ytdlp' && isActive(j)) update(j.id, { status: 'error', error: 'Helper stopped: ' + err }, true);
  });
  return port;
}

let idleTimer = null;
async function maybeCloseHelper() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    await load();
    if (port && ![...jobs.values()].some(j => j.kind === 'ytdlp' && isActive(j))) { port.disconnect(); port = null; }
  }, 30000);
}

/** { ok, ytdlp, ffmpeg, dir } or { ok:false, error } */
export function helperStatus() {
  return new Promise(resolve => {
    const p = connect();
    if (!p) return resolve(helper);
    const timer = setTimeout(() => resolve({ ok: false, error: 'Helper did not answer' }), 4000);
    helloWaiters.push(h => { clearTimeout(timer); resolve(h); });
    p.postMessage({ type: 'hello' });
    maybeCloseHelper();
  });
}

async function onNative(msg) {
  if (msg.type === 'hello') {
    helper = { checked: true, ok: !!msg.ytdlp, ytdlp: msg.ytdlp, ffmpeg: msg.ffmpeg, dir: msg.dir,
               error: msg.ytdlp ? null : 'yt-dlp is not installed (winget install yt-dlp.yt-dlp)' };
    while (helloWaiters.length) helloWaiters.shift()(helper);
    return;
  }
  if (!msg.id) return;
  switch (msg.type) {
    case 'info':
      update(msg.id, { title: msg.title || undefined, label: msg.height ? `${msg.height}p` : '' }, true);
      break;
    case 'progress':
      update(msg.id, { status: msg.stage === 'merging' ? 'merging' : 'downloading', progress: msg.progress,
                       bytes: msg.bytes, total: msg.total || 0, speed: msg.speed });
      break;
    case 'done': update(msg.id, { status: 'done', progress: 1, filePath: msg.filePath }, true); break;
    case 'error': update(msg.id, { status: 'error', error: msg.error }, true); break;
    case 'cancelled': update(msg.id, { status: 'cancelled' }, true); break;
  }
}

async function startYtdlp(job, url) {
  const h = helper.ok ? helper : await helperStatus();
  if (!h.ok) {
    await update(job.id, { status: 'error', error: 'Helper not installed. Run native-host\\install.ps1 once.', needsHelper: true }, true);
    return;
  }
  clearTimeout(idleTimer);
  await update(job.id, { status: 'downloading' });
  connect().postMessage({ type: 'download', id: job.id, url, referer: job.pageUrl || undefined });
}

// ---------- public API ----------

/**
 * req: { item, variantUrl?, title?, pageUrl?, tabId? }
 * item.kind: 'file' | 'hls' | 'dash' | 'youtube' | 'page'
 */
export async function startJob(req) {
  const { item } = req;
  const engine = item.kind === 'file' ? 'file' : item.kind === 'hls' ? 'hls' : 'ytdlp';
  const job = await create({
    kind: engine,
    tabId: req.tabId ?? -1,
    title: req.title || 'video',
    pageUrl: req.pageUrl || '',
    sourceUrl: item.url,
    label: req.label || '',
  });
  try {
    if (engine === 'file') await startFile(job, item);
    else if (engine === 'hls') await startHls(job, item, req.variantUrl);
    else await startYtdlp(job, item.url); // youtube watch URL, or the page/frame URL for 'page' and 'dash'
  } catch (e) {
    await update(job.id, { status: 'error', error: String(e.message || e) }, true);
  }
  return job.id;
}

export async function cancelJob(id) {
  await load();
  const j = jobs.get(id);
  if (!j || !isActive(j)) return;
  if (j.kind === 'file' && j.downloadId != null) chrome.downloads.cancel(j.downloadId);
  else if (j.kind === 'hls') {
    if (j.downloadId != null) chrome.downloads.cancel(j.downloadId);
    else offscreenSend({ type: 'hls-cancel', id });
  } else if (j.kind === 'ytdlp' && port) port.postMessage({ type: 'cancel', id });
  else update(id, { status: 'cancelled' }, true);
}

export async function reveal(id) {
  await load();
  const j = jobs.get(id);
  if (!j) return;
  if (j.downloadId != null) chrome.downloads.show(j.downloadId);
  else if (j.filePath) {
    const p = connect();
    if (p) { p.postMessage({ type: 'reveal', filePath: j.filePath }); maybeCloseHelper(); }
  }
}
