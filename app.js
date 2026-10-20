/* html-mp4: rekam hasil render HTML (canvas) jadi MP4 (H.264 + AAC) di browser.
   Memakai WebCodecs + mp4-muxer, jadi header MP4 lengkap dan durasi terbaca benar di galeri. */

const $ = (id) => document.getElementById(id);
const el = {
  support: $('support'), htmlFile: $('htmlFile'), paste: $('htmlPaste'),
  btnLoad: $('btnLoad'), btnSample: $('btnSample'),
  stage: $('stage'), frame: $('frame'), pageInfo: $('pageInfo'),
  audioFile: $('audioFile'), audioInfo: $('audioInfo'),
  settings: $('settings'), res: $('res'), fps: $('fps'), quality: $('quality'),
  mode: $('mode'), fit: $('fit'), duration: $('duration'), useAudioDur: $('useAudioDur'),
  selector: $('selector'), estimate: $('estimate'),
  btnStart: $('btnStart'), btnCancel: $('btnCancel'), bar: $('bar'),
  status: $('status'), log: $('log'),
  result: $('result'), video: $('video'), resultInfo: $('resultInfo'),
  btnDownload: $('btnDownload'), btnShare: $('btnShare'),
};

let pageHtml = '';
let audioFile = null;
let pageAudioFile = null;
let audioDurationSec = 0;
let busy = false;
let cancelled = false;
let lastBlob = null;
let lastUrl = null;

/* ---------- util ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yieldNow = () => new Promise((r) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => r();
  ch.port2.postMessage(0);
});

function log(msg) {
  el.log.textContent += (el.log.textContent ? '\n' : '') + msg;
  el.log.scrollTop = el.log.scrollHeight;
}
function setStatus(msg, kind = '') {
  el.status.textContent = msg;
  el.status.className = kind;
}
function setProgress(p) {
  el.bar.style.width = Math.max(0, Math.min(1, p)) * 100 + '%';
}
function fmtTime(s) {
  if (!isFinite(s)) return '?';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}

/* ---------- muxer (CDN + cadangan lokal) ---------- */

let muxerModule = null;
async function loadMuxer() {
  if (muxerModule) return muxerModule;
  const sources = [
    './mp4-muxer.mjs',
    'https://cdn.jsdelivr.net/npm/mp4-muxer@5/build/mp4-muxer.mjs',
    'https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm',
    'https://unpkg.com/mp4-muxer@5/build/mp4-muxer.mjs',
  ];
  const errors = [];
  for (const src of sources) {
    try {
      const mod = await import(src);
      if (mod.Muxer && mod.ArrayBufferTarget) {
        muxerModule = mod;
        return mod;
      }
      errors.push(`${src}: ekspor tidak lengkap`);
    } catch (e) {
      errors.push(`${src}: ${e.message || e}`);
    }
  }
  throw new Error('Library mp4-muxer gagal dimuat. Cek koneksi internet, atau taruh file mp4-muxer.mjs di folder repo.\n' + errors.join('\n'));
}

/* ---------- pemilihan codec ---------- */

async function pickVideoConfig(W, H, fps, bitrate) {
  const codecs = ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a', 'avc1.640028', 'avc1.4d0028', 'avc1.42001f'];
  for (const codec of codecs) {
    const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try {
      const res = await VideoEncoder.isConfigSupported(cfg);
      if (res.supported) return res.config || cfg;
    } catch (_) { /* coba berikutnya */ }
  }
  return null;
}

async function pickAudioConfig(sampleRate) {
  if (!('AudioEncoder' in window)) return null;
  const options = [
    { codec: 'mp4a.40.2', muxCodec: 'aac' },
    { codec: 'opus', muxCodec: 'opus' },
  ];
  for (const o of options) {
    const cfg = { codec: o.codec, sampleRate, numberOfChannels: 2, bitrate: 128000 };
    try {
      const res = await AudioEncoder.isConfigSupported(cfg);
      if (res.supported) return { config: res.config || cfg, muxCodec: o.muxCodec };
    } catch (_) { /* coba berikutnya */ }
  }
  return null;
}

