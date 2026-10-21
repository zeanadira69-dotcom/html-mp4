# html-mp4

Ubah visual HTML (berbasis `<canvas>`) jadi video **MP4 + audio** langsung di browser HP. Tanpa server, tanpa screen record.
Memakai WebCodecs dan [mp4-muxer](https://github.com/Vanilagy/mp4-muxer), jadi header MP4 lengkap dan durasi di galeri terbaca benar (bukan 00:00).

## Cara pakai
1. Buka situs di Chrome Android terbaru.
2. Muat HTML (upload file atau tempel kode), atau tekan **Muat contoh**.
3. Pilih audio (opsional), resolusi, fps, durasi.
4. **Mulai render**, biarkan layar menyala dan tab terbuka.
5. **Unduh MP4**.

## Mode render
- **Cepat (real-time, sekitar 1x durasi):** merekam canvas langsung dengan `captureStream` + `MediaRecorder` (encoder bawaan HP), lalu durasi ditulis ke header MP4 supaya galeri tidak menampilkan 00:00. Video 30 detik selesai dalam sekitar 30 detik. Halaman berjalan apa adanya; kalau HP tidak sanggup mencapai fps target, tool memberi peringatan karena hasil bisa patah-patah.
- **Presisi (frame demi frame):** perekam mengendalikan waktu halaman (jam virtual: `audio.currentTime`, `performance.now`, `Date.now`, timestamp `requestAnimationFrame`) dan meng-encode lewat WebCodecs + mp4-muxer. Selalu mulus dan pas, tetapi lebih lama.
- **Otomatis:** pakai Cepat kalau browser menghasilkan MP4, kalau tidak pakai Presisi.

Di semua mode, tombol "Tap to start" ditekan otomatis dan audio yang tertanam di halaman (`<audio src=...>`) ikut masuk ke video.

Opsional: halaman boleh punya `window.renderFrame(t, index, fps)` yang menggambar satu frame secara sinkron (lihat `sample.html`), maka fungsi itu dipanggil langsung.

## Batasan
- Hanya menangkap `<canvas>` (atau `<video>`). Animasi CSS/SVG/DOM biasa belum didukung.
- Jam virtual (mode Presisi) belum mengendalikan `setTimeout`/`setInterval`. Kalau gambar tampak diam, tool memberi peringatan; pakai mode Cepat.
- Mode Cepat memakai codec pilihan browser (idealnya H.264 + AAC). Kalau browser hanya bisa VP9/Opus atau WebM, sebagian galeri/iPhone atau aplikasi bisa menolak; pakai mode Presisi.
- Video H.264 memakai encoder bawaan perangkat. Browser tanpa H.264 akan menampilkan pesan error.
- File disusun di memori, jadi video sangat panjang atau 1080p@60 bisa berat di HP.

## File
`index.html`, `app.js`, `mp4-muxer.mjs` (library, lisensi MIT di `LICENSE-mp4-muxer`), `sample.html`.
Semua di root repo (tanpa folder) supaya mudah diupload lewat GitHub web dari HP. Vercel: Import repo, Framework Preset **Other**, Deploy.
