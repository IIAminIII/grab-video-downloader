// Grab helper – Chrome native messaging host that runs yt-dlp for the extension.
// Protocol: each message is a 4-byte little-endian length followed by UTF-8 JSON (stdin/stdout).

'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.0.0';
const DEFAULT_DIR = path.join(os.homedir(), 'Downloads');

// ---------- messaging ----------

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    handle(msg).catch(e => send({ type: 'error', id: msg.id, error: String(e.message || e) }));
  }
});
process.stdin.on('end', () => {
  // Chrome closed the port. Let running downloads finish, then exit.
  stdinClosed = true;
  if (!jobs.size) process.exit(0);
});
let stdinClosed = false;

// ---------- locating tools ----------

function which(name) {
  const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
  const first = (r.stdout || '').split(/\r?\n/).find(Boolean);
  return first && fs.existsSync(first) ? first : null;
}

function findIn(dir, file, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === file) return path.join(dir, e.name);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findIn(path.join(dir, e.name), file, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function locate(exe, pkgPrefix) {
  const fromPath = which(exe);
  if (fromPath) return fromPath;
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet');
  const link = path.join(winget, 'Links', exe);
  if (fs.existsSync(link)) return link;
  const pkgs = path.join(winget, 'Packages');
  if (fs.existsSync(pkgs)) {
    for (const d of fs.readdirSync(pkgs)) {
      if (!d.toLowerCase().startsWith(pkgPrefix)) continue;
      const hit = findIn(path.join(pkgs, d), exe);
      if (hit) return hit;
    }
  }
  return null;
}

let tools = null;
function getTools() {
  if (!tools) tools = { ytdlp: locate('yt-dlp.exe', 'yt-dlp.yt-dlp'), ffmpeg: locate('ffmpeg.exe', 'gyan.ffmpeg') };
  return tools;
}

// ---------- jobs ----------

const jobs = new Map(); // id -> child process

function num(s) { const n = Number(s); return Number.isFinite(n) ? n : null; }

/** Normalized http(s) URL, or null. A normalized URL always starts with "http", never with "-". */
function httpUrl(u) {
  try {
    const x = new URL(String(u));
    return /^https?:$/.test(x.protocol) ? x.href : null;
  } catch { return null; }
}

/** File-name-safe title. "%" is dropped because the name becomes a yt-dlp output template. */
function cleanTitle(t) {
  return String(t || '')
    .replace(/[\\/:*?"<>|%\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .slice(0, 120) || 'video';
}

/** First "<base>", "<base> (1)", ... for which no .mp4 exists yet. */
function freeBase(dir, base) {
  for (let i = 0; i < 1000; i++) {
    const name = i ? `${base} (${i})` : base;
    if (!fs.existsSync(path.join(dir, `${name}.mp4`))) return name;
  }
  return `${base} ${Date.now()}`;
}

/** Remove yt-dlp's leftovers (.part, .ytdl, fragments) after a failed or cancelled stream download. */
function cleanPartials(dir, base) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(base + '.')) continue;
      if (/\.(part|ytdl)$/.test(f) || /\.part-Frag\d+/.test(f) || /\.f[\w-]+\.\w+$/.test(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
}

/**
 * msg: { id, url, referer?, mode?, title?, height?, userAgent? }
 * mode 'stream': url is an HLS playlist found by the extension; saved as "<title>.mp4".
 * Every field arrives from the browser, so each one is validated before it reaches the command line.
 */
function download(msg) {
  const { id } = msg;
  const { ytdlp, ffmpeg } = getTools();
  if (!ytdlp) return send({ type: 'error', id, error: 'yt-dlp not found. Install it with: winget install yt-dlp.yt-dlp' });

  const url = httpUrl(msg.url);
  if (!url) return send({ type: 'error', id, error: 'Not a downloadable web address' });
  const page = httpUrl(msg.referer);
  const stream = msg.mode === 'stream';
  const maxHeight = Number.isInteger(msg.height) && msg.height > 0 && msg.height < 20000 ? msg.height : null;
  const userAgent = typeof msg.userAgent === 'string' && /^[\x20-\x7e]{1,300}$/.test(msg.userAgent) ? msg.userAgent : null;

  const outDir = process.env.GRAB_DOWNLOAD_DIR || DEFAULT_DIR; // env override is for tests only
  const base = stream ? freeBase(outDir, cleanTitle(msg.title)) : null;

  const args = [
    '--newline', '--no-colors', '--no-playlist', '--quiet', '--progress',
    '-f', 'bv*+ba/b',
    // best resolution (capped at the chosen quality for streams); prefer H.264/AAC, which plays everywhere
    '-S', `${maxHeight ? `res:${maxHeight}` : 'res'},vcodec:h264,acodec:m4a`,
    '--merge-output-format', 'mp4',
    '-P', outDir,
    '-o', stream ? `${base}.%(ext)s` : '%(title).150B [%(id)s].%(ext)s',
    '--js-runtimes', `node:${process.execPath}`,
    '--progress-template', 'download:GRABPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
    '--print', 'before_dl:GRABINFO %(format_id)s|%(height)s|%(title)s',
    '--print', 'after_move:GRABFILE %(filepath)s',
  ];
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));
  if (page) {
    // like a browser: full page URL to the page's own host, only the origin to other hosts
    const p = new URL(page);
    args.push('--referer', new URL(url).hostname === p.hostname ? page : p.origin + '/');
    if (stream) args.push('--add-headers', `Origin:${p.origin}`);
  }
  if (stream) {
    args.push('--concurrent-fragments', '4', '--remux-video', 'mp4');
    if (userAgent) args.push('--user-agent', userAgent);
  }
  args.push('--', url); // "--" ends option parsing: the URL can never be read as an option

  const child = spawn(ytdlp, args, {
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  jobs.set(id, child);

  let parts = 1, part = 0, lastDone = 0, filePath = null, title = null, height = null;
  const errLines = [];
  let lastSent = 0;

  const onLine = line => {
    if (line.startsWith('GRABINFO ')) {
      const [fmt, h, ...t] = line.slice(9).split('|');
      parts = fmt.split('+').length;
      height = num(h);
      title = stream ? base : t.join('|'); // a raw playlist has no real title; keep the page's
      send({ type: 'info', id, title, height, parts });
    } else if (line.startsWith('GRABPROG ')) {
      const [done, total, est, speed, eta] = line.slice(9).split(' ').map(num);
      if (done === null) return;
      if (done < lastDone * 0.5 && part < parts - 1) part++; // next stream (video -> audio) started
      lastDone = done;
      const size = total || est;
      const frac = size ? Math.min(1, done / size) : 0;
      const overall = (part + frac) / parts;
      const now = Date.now();
      if (now - lastSent > 250 || frac >= 1) {
        lastSent = now;
        send({ type: 'progress', id, progress: overall, bytes: done, total: size, speed, eta,
               stage: overall >= 0.999 ? 'merging' : 'downloading' });
      }
    } else if (line.startsWith('GRABFILE ')) {
      filePath = line.slice(9).trim();
    }
  };

  let outBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    outBuf += d;
    let i;
    while ((i = outBuf.search(/\r?\n/)) >= 0) {
      onLine(outBuf.slice(0, i).trim());
      outBuf = outBuf.slice(outBuf[i] === '\r' ? i + 2 : i + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => {
    for (const l of d.split(/\r?\n/)) if (l.trim()) { errLines.push(l.trim()); if (errLines.length > 30) errLines.shift(); }
  });

  child.on('close', code => {
    jobs.delete(id);
    const ok = code === 0 && filePath;
    if (stream && !ok) cleanPartials(outDir, base);
    if (child.cancelled) send({ type: 'cancelled', id });
    else if (ok) send({ type: 'done', id, filePath, title, height });
    else {
      const err = [...errLines].reverse().find(l => l.startsWith('ERROR')) || errLines.at(-1) || `yt-dlp exited with code ${code}`;
      send({ type: 'error', id, error: err.replace(/^ERROR:\s*/, '') });
    }
    if (stdinClosed && !jobs.size) process.exit(0);
  });
  child.on('error', e => {
    jobs.delete(id);
    send({ type: 'error', id, error: e.message });
  });
}

function cancel({ id }) {
  const child = jobs.get(id);
  if (!child) return;
  child.cancelled = true;
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); // also kills ffmpeg
}

function reveal({ filePath }) {
  if (!filePath || !fs.existsSync(filePath)) return;
  spawn('explorer.exe', [`/select,"${filePath}"`], { windowsVerbatimArguments: true, detached: true }).unref();
}

async function handle(msg) {
  switch (msg.type) {
    case 'hello': {
      const t = getTools();
      return send({ type: 'hello', version: VERSION, ytdlp: !!t.ytdlp, ffmpeg: !!t.ffmpeg, dir: DEFAULT_DIR });
    }
    case 'download': return download(msg);
    case 'cancel': return cancel(msg);
    case 'reveal': return reveal(msg);
  }
}