async function checkSupport() {
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) {
    el.support.className = 'badge bad';
    el.support.textContent = 'Browser ini belum mendukung WebCodecs. Pakai Chrome terbaru (Android atau desktop).';
    return;
  }
  const v = await pickVideoConfig(1280, 720, 30, 4e6);
  const a = await pickAudioConfig(48000);
  const lines = [];
  lines.push(v ? `Video H.264: didukung (${v.codec})` : 'Video H.264: TIDAK didukung');
  lines.push(a ? `Audio: ${a.muxCodec.toUpperCase()} didukung` : 'Audio: TIDAK bisa di-encode (video tetap bisa, tanpa audio)');
  el.support.textContent = lines.join('\n');
  el.support.className = 'badge ' + (v && a ? 'ok' : v ? 'warn' : 'bad');
  if (a && a.muxCodec === 'opus') {
    el.support.textContent += '\nCatatan: AAC tidak ada, audio memakai Opus (sebagian galeri/iPhone mungkin tidak memutarnya).';
    el.support.className = 'badge warn';
  }
}

/* ---------- pengaturan ---------- */

function readConfig() {
  const [W, H] = el.res.value.split('x').map(Number);
  const fps = Number(el.fps.value);
  const mbps720 = Number(el.quality.value);
  return {
    W, H, fps,
    bitrate: Math.round(mbps720 * 1e6 * (W * H) / (1280 * 720)),
    mode: el.mode.value,
    fit: el.fit.value,
    duration: Math.max(1, Math.min(1800, Number(el.duration.value) || 10)),
    useAudioDur: el.useAudioDur.checked,
    selector: el.selector.value.trim(),
  };
}

function updateEstimate() {
  const cfg = readConfig();
  const dur = cfg.useAudioDur && audioDurationSec ? audioDurationSec : cfg.duration;
  const mb = ((cfg.bitrate + 128000) * dur) / 8 / 1048576;
  const frames = Math.round(dur * cfg.fps);
  let t = `Perkiraan: ${frames} frame, ukuran sekitar ${mb.toFixed(mb < 10 ? 1 : 0)} MB.`;
  if (mb > 400) t += ' Cukup besar untuk memori HP, pertimbangkan kualitas Hemat atau durasi lebih pendek.';
  el.estimate.textContent = t;
}

function layoutStage() {
  const [W, H] = el.res.value.split('x').map(Number);
  el.stage.style.aspectRatio = `${W} / ${H}`;
  el.stage.style.maxWidth = H > W ? '320px' : '100%';
  el.frame.style.width = W + 'px';
  el.frame.style.height = H + 'px';
  const s = el.stage.clientWidth / W;
  el.frame.style.transform = `scale(${s})`;
}

function updateButtons() {
  el.btnStart.disabled = busy || !pageHtml;
  el.btnCancel.hidden = !busy;
  el.settings.disabled = busy;
  el.htmlFile.disabled = busy;
  el.audioFile.disabled = busy;
  el.btnLoad.disabled = busy;
  el.btnSample.disabled = busy;
}

/* ---------- halaman HTML ---------- */

/* Jam virtual: disisipkan sebelum skrip halaman. Saat mode frame demi frame aktif,
   audio.currentTime, performance.now, Date.now dan timestamp rAF dikendalikan perekam
   (window.__hm.t, dalam detik), jadi halaman yang bergantung waktu tetap mulus dan akurat.
   Animasi yang memakai setTimeout/setInterval belum ikut dikendalikan. */
function makePrelude(virtual) {
  return `<script>(function(){
var hm=window.__hm={t:${virtual ? 0 : 'null'}};
var MP=HTMLMediaElement.prototype,cd=Object.getOwnPropertyDescriptor(MP,'currentTime');
Object.defineProperty(MP,'currentTime',{configurable:true,
 get:function(){return hm.t===null?cd.get.call(this):hm.t},
 set:function(v){if(hm.t===null)cd.set.call(this,v)}});
if(hm.t!==null){MP.play=function(){return Promise.resolve()};}
var p0=performance.now.bind(performance),d0=Date.now.bind(Date),e0=d0();
performance.now=function(){return hm.t===null?p0():hm.t*1000};
Date.now=function(){return hm.t===null?d0():e0+hm.t*1000};
var raf=window.requestAnimationFrame.bind(window);
window.requestAnimationFrame=function(cb){return raf(function(){cb(performance.now())})};
})();<\/script>`;
}

