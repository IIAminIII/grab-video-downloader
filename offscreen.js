// Grab – hidden offscreen document. Downloads + merges HLS streams so no tab needs to stay open.
// Only chrome.runtime is available here; everything else goes through the background worker.

import { loadMediaPlaylist, downloadHls } from './hls.js';

const running = new Map(); // job id -> AbortController
const blobs = new Map();   // job id -> object URL

const post = msg => chrome.runtime.sendMessage(msg).catch(() => {});
const hostOf = u => { try { return new URL(u).hostname; } catch { return null; } };

/** Ask the background to send the page's Referer/Origin with our requests to these hosts. */
function setReferer(id, ref, urls) {
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
  return chrome.runtime.sendMessage({ type: 'hls-rule', id, ref, hosts }).catch(() => {});
}

async function start({ id, src, variant, ref }) {
  const ac = new AbortController();
  running.set(id, ac);
  try {
    await setReferer(id, ref, [src, variant].filter(Boolean));
    const { playlist, variant: chosen } = await loadMediaPlaylist(src, { variantUrl: variant, signal: ac.signal });
    if (playlist.encryption === 'drm') throw new Error('This stream is DRM-protected and cannot be downloaded.');

    const urls = [src, chosen?.url, playlist.map?.url, ...playlist.segments.map(s => s.url), ...playlist.segments.map(s => s.key?.uri)];
    await setReferer(id, ref, urls.filter(Boolean));

    post({ type: 'hls-info', id, height: chosen?.height || null, segments: playlist.segments.length, live: playlist.live });

    const t0 = performance.now();
    const { blob, ext } = await downloadHls(playlist, {
      signal: ac.signal,
      onProgress: ({ done, total, bytes }) => {
        const secs = (performance.now() - t0) / 1000;
        post({ type: 'hls-progress', id, progress: done / total, bytes, speed: secs > 0.5 ? bytes / secs : null });
      },
    });
    const url = URL.createObjectURL(blob);
    blobs.set(id, url);
    post({ type: 'hls-ready', id, blobUrl: url, ext, size: blob.size });
  } catch (e) {
    post(e.name === 'AbortError' ? { type: 'hls-cancelled', id } : { type: 'hls-error', id, error: String(e.message || e) });
  } finally {
    running.delete(id);
  }
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'hls-start') start(msg);
  else if (msg.type === 'hls-cancel') running.get(msg.id)?.abort();
  else if (msg.type === 'hls-revoke') {
    const u = blobs.get(msg.id);
    if (u) { URL.revokeObjectURL(u); blobs.delete(msg.id); }
  }
});
