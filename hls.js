// HLS (.m3u8) playlist parsing + segment downloading/merging.
// Pure ES module: no chrome.* calls, so it can be unit-tested in Node.

/** Parse `KEY=value,KEY2="quoted, value"` attribute lists. */
export function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function resolve(uri, base) {
  try { return new URL(uri, base).href; } catch { return uri; }
}

/** "1000@200" -> { length: 1000, offset: 200 }. Offset defaults to end of previous range. */
function parseByteRange(str, prevEnd) {
  const [len, off] = str.split('@');
  const length = parseInt(len, 10);
  const offset = off !== undefined ? parseInt(off, 10) : prevEnd;
  return { length, offset };
}

/**
 * Parse a playlist.
 * Returns either
 *   { type: 'master', variants: [{ url, bandwidth, resolution, height, codecs }] }  (best first)
 * or
 *   { type: 'media', segments: [...], map, duration, encryption, live }
 * encryption: 'none' | 'aes-128' | 'drm'
 */
export function parsePlaylist(text, baseUrl) {
  if (!text || !text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('Not an HLS playlist');
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = parseAttrs(lines[i].slice(18));
      // next non-tag line is the URI
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) break;
      const res = a.RESOLUTION || '';
      variants.push({
        url: resolve(lines[j], baseUrl),
        bandwidth: parseInt(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || '0', 10),
        resolution: res,
        height: parseInt(res.split('x')[1] || '0', 10),
        codecs: a.CODECS || '',
      });
      i = j;
    }
    variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
    return { type: 'master', variants };
  }

  const segments = [];
  let seq = 0;
  let key = null;          // { method, uri, iv }
  let map = null;          // { url, byteRange }
  let encryption = 'none';
  let pendingDur = 0;
  let pendingRange = null;
  let prevRangeEnd = 0;
  let live = true;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = parseInt(line.slice(22), 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      const fmt = (a.KEYFORMAT || 'identity').toLowerCase();
      if (method === 'NONE') {
        key = null;
      } else if (method === 'AES-128' && fmt === 'identity') {
        key = { method, uri: resolve(a.URI, baseUrl), iv: a.IV || null };
        if (encryption === 'none') encryption = 'aes-128';
      } else {
        encryption = 'drm'; // SAMPLE-AES, FairPlay, Widevine, PlayReady...
        key = { method, uri: a.URI, iv: a.IV || null };
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      map = { url: resolve(a.URI, baseUrl), byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17), prevRangeEnd);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      live = false;
    } else if (!line.startsWith('#')) {
      segments.push({
        url: resolve(line, baseUrl),
        duration: pendingDur,
        seq,
        key,
        byteRange: pendingRange,
      });
      if (pendingRange) prevRangeEnd = pendingRange.offset + pendingRange.length;
      seq++;
      pendingDur = 0;
      pendingRange = null;
    }
  }

  const duration = segments.reduce((s, x) => s + x.duration, 0);
  return { type: 'media', segments, map, duration, encryption, live };
}

/** 16-byte IV: explicit hex IV, or the media sequence number big-endian (per the HLS spec). */
export function ivFor(segment) {
  const iv = new Uint8Array(16);
  if (segment.key && segment.key.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    let n = segment.seq;
    for (let i = 15; i >= 0 && n > 0; i--) { iv[i] = n & 0xff; n = Math.floor(n / 256); }
  }
  return iv;
}

async function fetchBytes(url, byteRange, signal) {
  const headers = {};
  if (byteRange) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  const res = await fetch(url, { headers, signal, credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchText(url, signal) {
  const res = await fetch(url, { signal, credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), finalUrl: res.url || url };
}

async function withRetry(fn, tries = 4, signal) {
  let err;
  for (let i = 0; i < tries; i++) {
    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    try { return await fn(); } catch (e) {
      if (e.name === 'AbortError') throw e;
      err = e;
      await new Promise(r => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw err;
}

/**
 * Resolve a playlist URL down to a media playlist (picking a variant from a master).
 * variantUrl: optional explicit variant to use.
 */
export async function loadMediaPlaylist(url, { variantUrl = null, signal } = {}) {
  let { text, finalUrl } = await fetchText(url, signal);
  let pl = parsePlaylist(text, finalUrl);
  let chosen = null;
  if (pl.type === 'master') {
    if (!pl.variants.length) throw new Error('Master playlist has no variants');
    chosen = pl.variants.find(v => v.url === variantUrl) || pl.variants[0];
    ({ text, finalUrl } = await fetchText(chosen.url, signal));
    pl = parsePlaylist(text, finalUrl);
    if (pl.type !== 'media') throw new Error('Unexpected nested master playlist');
  }
  return { playlist: pl, variant: chosen };
}

/**
 * Download every segment and return a Blob of the merged stream.
 * onProgress({ done, total, bytes })
 */
export async function downloadHls(playlist, { concurrency = 6, signal, onProgress } = {}) {
  if (playlist.encryption === 'drm') throw new Error('This stream is DRM-protected and cannot be downloaded.');
  const segs = playlist.segments;
  if (!segs.length) throw new Error('Playlist has no segments');

  const keyCache = new Map();
  async function getKey(uri) {
    if (!keyCache.has(uri)) {
      keyCache.set(uri, (async () => {
        const raw = await withRetry(() => fetchBytes(uri, null, signal), 4, signal);
        return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      })());
    }
    return keyCache.get(uri);
  }

  const parts = new Array(segs.length);
  let done = 0, bytes = 0, next = 0;

  async function worker() {
    while (next < segs.length) {
      const i = next++;
      const s = segs[i];
      let data = await withRetry(() => fetchBytes(s.url, s.byteRange, signal), 4, signal);
      if (s.key && s.key.method === 'AES-128') {
        const k = await getKey(s.key.uri);
        data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(s) }, k, data));
      }
      parts[i] = data;
      done++;
      bytes += data.byteLength;
      onProgress && onProgress({ done, total: segs.length, bytes });
    }
  }

  const init = playlist.map
    ? await withRetry(() => fetchBytes(playlist.map.url, playlist.map.byteRange, signal), 4, signal)
    : null;

  await Promise.all(Array.from({ length: Math.min(concurrency, segs.length) }, worker));

  const isFmp4 = !!playlist.map;
  const blobParts = init ? [init, ...parts] : parts;
  return {
    blob: new Blob(blobParts, { type: isFmp4 ? 'video/mp4' : 'video/mp2t' }),
    ext: isFmp4 ? 'mp4' : 'ts',
  };
}