function withPrelude(html, virtual) {
  const tag = makePrelude(virtual);
  const m = html.match(/<head[^>]*>/i) || html.match(/<html[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  return tag + html;
}

function reloadPage(virtual = false) {
  return new Promise((resolve) => {
    const done = () => { el.frame.removeEventListener('load', done); resolve(); };
    el.frame.addEventListener('load', done);
    el.frame.srcdoc = withPrelude(pageHtml, virtual) + `\n<!-- reload ${Date.now()} -->`;
  });
}

/* Tekan tombol "mulai" bawaan halaman (mis. overlay "Tap to start") kalau ada. */
function autoStartPage() {
  const doc = el.frame.contentDocument;
  if (!doc) return;
  try {
    let btn = doc.querySelector('#go, #start, #play, .start, [data-start]');
    if (!btn) {
      const all = [...doc.querySelectorAll('button')];
      if (all.length === 1) btn = all[0];
    }
    if (btn) btn.click();
  } catch (_) { /* abaikan */ }
}

/* Ambil audio yang tertanam di halaman (<audio src=...>) supaya ikut masuk ke MP4. */
async function grabPageAudio() {
  pageAudioFile = null;
  const doc = el.frame.contentDocument;
  if (!doc) return;
  const a = doc.querySelector('audio');
  const src = a && (a.currentSrc || a.src || (a.querySelector('source') || {}).src);
  if (!src) return;
  try {
    const r = await el.frame.contentWindow.fetch(src);
    const b = await r.blob();
    if (b.size) pageAudioFile = new File([b], 'audio-halaman', { type: b.type || 'audio/mpeg' });
  } catch (_) { pageAudioFile = null; }
}

const rafTwice = (win) => Promise.race([
  new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r))),
  sleep(500),
]);

async function waitForSource(selector) {
  const t0 = performance.now();
  while (performance.now() - t0 < 4000) {
    const doc = el.frame.contentDocument;
    if (doc) {
      let cand = null;
      if (selector) {
        try { cand = doc.querySelector(selector); } catch (_) { cand = null; }
      } else {
        let best = 0;
        doc.querySelectorAll('canvas,video').forEach((n) => {
          const area = (n.width || n.videoWidth || 0) * (n.height || n.videoHeight || 0);
          if (area > best) { best = area; cand = n; }
        });
      }
      if (cand) return cand;
    }
    await sleep(100);
  }
  return null;
}

async function loadPage(html) {
  pageHtml = html;
  layoutStage();
  el.pageInfo.textContent = 'Memuat halaman...';
  await reloadPage();
  const src = await waitForSource(el.selector.value.trim());
  const hook = typeof el.frame.contentWindow.renderFrame === 'function';
  await grabPageAudio();
  if (src) {
    const w = src.width || src.videoWidth;
    const h = src.height || src.videoHeight;
    el.pageInfo.textContent = `Canvas terdeteksi: ${w}x${h}. ` +
      (hook ? 'Fungsi renderFrame ada.' : 'Tanpa renderFrame, waktu halaman dikendalikan jam virtual.') +
      (pageAudioFile ? ' Audio halaman terdeteksi.' : '');
  } else {
    el.pageInfo.textContent = 'Canvas belum terdeteksi. Pastikan halaman memakai <canvas>, atau isi selector.';
  }
  refreshAudioInfo();
  updateButtons();
}

/* ---------- audio ---------- */

async function decodeAudio(file) {
  const data = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ sampleRate: 48000 }); } catch (_) { ctx = new AC(); }
  try {
    return await ctx.decodeAudioData(data);
  } finally {
    if (ctx.close) ctx.close();
  }
}

