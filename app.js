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
let audioToken = 0;
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

function fmtEta(s) {
  if (!isFinite(s)) return '?';
  s = Math.round(s);
  if (s < 60) return `${s} dtk`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt ${s % 60} dtk`;
  return `${Math.floor(m / 60)} jam ${m % 60} mnt`;
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
  const rec = pickRecorderMime();
  const recLine = !rec ? 'Mode Cepat (MediaRecorder): TIDAK didukung'
    : rec.startsWith('video/mp4') ? 'Mode Cepat: MP4 didukung'
    : 'Mode Cepat: hanya WebM (Otomatis memakai mode Presisi)';
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) {
    el.support.className = 'badge ' + (rec.startsWith('video/mp4') ? 'warn' : 'bad');
    el.support.textContent = 'Mode Presisi (WebCodecs): tidak didukung browser ini. Pakai Chrome terbaru.\n' + recLine;
    return;
  }
  const v = await pickVideoConfig(1280, 720, 30, 4e6);
  const a = await pickAudioConfig(48000);
  const lines = [];
  lines.push(v ? `Video H.264: didukung (${v.codec})` : 'Video H.264: TIDAK didukung');
  lines.push(a ? `Audio: ${a.muxCodec.toUpperCase()} didukung` : 'Audio: TIDAK bisa di-encode (video tetap bisa, tanpa audio)');
  lines.push(recLine);
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

  const cfg = readConfig();
  const recMime = pickRecorderMime();
  const useFast = cfg.mode === 'fast' || (cfg.mode === 'auto' && recMime.startsWith('video/mp4'));
  if (useFast && !recMime) { setStatus('Browser tidak mendukung perekaman cepat (MediaRecorder). Pakai mode Presisi.', 'bad'); return; }
  if (!useFast && !('VideoEncoder' in window)) { setStatus('Browser tidak mendukung WebCodecs. Pakai mode Cepat.', 'bad'); return; }

  busy = true;
  cancelled = false;
  updateButtons();
  resetResult();
  el.log.textContent = '';
  setProgress(0);

  let wake = null;
  let venc = null;
  let audio = null;

  try {
    try { wake = await navigator.wakeLock?.request('screen'); } catch (_) { /* tidak wajib */ }

    if (useFast) { await renderFast(cfg, recMime); return; }

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

    setStatus('Memuat ulang halaman...');
    layoutStage();
    await reloadPage(true);
    const src = await waitForSource(cfg.selector);
    if (!src) throw new Error('Canvas tidak ditemukan di halaman. Pastikan ada <canvas>, atau isi selector.');
    const win = el.frame.contentWindow;
    const hasHook = typeof win.renderFrame === 'function';
    autoStartPage();
    await sleep(300);
    log(`Mode: Presisi (frame demi frame, jam virtual), ${cfg.W}x${cfg.H} @ ${cfg.fps} fps, ${duration.toFixed(1)} detik`);

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
    const tStart = performance.now();
    {
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
          const el_s = (performance.now() - tStart) / 1000;
          const rate = i / Math.max(el_s, 0.001);
          const eta = (total - i) / Math.max(rate, 0.001);
          setStatus(`Merender frame ${i + 1} / ${total} | ${rate.toFixed(1)} fps | sisa ${fmtEta(eta)}`);
          if (i === 40 && eta > 900) {
            log(`Peringatan: perkiraan sisa ${fmtEta(eta)}. HP ini lambat untuk pengaturan ini. Batalkan, lalu coba 720p, 24 fps, kualitas Hemat, atau durasi lebih pendek.`);
          }
          await yieldNow();
        }
      }
      stillWarn = !moved && total > 30;
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
      setStatus('Selesai, tetapi gambar tampak tidak bergerak. Coba mode Cepat.', 'bad');
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

/* ---------- Mode Cepat: captureStream + MediaRecorder (real-time, sekitar 1x durasi) ---------- */

function pickRecorderMime() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return '';
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of list) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) { /* coba berikutnya */ }
  }
  return '';
}

/* MP4 dari MediaRecorder tidak punya durasi di header (galeri menampilkan 00:00).
   Fungsi ini menulis durasi ke mvhd, tkhd, mdhd, dan mehd. Mengembalikan jumlah kotak yang diubah. */
function fixMp4Duration(buf, sec) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let movieTs = 1000;
  let found = 0;
  const setDur = (body, ver, ts, off32, off64) => {
    const val = Math.round(sec * ts);
    if (ver === 1) v.setBigUint64(body + off64, BigInt(val)); else v.setUint32(body + off32, val >>> 0);
    found++;
  };
  const walk = (start, end) => {
    let p = start;
    while (p + 8 <= end) {
      let size = v.getUint32(p);
      const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      let hdr = 8;
      if (size === 1) { size = Number(v.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) { size = end - p; }
      if (size < 8 || p + size > end) break;
      const body = p + hdr;
      const ver = buf[body];
      if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'mvex') {
        walk(body, p + size);
      } else if (type === 'mvhd') {
        if (ver === 1) { movieTs = v.getUint32(body + 20); setDur(body, 1, movieTs, 0, 24); }
        else { movieTs = v.getUint32(body + 12); setDur(body, 0, movieTs, 16, 0); }
      } else if (type === 'mdhd') {
        const ts = ver === 1 ? v.getUint32(body + 20) : v.getUint32(body + 12);
        if (ver === 1) setDur(body, 1, ts, 0, 24); else setDur(body, 0, ts, 16, 0);
      } else if (type === 'tkhd') {
        if (ver === 1) setDur(body, 1, movieTs, 0, 28); else setDur(body, 0, movieTs, 20, 0);
      } else if (type === 'mehd') {
        if (ver === 1) setDur(body, 1, movieTs, 0, 4); else setDur(body, 0, movieTs, 4, 0);
      }
      p += size;
    }
  };
  walk(0, buf.byteLength);
  return found;
}

function paintFit(ctx, src, W, H, fit) {
  const sw = src.width || src.videoWidth;
  const sh = src.height || src.videoHeight;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  let dw = W;
  let dh = H;
  if (fit !== 'stretch') {
    const s = fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    dw = sw * s;
    dh = sh * s;
  }
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

async function renderFast(cfg, mime) {
  let rec = null;
  let ac = null;
  let bsrc = null;
  let painting = false;
  try {
    /* audio: file pilihan pengguna, kalau kosong audio bawaan halaman */
    const audioSrc = audioFile || pageAudioFile;
    let abuf = null;
    let duration = cfg.duration;
    if (audioSrc) {
      setStatus('Membaca audio...');
      abuf = await decodeAudio(audioSrc);
      if (cfg.useAudioDur) duration = Math.min(abuf.duration, 1800);
    }
    log(`Mode: Cepat (real-time), ${cfg.W}x${cfg.H} @ ${cfg.fps} fps, ${duration.toFixed(1)} detik, ${mime.split(';')[0]}`);

    setStatus('Memuat ulang halaman...');
    layoutStage();
    await reloadPage(false);
    const src = await waitForSource(cfg.selector);
    if (!src) throw new Error('Canvas tidak ditemukan di halaman. Pastikan ada <canvas>, atau isi selector.');
    const win = el.frame.contentWindow;
    const doc = el.frame.contentDocument;
    const pageAudioEl = doc.querySelector('audio');
    if (pageAudioEl) pageAudioEl.muted = true; /* suara masuk ke video lewat file audio, bukan speaker */

    /* video: tangkap canvas sumber langsung kalau ukurannya sama, kalau beda lewat canvas perantara */
    const sw = src.width || src.videoWidth;
    const sh = src.height || src.videoHeight;
    let vstream;
    if (sw === cfg.W && sh === cfg.H) {
      vstream = src.captureStream(cfg.fps);
    } else {
      const out = document.createElement('canvas');
      out.width = cfg.W;
      out.height = cfg.H;
      const octx = out.getContext('2d', { alpha: false });
      vstream = out.captureStream(cfg.fps);
      painting = true;
      let lastPaint = 0;
      const paintLoop = (now) => {
        if (!painting) return;
        if (now - lastPaint >= 1000 / cfg.fps - 3) { paintFit(octx, src, cfg.W, cfg.H, cfg.fit); lastPaint = now; }
        requestAnimationFrame(paintLoop);
      };
      paintFit(octx, src, cfg.W, cfg.H, cfg.fit);
      requestAnimationFrame(paintLoop);
    }

    const tracks = [...vstream.getVideoTracks()];
    if (abuf) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC();
      const dest = ac.createMediaStreamDestination();
      bsrc = ac.createBufferSource();
      bsrc.buffer = abuf;
      bsrc.connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
      try { await ac.resume(); } catch (_) { /* abaikan */ }
    }

    let recErr = null;
    const chunks = [];
    rec = new MediaRecorder(new MediaStream(tracks), {
      mimeType: mime, videoBitsPerSecond: cfg.bitrate, audioBitsPerSecond: 128000,
    });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => { recErr = (e && e.error) || new Error('MediaRecorder error'); };
    const stopped = new Promise((r) => { rec.onstop = r; });

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    setStatus('Merekam...');
    rec.start(250);
    autoStartPage();
    if (bsrc) bsrc.start();
    const t0 = performance.now();
    let ticks = 0;
    const countTick = () => { ticks++; win.requestAnimationFrame(countTick); };
    win.requestAnimationFrame(countTick);

    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          if (cancelled) throw new Error('Dibatalkan');
          if (recErr) throw recErr;
          const t = (performance.now() - t0) / 1000;
          setProgress(t / duration);
          setStatus(`Merekam ${t.toFixed(1)} / ${duration.toFixed(1)} detik`);
          if (t >= duration + 0.1) { clearInterval(timer); resolve(); }
        } catch (e) { clearInterval(timer); reject(e); }
      }, 100);
    });
    const elapsed = (performance.now() - t0) / 1000;
    painting = false;
    setStatus('Menyelesaikan file...');
    setProgress(1);
    rec.stop();
    await stopped;
    if (recErr) throw recErr;

    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const isMp4 = type.includes('mp4');
    let blob = new Blob(chunks, { type });
    if (isMp4) {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const n = fixMp4Duration(bytes, elapsed);
        log(`Durasi ditulis ke header MP4 (${n} kotak): ${elapsed.toFixed(2)} detik`);
        blob = new Blob([bytes], { type });
      } catch (e) { log('Gagal menulis durasi: ' + (e.message || e)); }
    }

    const fpsMeasured = ticks / Math.max(elapsed, 0.001);
    log(`Halaman berjalan rata-rata ${fpsMeasured.toFixed(1)} fps selama perekaman`);
    const mt = (rec.mimeType || mime).toLowerCase();
    const acodec = mt.includes('mp4a') ? 'AAC' : mt.includes('opus') ? 'Opus' : 'audio';
    log(`Format perekam: ${rec.mimeType || mime}`);
    showResult(blob, cfg, abuf ? { muxCodec: acodec } : null, isMp4 ? 'mp4' : 'webm');
    if (fpsMeasured < cfg.fps * 0.9) {
      setStatus(`Selesai, tetapi halaman hanya ${fpsMeasured.toFixed(0)} fps (target ${cfg.fps}), hasil bisa patah-patah. Coba mode Presisi atau 720p.`, 'bad');
    } else if (!isMp4) {
      setStatus('Selesai (format WebM). Durasi di galeri bisa tidak terbaca. Pakai mode Presisi untuk MP4.', 'ok');
    } else {
      setStatus('Selesai. Video siap diunduh.', 'ok');
    }
  } finally {
    painting = false;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (_) { /* abaikan */ }
    try { if (bsrc) bsrc.stop(); } catch (_) { /* abaikan */ }
    try { if (ac) await ac.close(); } catch (_) { /* abaikan */ }
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

function showResult(blob, cfg, asel, ext = 'mp4') {
  lastBlob = blob;
  lastUrl = URL.createObjectURL(blob);
  const name = `html-mp4-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
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
  const file = new File([blob], name, { type: blob.type || 'video/mp4' });
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
  const token = ++audioToken;
  if (!f) {
    el.useAudioDur.checked = false;
    el.useAudioDur.disabled = true;
    el.audioInfo.textContent = 'Tanpa audio, video akan senyap.';
    updateEstimate();
    return;
  }
  /* Kotak "mengikuti audio" aktif begitu ada audio; durasi pasti dibaca saat render. */
  el.useAudioDur.disabled = false;
  if (!own) el.useAudioDur.checked = true;
  const label = own ? f.name : 'audio bawaan halaman (otomatis dipakai)';
  el.audioInfo.textContent = `${label}: membaca durasi...`;
  /* Durasi dibaca lewat decode (elemen Audio sering tidak memuat metadata di Chrome Android). */
  decodeAudio(f).then((buf) => {
    if (token !== audioToken) return;
    audioDurationSec = buf.duration || 0;
    el.audioInfo.textContent = `${label} (${fmtTime(audioDurationSec)})`;
    updateEstimate();
  }).catch(() => {
    if (token !== audioToken) return;
    el.audioInfo.textContent = `${label} (durasi dibaca saat render)`;
  });
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
