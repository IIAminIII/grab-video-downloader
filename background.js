// Grab – background service worker.
// Watches network responses, records media per tab, updates the badge,
// and routes download requests to the job manager (jobs.js).

import { parsePlaylist } from './hls.js';
import { startJob, cancelJob, reveal, listJobs, clearFinished, helperStatus, handleOffscreen } from './jobs.js';

const MIN_FILE_SIZE = 200 * 1024; // ignore direct files smaller than 200 KB (ads, previews)

const PLAYLIST_RE = /\.(m3u8)(\?|#|$)/i;
const DASH_RE = /\.(mpd)(\?|#|$)/i;
const FILE_RE = /\.(mp4|webm|mkv|mov|m4v|flv|mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i;
const SEGMENT_RE = /\.(ts|m4s|m4f|cmfv|cmfa)(\?|#|$)/i;
const HLS_CT_RE = /mpegurl/i;
const DASH_CT_RE = /dash\+xml/i;
const MEDIA_CT_RE = /^(video|audio)\//i;
const YT_EMBED_RE = /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/i;

function addItem(tabId, item) {
  return updateTab(tabId, data => {
    if (data.items.some(x => x.url === item.url)) return false;
    data.items.push(item);
    return true;
  });
}

// ---------- per-tab storage (survives service-worker restarts) ----------

const keyFor = tabId => `tab_${tabId}`;
let chain = Promise.resolve();

/** Serialize read-modify-write so concurrent requests don't clobber each other. */
function updateTab(tabId, fn) {
  chain = chain.then(async () => {
    const key = keyFor(tabId);
    const data = (await chrome.storage.session.get(key))[key] || { items: [], hidden: [] };
    const changed = fn(data);
    if (changed === false) return;
    await chrome.storage.session.set({ [key]: data });
    const n = visibleItems(data).length;
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  }).catch(e => console.warn('updateTab', e));
  return chain;
}

function visibleItems(data) {
  const hidden = new Set(data.hidden);
  return data.items.filter(it => !hidden.has(it.url));
}

/** Queued on the same chain as updates, so a page-load reset can't wipe items added after it. */
function clearTab(tabId) {
  chain = chain.then(async () => {
    await chrome.storage.session.remove(keyFor(tabId));
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }).catch(() => {});
  return chain;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
});

chrome.tabs.onRemoved.addListener(tabId => {
  clearTab(tabId);
});

// ---------- detection ----------

function header(details, name) {
  const h = details.responseHeaders?.find(x => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

/** Total size: from Content-Range ("bytes 0-1/12345") on 206s, else Content-Length. */
function totalSize(details) {
  const cr = header(details, 'content-range');
  const m = cr && cr.match(/\/(\d+)\s*$/);
  if (m) return parseInt(m[1], 10);
  const cl = parseInt(header(details, 'content-length'), 10);
  return Number.isFinite(cl) ? cl : 0;
}

function classify(details) {
  const url = details.url;
  const ct = header(details, 'content-type').toLowerCase();
  if (SEGMENT_RE.test(url) || ct.includes('mp2t')) return null;
  if (PLAYLIST_RE.test(url) || HLS_CT_RE.test(ct)) return 'hls';
  if (DASH_RE.test(url) || DASH_CT_RE.test(ct)) return 'dash';
  if (MEDIA_CT_RE.test(ct) || FILE_RE.test(url)) return 'file';
  return null;
}

function extFrom(url, ct) {
  const m = url.match(FILE_RE);
  if (m) return m[1].toLowerCase();
  const sub = (ct.split('/')[1] || '').split(';')[0].trim();
  return { mpeg: 'mp3', 'x-matroska': 'mkv', quicktime: 'mov', 'x-flv': 'flv' }[sub] || sub || 'mp4';
}

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    const { tabId, url } = details;
    if (tabId < 0) return; // background fetches, other extensions, etc.
    if (details.initiator?.startsWith('chrome-extension://')) return; // our downloader tab

    if (details.type === 'main_frame') { // new page loaded in this tab -> reset list
      clearTab(tabId);
      return;
    }
    if (details.statusCode >= 400) return;
    if (!/^https?:/i.test(url)) return;

    if (details.type === 'sub_frame') { // embedded YouTube player?
      const yt = url.match(YT_EMBED_RE);
      if (yt) addItem(tabId, { url: `https://www.youtube.com/watch?v=${yt[1]}`, kind: 'youtube', videoId: yt[1], time: Date.now() });
      return;
    }

    const kind = classify(details);
    if (!kind) return;

    const ct = header(details, 'content-type').toLowerCase();
    const size = totalSize(details);
    if (kind === 'file' && size && size < MIN_FILE_SIZE) return;

    const item = {
      url,
      kind,                    // 'file' | 'hls' | 'dash'
      mime: ct.split(';')[0],
      ext: kind === 'file' ? extFrom(url, ct) : kind === 'hls' ? 'm3u8' : 'mpd',
      size,
      time: Date.now(),
    };

    let isNew = false;
    updateTab(tabId, data => {
      const existing = data.items.find(x => x.url === url);
      if (existing) {
        if (size > (existing.size || 0)) { existing.size = size; return true; }
        return false;
      }
      data.items.push(item);
      isNew = true;
      return true;
    }).then(() => {
      if (isNew && kind === 'hls') inspectPlaylist(tabId, url);
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

/** Fetch an HLS playlist once to learn qualities/duration and hide duplicate variant entries. */
async function inspectPlaylist(tabId, url) {
  let info;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return;
    const pl = parsePlaylist(await res.text(), res.url || url);
    if (pl.type === 'master') {
      info = {
        master: true,
        variants: pl.variants.map(v => ({ url: v.url, resolution: v.resolution, height: v.height, bandwidth: v.bandwidth })),
      };
    } else {
      info = { master: false, duration: pl.duration, encryption: pl.encryption, live: pl.live, fmp4: !!pl.map, segments: pl.segments.length };
    }
  } catch {
    return; // server may need the page's Referer; the offscreen downloader still tries with it
  }
  updateTab(tabId, data => {
    const it = data.items.find(x => x.url === url);
    if (!it) return false;
    it.hls = info;
    if (info.master) {
      // the per-quality playlists are already represented by the master's quality picker
      for (const v of info.variants) if (!data.hidden.includes(v.url)) data.hidden.push(v.url);
    }
    return true;
  });
}

// ---------- messages from popup / floating button / offscreen ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target === 'offscreen' || msg.type === 'job') return false;

  if (msg.type.startsWith('hls-')) {
    handleOffscreen(msg).then(() => reply({ ok: true }), e => reply({ ok: false, error: String(e) }));
    return true;
  }

  (async () => {
    const tabId = msg.tabId ?? sender.tab?.id;
    switch (msg.type) {
      case 'list': {
        const key = keyFor(tabId);
        const data = (await chrome.storage.session.get(key))[key] || { items: [], hidden: [] };
        return reply({ items: visibleItems(data).sort((a, b) => b.time - a.time) });
      }
      case 'clear':
        await clearTab(tabId);
        return reply({ ok: true });
      case 'start': {
        const tab = sender.tab || (tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null);
        const id = await startJob({
          item: msg.item,
          variantUrl: msg.variantUrl,
          label: msg.label,
          tabId: tab?.id ?? -1,
          title: msg.title || tab?.title,
          pageUrl: msg.pageUrl || tab?.url,
        });
        return reply({ ok: true, id });
      }
      case 'jobs': return reply({ jobs: await listJobs() });
      case 'cancel': await cancelJob(msg.id); return reply({ ok: true });
      case 'reveal': await reveal(msg.id); return reply({ ok: true });
      case 'clearJobs': await clearFinished(); return reply({ ok: true });
      case 'helper': return reply(await helperStatus());
      default: return reply({ ok: false, error: 'unknown message' });
    }
  })().catch(e => reply({ ok: false, error: String(e.message || e) }));
  return true; // async reply
});