function makeAudioFeeder(buf, duration, muxer, config) {
  const sr = config.sampleRate;
  const total = Math.min(buf.length, Math.floor(duration * sr));
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const CH = 2048;
  let pos = 0;
  let err = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { err = e; },
  });
  enc.configure(config);

  const pushOne = () => {
    const n = Math.min(CH, total - pos);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(pos, pos + n), 0);
    data.set(R.subarray(pos, pos + n), n);
    const ad = new AudioData({
      format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round((pos / sr) * 1e6), data,
    });
    enc.encode(ad);
    ad.close();
    pos += n;
  };

  return {
    feedUntil(t) {
      if (err) throw err;
      const limit = Math.min(total, Math.floor(t * sr));
      while (pos < limit) pushOne();
    },
    async finish() {
      while (pos < total) {
        if (err) throw err;
        pushOne();
        if (enc.encodeQueueSize > 40) await sleep(5);
      }
      await enc.flush();
      if (err) throw err;
      enc.close();
    },
    close() { try { if (enc.state !== 'closed') enc.close(); } catch (_) { /* abaikan */ } },
  };
}

/* ---------- render ---------- */

async function startRender() {
  if (busy) return;
  if (!pageHtml) { setStatus('Muat halaman HTML dulu.', 'bad'); return; }
  if (!('VideoEncoder' in window)) { setStatus('Browser tidak mendukung WebCodecs.', 'bad'); return; }

  busy = true;
  cancelled = false;
  updateButtons();
  resetResult();
  el.log.textContent = '';
  setProgress(0);

  const cfg = readConfig();
  let wake = null;
  let venc = null;
  let audio = null;

  try {
    try { wake = await navigator.wakeLock?.request('screen'); } catch (_) { /* tidak wajib */ }

    setStatus('Menyiapkan encoder...');
    const { Muxer, ArrayBufferTarget } = await loadMuxer();

    const vsel = await pickVideoConfig(cfg.W, cfg.H, cfg.fps, cfg.bitrate);
    if (!vsel) throw new Error('H.264 pada resolusi ini tidak didukung browser. Coba 720p atau 30 fps.');
    log(`Video: ${vsel.codec}, ${(cfg.bitrate / 1e6).toFixed(1)} Mbps`);

    let abuf = null;
    let asel = null;
    const audioSrc = audioFile || pageAudioFile;
    if (audioSrc) {
      setStatus('Membaca audio...');
      abuf = await decodeAudio(audioSrc);
      asel = await pickAudioConfig(abuf.sampleRate);
      if (!asel) throw new Error('Browser tidak bisa meng-encode audio (AAC/Opus). Hapus audio lalu coba lagi.');
      log(`Audio: ${asel.muxCodec.toUpperCase()}, ${abuf.sampleRate} Hz, ${fmtTime(abuf.duration)}`);
    }
    let duration = cfg.duration;
    if (abuf && cfg.useAudioDur) duration = Math.min(abuf.duration, 1800);

    const mode = cfg.mode === 'realtime' ? 'realtime' : 'frame';
    setStatus('Memuat ulang halaman...');
    layoutStage();
    await reloadPage(mode === 'frame');
    const src = await waitForSource(cfg.selector);
    if (!src) throw new Error('Canvas tidak ditemukan di halaman. Pastikan ada <canvas>, atau isi selector.');
    const win = el.frame.contentWindow;
    const hasHook = typeof win.renderFrame === 'function';
    autoStartPage();
    await sleep(300);
    log(`Mode: ${mode === 'frame' ? 'frame demi frame (jam virtual)' : 'real-time'}, ${cfg.W}x${cfg.H} @ ${cfg.fps} fps, ${duration.toFixed(1)} detik`);

    const target = new ArrayBufferTarget();
    const muxerOpts = {
      target,
      video: { codec: 'avc', width: cfg.W, height: cfg.H, frameRate: cfg.fps },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    };
    if (asel) muxerOpts.audio = { codec: asel.muxCodec, numberOfChannels: 2, sampleRate: asel.config.sampleRate };
    const muxer = new Muxer(muxerOpts);

    let vErr = null;
    venc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { vErr = e; },
    });
    venc.configure(vsel);
    if (asel) audio = makeAudioFeeder(abuf, duration, muxer, asel.config);

    const out = document.createElement('canvas');
    out.width = cfg.W;
    out.height = cfg.H;
    const ctx = out.getContext('2d', { alpha: false });
    const frameDur = Math.round(1e6 / cfg.fps);
    let first = true;

    const pushFrame = (idx) => {
      const sw = src.width || src.videoWidth;
      const sh = src.height || src.videoHeight;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cfg.W, cfg.H);
      if (sw && sh) {
        let dw = cfg.W, dh = cfg.H;
        if (cfg.fit !== 'stretch') {
          const s = cfg.fit === 'cover' ? Math.max(cfg.W / sw, cfg.H / sh) : Math.min(cfg.W / sw, cfg.H / sh);
          dw = sw * s;
          dh = sh * s;
        }
        ctx.drawImage(src, (cfg.W - dw) / 2, (cfg.H - dh) / 2, dw, dh);
      }
      const frame = new VideoFrame(out, { timestamp: Math.round((idx * 1e6) / cfg.fps), duration: frameDur });
      venc.encode(frame, { keyFrame: first || idx % (cfg.fps * 2) === 0 });
      frame.close();
      first = false;
    };

    const checkAbort = () => {
      if (cancelled) throw new Error('Dibatalkan');
      if (vErr) throw vErr;
    };

    const probe = document.createElement('canvas');
    probe.width = probe.height = 16;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    let sig0 = null;
    let moved = false;
    const signature = () => {
      pctx.drawImage(out, 0, 0, 16, 16);
      const d = pctx.getImageData(0, 0, 16, 16).data;
      let s = 0;
      for (let k = 0; k < d.length; k++) s = (s * 31 + d[k]) | 0;
      return s;
    };

    setStatus('Merender...');
    let stillWarn = false;
    if (mode === 'frame') {
      const total = Math.round(duration * cfg.fps);
      for (let i = 0; i < total; i++) {
        checkAbort();
        win.__hm.t = i / cfg.fps;
        if (hasHook) win.renderFrame(i / cfg.fps, i, cfg.fps);
        else await rafTwice(win);
        if (audio) audio.feedUntil(i / cfg.fps + 0.5);
        pushFrame(i);
        if (i % 10 === 0) {
          const s = signature();
          if (sig0 === null) sig0 = s; else if (s !== sig0) moved = true;
        }
        while (venc.encodeQueueSize > 6) {
          await Promise.race([
            new Promise((r) => venc.addEventListener('dequeue', r, { once: true })),
            sleep(50),
          ]);
          checkAbort();
        }
        if (i % 4 === 0) {
          setProgress(i / total);
          setStatus(`Merender frame ${i + 1} / ${total}`);
          await yieldNow();
        }
      }
      stillWarn = !moved && total > 30;
    } else {
      await new Promise((resolve, reject) => {
        const t0 = performance.now();
        let last = -1;
        const step = () => {
          try {
            checkAbort();
            const elapsed = (performance.now() - t0) / 1000;
            if (elapsed >= duration) { resolve(); return; }
            const idx = Math.floor(elapsed * cfg.fps);
            if (idx > last && venc.encodeQueueSize < 10) {
              if (audio) audio.feedUntil(elapsed + 0.5);
              pushFrame(idx);
              last = idx;
            }
            setProgress(elapsed / duration);
            setStatus(`Merekam ${elapsed.toFixed(1)} / ${duration.toFixed(1)} detik`);
            requestAnimationFrame(step);
          } catch (e) { reject(e); }
        };
        requestAnimationFrame(step);
      });
    }

    setStatus('Menyelesaikan file...');
    setProgress(1);
    await venc.flush();
    if (vErr) throw vErr;
    if (audio) await audio.finish();
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    showResult(blob, cfg, asel);
    if (stillWarn) {
      setStatus('Selesai, tetapi gambar tampak tidak bergerak. Coba mode Real-time.', 'bad');
      log('Peringatan: gambar tidak berubah selama render. Halaman mungkin memakai setTimeout/klik untuk animasi, atau butuh tombol mulai.');
    } else {
      setStatus('Selesai. Video siap diunduh.', 'ok');
    }
  } catch (e) {
    if (e && e.message === 'Dibatalkan') {
      setStatus('Dibatalkan.');
    } else {
      setStatus('Gagal: ' + (e && e.message ? e.message.split('\n')[0] : e), 'bad');
      log(String(e && e.message ? e.message : e));
    }
  } finally {
    try { if (venc && venc.state !== 'closed') venc.close(); } catch (_) { /* abaikan */ }
    if (audio) audio.close();
    try { if (wake) await wake.release(); } catch (_) { /* abaikan */ }
    busy = false;
    updateButtons();
  }
}

