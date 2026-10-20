# html-mp4

Ubah visual HTML (berbasis `<canvas>`) jadi video **MP4 + audio** langsung di browser HP. Tanpa server, tanpa screen record.
Memakai WebCodecs dan [mp4-muxer](https://github.com/Vanilagy/mp4-muxer), jadi header MP4 lengkap dan durasi di galeri terbaca benar (bukan 00:00).

## Cara pakai
1. Buka situs di Chrome Android terbaru.
2. Muat HTML (upload file atau tempel kode), atau tekan **Muat contoh**.
3. Pilih audio (opsional), resolusi, fps, durasi.
4. **Mulai render**, biarkan layar menyala dan tab terbuka.
5. **Unduh MP4**.

## Dua mode render
- **Frame demi frame (disarankan):** halaman punya `window.renderFrame(t)`. Hasil mulus, tidak bergantung kecepatan HP.
- **Real-time:** halaman berjalan sendiri dan direkam apa adanya. Bisa patah-patah kalau HP lambat.

Kontrak untuk mode frame demi frame (lihat `sample.html`):
```js
window.renderFrame = function (t, index, fps) {
  // gambar SATU frame di <canvas> untuk waktu t (detik), secara sinkron
};
```

## Batasan
- Hanya menangkap `<canvas>` (atau `<video>`). Animasi CSS/SVG/DOM biasa belum didukung.
- Audio di-encode AAC. Kalau browser tidak punya AAC, dipakai Opus (sebagian galeri/iPhone bisa tidak memutarnya).
- Video H.264 memakai encoder bawaan perangkat. Browser tanpa H.264 akan menampilkan pesan error.
- File disusun di memori, jadi video sangat panjang atau 1080p@60 bisa berat di HP.

## File
`index.html`, `app.js`, `mp4-muxer.mjs` (library, lisensi MIT di `LICENSE-mp4-muxer`), `sample.html`.
Semua di root repo (tanpa folder) supaya mudah diupload lewat GitHub web dari HP. Vercel: Import repo, Framework Preset **Other**, Deploy.
