# Grab – Video Downloader (Chrome / Edge extension)

Hover any video, click **Download**. Handles direct files, HLS (`.m3u8`) streams, and,
through a small local helper running yt-dlp, YouTube and 1000+ other sites.

## Install
1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this folder.
   (If an older Grab is loaded, remove it first: the extension ID is now fixed.)
2. One-time helper setup (for YouTube and other sites). Needs Node.js, yt-dlp and ffmpeg:
   ```powershell
   winget install yt-dlp.yt-dlp
   winget install Gyan.FFmpeg
   powershell -ExecutionPolicy Bypass -File native-host\install.ps1
   ```
   Remove it any time with `native-host\uninstall.ps1`.

## Use
- **Floating button:** hover a video (or just press play) and click **Download**. With one option it starts
  right away. Otherwise pick a quality. The button shows progress, then **Saved**.
- **Popup:** the toolbar icon lists what was found on the page, plus live **Downloads** with
  Cancel / Show in folder. **Download this page with yt-dlp** is the catch-all for anything else.
- Files go to your normal Downloads folder. YouTube saves as H.264/AAC MP4, which plays everywhere.
  You get a notification when a yt-dlp download finishes. Click it to open the folder.

## How it works
| File | Role |
|---|---|
| `background.js` | Watches network responses, keeps the media list per tab, routes requests |
| `jobs.js` | Download manager: one job per download, progress, cancel, notifications |
| `content.js` | Floating button + quality menu over videos (all frames, shadow DOM) |
| `offscreen.html/js` | Hidden page that downloads, decrypts (AES-128) and merges HLS streams |
| `hls.js` | Playlist parser + segment downloader |
| `popup.html/css/js` | Toolbar popup |
| `native-host/` | Helper that runs yt-dlp (Chrome native messaging) + install scripts |

Downloads send the page's Referer/Origin (via declarativeNetRequest), so most CDNs that block
"hotlinked" segment requests still work.

## Limits
- DRM-protected streams (Netflix etc.) cannot be downloaded.
- HLS streams are held in memory until saved. Very long videos use a lot of RAM.
- Only download content you have the right to download.

## Debugging
`chrome://extensions` → Grab → **service worker** opens the background console.
After editing files, press the reload ↻ button on the extension card, then reload the web page.