/* ---------- hasil ---------- */

function resetResult() {
  el.result.hidden = true;
  el.video.removeAttribute('src');
  el.video.load();
  if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  lastBlob = null;
}

function showResult(blob, cfg, asel) {
  lastBlob = blob;
  lastUrl = URL.createObjectURL(blob);
  const name = `html-mp4-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`;
  const mb = (blob.size / 1048576).toFixed(1);
  el.result.hidden = false;
  el.resultInfo.textContent = `Ukuran ${mb} MB. Membaca durasi...`;
  el.video.onloadedmetadata = () => {
    el.resultInfo.textContent =
      `Durasi terbaca ${fmtTime(el.video.duration)} | ${cfg.W}x${cfg.H} | ${mb} MB | audio: ${asel ? asel.muxCodec.toUpperCase() : 'tidak ada'}`;
  };
  el.video.src = lastUrl;
  el.btnDownload.href = lastUrl;
  el.btnDownload.download = name;
  const file = new File([blob], name, { type: 'video/mp4' });
  el.btnShare.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  el.btnShare.onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- event ---------- */

el.htmlFile.addEventListener('change', async () => {
  const f = el.htmlFile.files[0];
  if (!f) return;
  const text = await f.text();
  el.paste.value = text;
  await loadPage(text);
});

el.btnLoad.addEventListener('click', async () => {
  const text = el.paste.value.trim();
  if (!text) { el.pageInfo.textContent = 'Kolom kode masih kosong.'; return; }
  await loadPage(text);
});

el.btnSample.addEventListener('click', async () => {
  try {
    const res = await fetch('./sample.html', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    el.paste.value = text;
    await loadPage(text);
  } catch (e) {
    el.pageInfo.textContent = 'Gagal memuat contoh: ' + e.message;
  }
});

/* Audio yang dipakai: file pilihan pengguna, kalau kosong pakai audio tertanam di halaman. */
function refreshAudioInfo() {
  const f = audioFile || pageAudioFile;
  const own = !!audioFile;
  audioDurationSec = 0;
  el.useAudioDur.disabled = true;
  if (!f) {
    el.useAudioDur.checked = false;
    el.audioInfo.textContent = 'Tanpa audio, video akan senyap.';
    updateEstimate();
    return;
  }
  const label = own ? f.name : 'audio bawaan halaman (otomatis dipakai)';
  el.audioInfo.textContent = `${label}: membaca durasi...`;
  const url = URL.createObjectURL(f);
  const a = new Audio();
  a.preload = 'metadata';
  a.onloadedmetadata = () => {
    audioDurationSec = a.duration || 0;
    el.audioInfo.textContent = `${label} (${fmtTime(audioDurationSec)})`;
    el.useAudioDur.disabled = !audioDurationSec;
    if (!own && audioDurationSec) el.useAudioDur.checked = true;
    URL.revokeObjectURL(url);
    updateEstimate();
  };
  a.onerror = () => {
    el.audioInfo.textContent = `${label} (durasi tidak terbaca, akan dicoba saat render)`;
    URL.revokeObjectURL(url);
  };
  a.src = url;
}

el.audioFile.addEventListener('change', () => {
  audioFile = el.audioFile.files[0] || null;
  el.useAudioDur.checked = false;
  refreshAudioInfo();
});

['fps', 'quality', 'duration', 'useAudioDur'].forEach((id) => el[id].addEventListener('input', updateEstimate));
el.res.addEventListener('change', async () => {
  updateEstimate();
  layoutStage();
  if (pageHtml) await loadPage(pageHtml);
});
window.addEventListener('resize', layoutStage);

el.btnStart.addEventListener('click', startRender);
el.btnCancel.addEventListener('click', () => { cancelled = true; setStatus('Membatalkan...'); });

layoutStage();
updateEstimate();
updateButtons();
checkSupport();
