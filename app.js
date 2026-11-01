// Library pelacak tangan dimuat saat tombol ditekan (lihat loadHands), supaya kegagalan
// memuat dari CDN muncul sebagai pesan di layar, bukan membuat seluruh halaman diam.
const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
let HandLandmarker;
let FilesetResolver;

/* ============================================================
   Konfigurasi
   ============================================================ */
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const GRID = 3;                       // puzzle 3 x 3 = 9 kepingan
const PHOTO_W = 480;                  // ukuran foto hasil crop
const PHOTO_H = 600;
const ASPECT = PHOTO_W / PHOTO_H;     // 4:5 (potret)

// susunan strip: n = jumlah foto, cols = jumlah kolom (4 foto = kiri-kanan, 2 x 2)
const LAYOUTS = [
  { id: "2", n: 2, cols: 1, label: "2 Foto" },
  { id: "3", n: 3, cols: 1, label: "3 Foto" },
  { id: "4", n: 4, cols: 2, label: "4 Foto (kiri-kanan)" },
];

const HOLD_FRAME_MS = 1400;           // lama menahan bingkai sebelum foto diambil
const HOLD_FIST_MS = 800;             // lama menahan kepalan untuk menyimpan
const COOLDOWN_MS = 1600;             // jeda setelah menyimpan
const PINCH_ON = 0.28;                // rasio jarak jempol-telunjuk: mulai mencubit
const PINCH_OFF = 0.42;               // rasio: melepas cubitan (hysteresis)

const FLASH = "#ffd23f";
const OK = "#4ade9f";

/* ---------- Pilihan tambahan: mode, filter, bingkai strip ---------- */
const MODES = [
  { id: "puzzle", label: "Puzzle" },
  { id: "normal", label: "Normal" },
];

const FILTERS = [
  { id: "bw", label: "Hitam Putih", dot: "#8a8a8a" },   // bawaan (seperti sebelumnya)
  { id: "color", label: "Warna Asli", dot: "#e8604c" },
  { id: "sepia", label: "Sepia", dot: "#a9784a" },
  { id: "vintage", label: "Vintage", dot: "#d9a86c" },
  { id: "cool", label: "Dingin", dot: "#5aa9e6" },
  { id: "vivid", label: "Cerah", dot: "#ff3d7f" },
];

// bg = warna dasar strip, ink = warna teks utama, sub = teks tanggal,
// line = garis tipis di sekeliling foto, deco = hiasan di tepi strip
const FRAMES = [
  { id: "klasik", label: "Klasik", bg: "#fbf8f6", ink: "#171219", sub: "#5b4f57", line: null, deco: null },
  { id: "hitam", label: "Hitam", bg: "#171219", ink: "#fbf8f6", sub: "#b9aeb5", line: "#fbf8f6", deco: null },
  { id: "pink", label: "Pink Polkadot", bg: "#ffd6e7", ink: "#171219", sub: "#7a4a5e", line: "#ffffff", deco: "dots", decoColor: "#ff9fc4" },
  { id: "kuning", label: "Kuning Ceria", bg: "#ffd23f", ink: "#171219", sub: "#6b5400", line: "#171219", deco: "stripes", decoColor: "#f2bd10" },
  { id: "mint", label: "Mint Hati", bg: "#c9f2e0", ink: "#12352a", sub: "#3f6f5d", line: "#ffffff", deco: "hearts", decoColor: "#6fd3a8" },
  { id: "konfeti", label: "Konfeti", bg: "#fffaf0", ink: "#171219", sub: "#5b4f57", line: "#171219", deco: "confetti", dot: "#ff6b6b" },
  { id: "malam", label: "Malam Bintang", bg: "#1b1f4a", ink: "#fff6d6", sub: "#b7bbe6", line: "#fff6d6", deco: "stars", decoColor: "#ffd23f" },
];

/* ============================================================
   Elemen DOM
   ============================================================ */
const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = $("stage");
const canvas = $("stage-canvas");
const ctx = canvas.getContext("2d");
const msgEl = $("msg");
const countEl = $("count");
const flashEl = $("flash");
const startEl = $("start");
const startBtn = $("start-btn");
const errorEl = $("error");
const stripEl = $("strip");
const progressEl = $("progress");
const saveBtn = $("save-btn");
const resetBtn = $("reset-btn");
const resultEl = $("result");
const resultImg = $("result-img");
const downloadBtn = $("download-btn");
const againBtn = $("again-btn");

// Tombol kembali ke layar pilihan awal. Dibuat otomatis: satu di samping tombol
// "mulai ulang" di galeri, satu lagi di layar hasil akhir.
const backBtns = [resetBtn, againBtn].map((anchor) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn ghost back-btn";
  b.textContent = "← Kembali ke pilihan";
  b.hidden = true;
  anchor.insertAdjacentElement("afterend", b);
  return b;
});

// Kanvas tersembunyi berisi frame kamera yang sudah dicerminkan.
const frameCanvas = document.createElement("canvas");
const fctx = frameCanvas.getContext("2d", { willReadFrequently: false });

/* ============================================================
   State
   ============================================================ */
const state = {
  phase: "idle", // idle | loading | frame | puzzle | done | finished
  W: 1280,
  H: 720,
  rect: null,
  anchor: null,
  holdStart: 0,
  photo: null,
  photoMode: "puzzle", // mode yang dipakai untuk foto yang sedang dikerjakan
  order: [],
  held: -1,
  pinching: false,
  cursor: { x: 0, y: 0, seen: false },
  mouse: { x: 0, y: 0, down: false, inside: false },
  lostSince: 0,
  fistStart: 0,
  cooldownUntil: 0,
  saved: [],
  stripCanvas: null,
  mode: "puzzle",
  filter: "bw",
  frame: "klasik",
  layout: "3",
};

let landmarker = null;
let hands = []; // tiap tangan = array 21 titik { x, y } dalam piksel kanvas (sudah dicerminkan)
let lastVideoTime = -1;
let lastMsg = "";
let lastCount = -1;

/* ============================================================
   Helper
   ============================================================ */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

function setMessage(text) {
  if (text === lastMsg) return;
  lastMsg = text;
  msgEl.textContent = text;
}

function setCount(n) {
  if (n === lastCount) return;
  lastCount = n;
  countEl.textContent = `${n} / ${GRID * GRID} kepingan terpasang`;
}

function setPhase(phase) {
  state.phase = phase;
  backBtns.forEach((b) => { b.hidden = phase === "idle" || phase === "loading"; });
  const isPuzzleDone = phase === "done" && state.photoMode === "puzzle";
  countEl.hidden = !(phase === "puzzle" || isPuzzleDone);
  saveBtn.disabled = phase !== "done";

  if (phase === "puzzle") {
    setCount(countCorrect(state.order));
    setMessage("cubit jempol dan telunjuk, geser ke kepingan lain buat bikin puzzlenya, lalu lepas kalau mmau tukar.");
  } else if (phase === "done") {
    if (state.photoMode === "puzzle") {
      setCount(GRID * GRID);
      setMessage("yeyyyy udah selesai! Kepalkan tangan buat save nya.");
    } else {
      setMessage("fotonya udah jadi! Kepalkan tangan buat save nya.");
    }
  } else if (phase === "finished") {
    setMessage("yey foto selesai dan diunduh.");
  }
}

function updateProgressText() {
  const n = state.saved.length;
  const total = photosNeeded();
  progressEl.textContent =
    n >= total
      ? `Selesai: ${total} dari ${total} foto`
      : `Foto ${n + 1} dari ${total}`;
}

function triggerFlash() {
  flashEl.classList.remove("on");
  void flashEl.offsetWidth; // restart animasi
  flashEl.classList.add("on");
}

/* ============================================================
   Pilihan jumlah foto, mode, filter, dan bingkai strip
   ============================================================ */
// Semua pilihan ditaruh di layar awal (sebelum tombol mulai). Bingkai juga bisa
// diganti lagi di layar hasil akhir. Gaya tambahan disuntik dari sini supaya
// tidak perlu mengubah index.html atau style.css; class .chip / .dot / .chips
// memakai gaya yang sudah ada di style.css.
const SETUP_CSS = `
.start { overflow: auto; justify-content: safe center; }
.setup { display: grid; gap: 12px; width: min(560px, 100%); text-align: left; }
.setup-group { display: grid; gap: 6px; }
.start .setup-title { margin: 0; font-weight: 700; font-size: 0.85rem; color: var(--muted); }
.start .chips { gap: 6px; }
.start .chip { padding: 5px 12px; font-size: 0.85rem; }
.start .chip:has(.dot) { padding-left: 8px; }
.result .back-btn { color: var(--text); border-color: rgba(255, 255, 255, 0.45); }
.gallery .strip.cols-2 { width: 200px; grid-template-columns: repeat(2, 1fr); }
@media (max-width: 900px) {
  .gallery .strip[data-n="2"] { grid-template-columns: repeat(2, 1fr); }
  .gallery .strip.cols-2 { width: 100%; max-width: 420px; grid-template-columns: repeat(4, 1fr); }
}
`;

const layoutInfo = () => LAYOUTS.find((l) => l.id === state.layout) || LAYOUTS[1];
const photosNeeded = () => layoutInfo().n;

function makeGroup(title, attr, items, withDot) {
  const group = document.createElement("div");
  group.className = "setup-group";

  const t = document.createElement("p");
  t.className = "setup-title";
  t.textContent = title;

  const chips = document.createElement("div");
  chips.className = "chips";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.dataset[attr] = it.id;
    if (withDot) {
      const d = document.createElement("span");
      d.className = "dot";
      d.style.background = it.dot || it.bg;
      b.append(d);
    }
    b.append(it.label);
    chips.append(b);
  }
  group.append(t, chips);
  return group;
}

function buildSetupPanel() {
  const panel = document.createElement("div");
  panel.className = "setup";
  panel.append(
    makeGroup("Jumlah foto", "layout", LAYOUTS, false),
    makeGroup("Mode", "mode", MODES, false),
    makeGroup("Filter", "filter", FILTERS, true),
    makeGroup("Bingkai strip", "frame", FRAMES, true)
  );
  startBtn.insertAdjacentElement("beforebegin", panel);
}

// Pilihan bingkai di layar hasil akhir (hanya dibuat bila belum ada di HTML).
function buildResultPicker() {
  const actions = resultEl.querySelector(".result-actions");
  if (!actions || actions.querySelector("[data-frame]")) return;
  const wrap = document.createElement("div");
  wrap.className = "styler";
  wrap.append(makeGroup("Bingkai strip", "frame", FRAMES, true));
  actions.prepend(wrap);
}

// Slot foto di galeri mengikuti jumlah foto yang dipilih.
function buildSlots() {
  const info = layoutInfo();
  stripEl.classList.toggle("cols-2", info.cols === 2);
  stripEl.dataset.n = String(info.n);
  stripEl.replaceChildren(
    ...Array.from({ length: info.n }, (_, i) => {
      const li = document.createElement("li");
      li.className = "slot";
      const span = document.createElement("span");
      span.textContent = `Foto ${i + 1}`;
      li.append(span);
      return li;
    })
  );
}

function refreshActive(attr, value) {
  document.querySelectorAll(`[data-${attr}]`).forEach((el) => {
    const on = el.dataset[attr] === value;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function setOption(attr, value) {
  // jumlah foto hanya bisa diganti sebelum mulai
  if (attr === "layout" && state.phase !== "idle") return;

  state[attr] = value;
  refreshActive(attr, value);

  if (attr === "layout") {
    buildSlots();
    updateProgressText();
  }

  // bingkai bisa diganti kapan saja, termasuk saat hasil strip sudah tampil
  if (attr === "frame" && state.stripCanvas) {
    state.stripCanvas = buildStrip(state.saved);
    resultImg.src = state.stripCanvas.toDataURL("image/png");
  }
}

function initOptions() {
  const style = document.createElement("style");
  style.textContent = SETUP_CSS;
  document.head.append(style);

  // kalau HTML sudah punya kontrol sendiri (data-layout / data-mode / data-filter),
  // panel otomatis tidak dibuat
  const own = ["layout", "mode", "filter"].some((a) => document.querySelector(`[data-${a}]`));
  if (!own) buildSetupPanel();
  buildResultPicker();

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-layout],[data-mode],[data-filter],[data-frame]");
    if (!el) return;
    for (const attr of ["layout", "mode", "filter", "frame"]) {
      if (el.dataset[attr] !== undefined) setOption(attr, el.dataset[attr]);
    }
  });

  for (const attr of ["layout", "mode", "filter", "frame"]) refreshActive(attr, state[attr]);
  buildSlots();
  updateProgressText();
}

/* ============================================================
   Kamera dan pelacak tangan
   ============================================================ */
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("kamera belum siap bosqu");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((res) => (video.onloadedmetadata = res));
  }

  state.W = video.videoWidth;
  state.H = video.videoHeight;
  canvas.width = frameCanvas.width = state.W;
  canvas.height = frameCanvas.height = state.H;
  stage.style.aspectRatio = `${state.W} / ${state.H}`;
}

async function loadHands() {
  let fileset;
  try {
    ({ HandLandmarker, FilesetResolver } = await import(VISION_URL));
    fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const make = (delegate) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      landmarker = await make("GPU");
    } catch {
      landmarker = await make("CPU");
    }
  } catch (err) {
    console.error(err);
    throw new Error("internet lu coba di cek");
  }
}

function showError(err) {
  let text = err?.message || "ntar ada yang salah";
  if (err?.name === "NotAllowedError") {
    text = "izinin dulu kameranya kocak";
  } else if (err?.name === "NotFoundError") {
    text = "kamera lu rusak?";
  } else if (err?.name === "NotReadableError") {
    text = "itu kamera km masih di aplikasi lain, tutup dulu baru bisa";
  }
  errorEl.textContent = text;
  errorEl.hidden = false;
}

let loopStarted = false;

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  errorEl.hidden = true;
  try {
    setPhase("loading");
    // kalau sudah pernah menyala (setelah tombol kembali), langkah ini dilewati
    if (!video.srcObject) {
      setMessage("lagi nyalain kamera");
      await startCamera();
    }
    if (!landmarker) {
      setMessage("lagingelacak tangan");
      await loadHands();
    }
    startEl.hidden = true;
    setPhase("frame");
    if (!loopStarted) {
      loopStarted = true;
      requestAnimationFrame(loop);
    }
  } catch (err) {
    showError(err);
    state.phase = "idle";
    setMessage("kamera belum nyala bos");
    startBtn.disabled = false;
  }
});

/* ============================================================
   Loop utama
   ============================================================ */
function toPixels(landmarks) {
  const { W, H } = state;
  return landmarks.map((p) => ({ x: (1 - p.x) * W, y: p.y * H })); // x dicerminkan
}

function loop(now) {
  requestAnimationFrame(loop);
  if (video.readyState < 2) return;
  const { W, H } = state;

  // frame kamera dicerminkan seperti cermin
  fctx.save();
  fctx.translate(W, 0);
  fctx.scale(-1, 1);
  fctx.drawImage(video, 0, 0, W, H);
  fctx.restore();

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    hands = res.landmarks.map(toPixels);
  }

  ctx.drawImage(frameCanvas, 0, 0);

  switch (state.phase) {
    case "frame":
      updateFrame(now);
      break;
    case "puzzle":
      updatePuzzle(now);
      break;
    case "done":
      updateDone(now);
      break;
    default:
      break;
  }
}

/* ============================================================
   Fase 1: bingkai dari dua tangan
   ============================================================ */
function normalizeRect(minX, minY, maxX, maxY) {
  const { W, H } = state;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let ch = Math.max(maxY - minY, (maxX - minX) / ASPECT);
  let cw = ch * ASPECT;
  if (ch > H) { ch = H; cw = ch * ASPECT; }
  if (cw > W) { cw = W; ch = cw / ASPECT; }
  const x = clamp(cx - cw / 2, 0, W - cw);
  const y = clamp(cy - ch / 2, 0, H - ch);
  return { x, y, w: cw, h: ch };
}

function lerpRect(a, b, t) {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
  };
}

function resetFrameTracking() {
  state.rect = null;
  state.anchor = null;
  state.holdStart = 0;
}

function updateFrame(now) {
  const { W } = state;

  if (now < state.cooldownUntil) {
    setMessage("ready for next photoooo");
    return;
  }

  if (hands.length < 2) {
    resetFrameTracking();
    setMessage(
      hands.length === 1
        ? "angkat kedua tangan buat bentuk bingkainya"
        : "jempol dan telunjuk membentuk huruf L di dua sudut yang berlawanan."
    );
    drawFingertips();
    return;
  }

  // ujung jempol (4) dan telunjuk (8) dari kedua tangan menentukan sudut bingkai
  const pts = hands.flatMap((h) => [h[4], h[8]]);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const target = normalizeRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));

  if (target.w < W * 0.18) {
    resetFrameTracking();
    setMessage("perbesar foto dengan renganggkan kedua tangan");
    drawFingertips();
    return;
  }

  state.rect = state.rect ? lerpRect(state.rect, target, 0.4) : target;

  // bingkai dianggap stabil jika posisi dan ukurannya tidak banyak berubah
  const a = state.anchor;
  const stable =
    a &&
    Math.hypot(target.x + target.w / 2 - (a.x + a.w / 2), target.y + target.h / 2 - (a.y + a.h / 2)) < W * 0.04 &&
    Math.abs(target.w - a.w) < W * 0.06;
  if (!stable) {
    state.anchor = { ...target };
    state.holdStart = now;
  }

  const progress = clamp((now - state.holdStart) / HOLD_FRAME_MS, 0, 1);
  drawFrameRect(state.rect, progress);
  drawFingertips();
  setMessage(progress > 0.05 ? "tahan posisi bingkainya" : "atur posisi bingkai buat foto");

  if (progress >= 1) capture(state.rect);
}

function drawFrameRect(r, progress) {
  const { W, H } = state;

  // gelapkan area di luar bingkai
  ctx.save();
  ctx.fillStyle = "rgba(10, 6, 12, 0.45)";
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill("evenodd");
  ctx.restore();

  // garis bantu 3 x 3 (pratinjau potongan puzzle), hanya di mode puzzle
  if (state.mode === "puzzle") {
    ctx.strokeStyle = "rgba(255, 210, 63, 0.35)";
    ctx.lineWidth = 1.5;
    for (let i = 1; i < GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(r.x + (r.w * i) / GRID, r.y);
      ctx.lineTo(r.x + (r.w * i) / GRID, r.y + r.h);
      ctx.moveTo(r.x, r.y + (r.h * i) / GRID);
      ctx.lineTo(r.x + r.w, r.y + (r.h * i) / GRID);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = FLASH;
  ctx.lineWidth = Math.max(3, W * 0.004);
  ctx.strokeRect(r.x, r.y, r.w, r.h);

  drawProgressBar(r.x, r.y + r.h, r.w, progress, FLASH);
}

function drawProgressBar(x, bottom, width, progress, color) {
  const { H } = state;
  const barH = 8;
  const y = bottom + 12 + barH <= H ? bottom + 12 : bottom - barH - 12;
  ctx.fillStyle = "rgba(23, 18, 25, 0.8)";
  ctx.fillRect(x, y, width, barH);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width * progress, barH);
}

function drawFingertips() {
  ctx.fillStyle = FLASH;
  for (const h of hands) {
    for (const i of [4, 8]) {
      ctx.beginPath();
      ctx.arc(h[i].x, h[i].y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ============================================================
   Ambil foto dan buat puzzle
   ============================================================ */
function toGrayscale(pctx, w, h) {
  const img = pctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g = clamp((g - 128) * 1.08 + 128, 0, 255);
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  pctx.putImageData(img, 0, 0);
}

// Menerapkan filter pilihan ke foto hasil crop.
function applyFilter(pctx, w, h, name) {
  if (name === "bw") {
    toGrayscale(pctx, w, h);
    return;
  }
  if (name === "color") return;

  const img = pctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    switch (name) {
      case "sepia": {
        const nr = 0.393 * r + 0.769 * g + 0.189 * b;
        const ng = 0.349 * r + 0.686 * g + 0.168 * b;
        const nb = 0.272 * r + 0.534 * g + 0.131 * b;
        r = nr; g = ng; b = nb;
        break;
      }
      case "vintage": {
        // kontras diturunkan, hangat, bayangan sedikit terangkat
        r = (r - 128) * 0.88 + 128 + 22;
        g = (g - 128) * 0.88 + 128 + 8;
        b = (b - 128) * 0.88 + 128 - 20;
        r = lerp(r, lum, 0.15);
        g = lerp(g, lum, 0.15);
        b = lerp(b, lum, 0.15);
        break;
      }
      case "cool": {
        r = r * 0.92 - 4;
        g = g * 1.0 + 4;
        b = b * 1.1 + 16;
        break;
      }
      case "vivid": {
        r = lum + (r - lum) * 1.45;
        g = lum + (g - lum) * 1.45;
        b = lum + (b - lum) * 1.45;
        r = (r - 128) * 1.1 + 128;
        g = (g - 128) * 1.1 + 128;
        b = (b - 128) * 1.1 + 128;
        break;
      }
      default:
        break;
    }

    d[i] = clamp(r, 0, 255);
    d[i + 1] = clamp(g, 0, 255);
    d[i + 2] = clamp(b, 0, 255);
  }
  pctx.putImageData(img, 0, 0);
}

function countCorrect(order) {
  return order.reduce((n, tile, slot) => n + (tile === slot ? 1 : 0), 0);
}

function shuffledOrder() {
  const n = GRID * GRID;
  let order;
  do {
    order = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } while (countCorrect(order) > 1);
  return order;
}

function capture(r) {
  const photo = document.createElement("canvas");
  photo.width = PHOTO_W;
  photo.height = PHOTO_H;
  const pctx = photo.getContext("2d", { willReadFrequently: true });
  pctx.drawImage(frameCanvas, r.x, r.y, r.w, r.h, 0, 0, PHOTO_W, PHOTO_H);
  applyFilter(pctx, PHOTO_W, PHOTO_H, state.filter);

  state.photo = photo;
  state.photoMode = state.mode;
  state.order = shuffledOrder();
  state.held = -1;
  state.pinching = false;
  state.lostSince = 0;
  state.cursor.seen = false;
  state.fistStart = 0;
  resetFrameTracking();

  triggerFlash();
  // mode normal: langsung ke tahap simpan, tanpa puzzle
  setPhase(state.photoMode === "normal" ? "done" : "puzzle");
}

/* ============================================================
   Fase 2: puzzle
   ============================================================ */
function boardRect() {
  const { W, H } = state;
  const h = H * 0.84;
  const w = h * ASPECT;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function slotAt(x, y, b) {
  if (x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) return -1;
  const col = Math.floor((x - b.x) / (b.w / GRID));
  const row = Math.floor((y - b.y) / (b.h / GRID));
  return row * GRID + col;
}

function pinchRatio(h) {
  return dist(h[4], h[8]) / Math.max(1, dist(h[0], h[9]));
}

// Mengembalikan { x, y, down, source } atau null bila tidak ada input.
function readPointer() {
  if (state.mouse.down && state.mouse.inside) {
    return { x: state.mouse.x, y: state.mouse.y, down: true, source: "mouse" };
  }

  if (hands.length) {
    let best = null;
    let bestScore = Infinity;
    for (const h of hands) {
      const m = mid(h[4], h[8]);
      const ratio = pinchRatio(h);
      const pinchingNow = ratio < (state.pinching ? PINCH_OFF : PINCH_ON);
      const away = state.cursor.seen ? dist(m, state.cursor) : 0;
      const score = pinchingNow ? ratio - 1000 : away;
      if (score < bestScore) {
        bestScore = score;
        best = { m, ratio, pinchingNow };
      }
    }
    return { x: best.m.x, y: best.m.y, down: best.pinchingNow, source: "hand" };
  }

  if (state.mouse.inside) {
    return { x: state.mouse.x, y: state.mouse.y, down: false, source: "mouse" };
  }
  return null;
}

function updatePuzzle(now) {
  const board = boardRect();
  const p = readPointer();

  if (p) {
    state.lostSince = 0;
    if (p.source === "hand" && state.cursor.seen) {
      state.cursor.x = lerp(state.cursor.x, p.x, 0.5); // haluskan getaran tangan
      state.cursor.y = lerp(state.cursor.y, p.y, 0.5);
    } else {
      state.cursor.x = p.x;
      state.cursor.y = p.y;
    }
    state.cursor.seen = true;

    const wasDown = state.pinching;
    state.pinching = p.down;

    if (p.down && !wasDown) {
      const s = slotAt(state.cursor.x, state.cursor.y, board);
      if (s >= 0) state.held = s;
    } else if (!p.down && wasDown && state.held >= 0) {
      const target = slotAt(state.cursor.x, state.cursor.y, board);
      if (target >= 0 && target !== state.held) {
        const o = state.order;
        [o[state.held], o[target]] = [o[target], o[state.held]];
        setCount(countCorrect(o));
      }
      state.held = -1;
    }
  } else {
    state.cursor.seen = false;
    if (state.held >= 0) {
      if (!state.lostSince) state.lostSince = now;
      if (now - state.lostSince > 500) {
        state.held = -1;
        state.pinching = false;
        state.lostSince = 0;
      }
    } else {
      state.pinching = false;
    }
  }

  drawPuzzle(board);

  if (countCorrect(state.order) === GRID * GRID) {
    state.held = -1;
    state.pinching = false;
    state.fistStart = 0;
    setPhase("done");
  }
}

function drawPuzzle(board) {
  const { W, H } = state;
  const tw = board.w / GRID;
  const th = board.h / GRID;
  const sw = PHOTO_W / GRID;
  const sh = PHOTO_H / GRID;
  const hover = state.cursor.seen ? slotAt(state.cursor.x, state.cursor.y, board) : -1;

  ctx.fillStyle = "rgba(15, 10, 18, 0.62)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#171219";
  ctx.fillRect(board.x - 6, board.y - 6, board.w + 12, board.h + 12);

  for (let s = 0; s < GRID * GRID; s++) {
    const dx = board.x + (s % GRID) * tw;
    const dy = board.y + Math.floor(s / GRID) * th;
    if (s === state.held) continue; // kepingan yang sedang dipegang digambar di akhir

    const t = state.order[s];
    ctx.drawImage(
      state.photo,
      (t % GRID) * sw, Math.floor(t / GRID) * sh, sw, sh,
      dx + 1, dy + 1, tw - 2, th - 2
    );
    if (t === s) {
      ctx.strokeStyle = OK;
      ctx.lineWidth = 3;
      ctx.strokeRect(dx + 2.5, dy + 2.5, tw - 5, th - 5);
    }
  }

  // sorot slot di bawah kursor
  if (hover >= 0) {
    const dx = board.x + (hover % GRID) * tw;
    const dy = board.y + Math.floor(hover / GRID) * th;
    ctx.strokeStyle = FLASH;
    ctx.lineWidth = 4;
    ctx.strokeRect(dx + 2, dy + 2, tw - 4, th - 4);
  }

  // kepingan yang sedang dipegang mengikuti kursor
  if (state.held >= 0) {
    const t = state.order[state.held];
    const hw = tw * 1.08;
    const hh = th * 1.08;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.drawImage(
      state.photo,
      (t % GRID) * sw, Math.floor(t / GRID) * sh, sw, sh,
      state.cursor.x - hw / 2, state.cursor.y - hh / 2, hw, hh
    );
    ctx.restore();
    ctx.strokeStyle = FLASH;
    ctx.lineWidth = 3;
    ctx.strokeRect(state.cursor.x - hw / 2, state.cursor.y - hh / 2, hw, hh);
  }

  // kursor cubitan
  if (state.cursor.seen) {
    ctx.beginPath();
    ctx.arc(state.cursor.x, state.cursor.y, 16, 0, Math.PI * 2);
    if (state.pinching) {
      ctx.fillStyle = FLASH;
      ctx.fill();
    }
    ctx.strokeStyle = state.pinching ? "#171219" : FLASH;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

/* ---------- input mouse (cadangan bila tangan tidak terdeteksi) ---------- */
function mousePos(e) {
  const r = canvas.getBoundingClientRect();
  state.mouse.x = ((e.clientX - r.left) * state.W) / r.width;
  state.mouse.y = ((e.clientY - r.top) * state.H) / r.height;
}
canvas.addEventListener("pointermove", (e) => {
  mousePos(e);
  state.mouse.inside = true;
});
canvas.addEventListener("pointerdown", (e) => {
  mousePos(e);
  state.mouse.inside = true;
  state.mouse.down = true;
  canvas.setPointerCapture(e.pointerId);
});
const releasePointer = () => { state.mouse.down = false; };
canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", releasePointer);
canvas.addEventListener("pointerleave", () => {
  if (!state.mouse.down) state.mouse.inside = false;
});

/* ============================================================
   Fase 3: puzzle selesai, kepalkan tangan untuk menyimpan
   ============================================================ */
function isFist(h) {
  const wrist = h[0];
  const fingers = [[8, 6], [12, 10], [16, 14], [20, 18]]; // [ujung, sendi tengah]
  return fingers.every(([tip, pip]) => dist(h[tip], wrist) < dist(h[pip], wrist));
}

function updateDone(now) {
  const board = boardRect();
  const { W, H } = state;

  ctx.fillStyle = "rgba(15, 10, 18, 0.62)";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(state.photo, 0, 0, PHOTO_W, PHOTO_H, board.x, board.y, board.w, board.h);
  ctx.strokeStyle = OK;
  ctx.lineWidth = 6;
  ctx.strokeRect(board.x - 3, board.y - 3, board.w + 6, board.h + 6);

  if (hands.some(isFist)) {
    if (!state.fistStart) state.fistStart = now;
    const progress = clamp((now - state.fistStart) / HOLD_FIST_MS, 0, 1);
    drawProgressBar(board.x, board.y + board.h, board.w, progress, OK);
    setMessage("tahan kepalan buat menyimpan…");
    if (progress >= 1) saveCurrent(now);
  } else {
    state.fistStart = 0;
    setMessage(
      state.photoMode === "puzzle"
        ? "horee puzzle selesai! kepalkan tangan biar kesimpan yaww"
        : "fotonya udah jadi! kepalkan tangan biar kesimpan yaww"
    );
  }
}

function addThumb(photo, index) {
  const img = document.createElement("img");
  img.src = photo.toDataURL("image/jpeg", 0.85);
  img.alt = `Foto ${index + 1}`;
  stripEl.children[index].replaceChildren(img);
}

function saveCurrent(now) {
  if (state.phase !== "done" || !state.photo) return;

  state.saved.push(state.photo);
  addThumb(state.photo, state.saved.length - 1);
  state.photo = null;
  state.fistStart = 0;
  updateProgressText();

  if (state.saved.length >= photosNeeded()) {
    finish();
  } else {
    state.cooldownUntil = now + COOLDOWN_MS;
    resetFrameTracking();
    setPhase("frame");
  }
}

saveBtn.addEventListener("click", () => saveCurrent(performance.now()));

/* ============================================================
   Strip foto akhir
   ============================================================ */
function starPath(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

function heartPath(g, cx, cy, s) {
  g.beginPath();
  g.moveTo(cx, cy + s * 0.9);
  g.bezierCurveTo(cx - s * 1.5, cy - s * 0.2, cx - s * 0.7, cy - s * 1.2, cx, cy - s * 0.4);
  g.bezierCurveTo(cx + s * 0.7, cy - s * 1.2, cx + s * 1.5, cy - s * 0.2, cx, cy + s * 0.9);
  g.closePath();
}

// Menggambar satu hiasan kecil di titik (x, y) sesuai gaya bingkai.
function drawDecoItem(g, kind, x, y, size) {
  switch (kind) {
    case "dots":
      g.beginPath();
      g.arc(x, y, size * 0.55, 0, Math.PI * 2);
      g.fill();
      break;
    case "stars":
      starPath(g, x, y, size);
      g.fill();
      break;
    case "hearts":
      heartPath(g, x, y, size * 0.6);
      g.fill();
      break;
    default:
      break;
  }
}

// Konfeti warna-warni di sekeliling strip (posisi tetap, bukan acak tiap gambar).
function drawConfetti(g, c, pad) {
  const colors = ["#ff6b6b", "#ffd23f", "#4ecdc4", "#5b8def", "#b388ff"];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const spots = [];
  for (let y = pad / 2; y < c.height; y += 30) {
    spots.push([pad / 2, y], [c.width - pad / 2, y]);
  }
  for (let x = pad / 2 + 30; x < c.width - pad / 2; x += 30) {
    spots.push([x, pad / 2], [x, c.height - pad / 2]);
  }

  for (const [x, y] of spots) {
    const sz = 4 + rnd() * 3;
    const kind = Math.floor(rnd() * 3);
    g.save();
    g.translate(x + (rnd() - 0.5) * 8, y + (rnd() - 0.5) * 8);
    g.rotate(rnd() * Math.PI);
    g.fillStyle = colors[Math.floor(rnd() * colors.length)];
    g.beginPath();
    if (kind === 0) {
      g.arc(0, 0, sz * 0.8, 0, Math.PI * 2);
    } else if (kind === 1) {
      g.rect(-sz, -sz * 0.6, sz * 2, sz * 1.2);
    } else {
      g.moveTo(0, -sz);
      g.lineTo(sz, sz * 0.8);
      g.lineTo(-sz, sz * 0.8);
      g.closePath();
    }
    g.fill();
    g.restore();
  }
}

function drawFrameDecor(g, c, f, pad, footer) {
  if (!f.deco) return;
  if (f.deco === "confetti") {
    drawConfetti(g, c, pad);
    return;
  }
  g.save();
  g.fillStyle = f.decoColor || f.ink;
  g.strokeStyle = f.decoColor || f.ink;

  if (f.deco === "stripes") {
    // garis diagonal tipis di seluruh latar, foto digambar di atasnya
    g.lineWidth = 6;
    for (let k = -c.height; k < c.width + c.height; k += 22) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k + c.height, c.height);
      g.stroke();
    }
    g.restore();
    return;
  }

  const step = 40;
  const size = 8;
  // tepi kiri dan kanan
  for (let y = pad; y < c.height - footer + 10; y += step) {
    drawDecoItem(g, f.deco, pad / 2, y, size);
    drawDecoItem(g, f.deco, c.width - pad / 2, y, size);
  }
  // tepi atas
  for (let x = pad; x < c.width - pad + 1; x += step) {
    drawDecoItem(g, f.deco, x, pad / 2, size);
  }
  // sisi footer
  for (let x = pad; x < c.width - pad + 1; x += step * 1.5) {
    drawDecoItem(g, f.deco, x, c.height - 10, size * 0.8);
  }
  g.restore();
}

function buildStrip(photos) {
  const f = FRAMES.find((x) => x.id === state.frame) || FRAMES[0];
  const cols = layoutInfo().cols;
  const rows = Math.ceil(photos.length / cols);
  const sw = cols === 2 ? 300 : 360;
  const sh = sw / ASPECT;
  const pad = 28;
  const gap = 16;
  const footer = pad; // strip polos, tidak ada tulisan apa pun
  const c = document.createElement("canvas");
  c.width = pad * 2 + cols * sw + (cols - 1) * gap;
  c.height = pad + rows * sh + (rows - 1) * gap + footer;
  const g = c.getContext("2d");

  g.fillStyle = f.bg;
  g.fillRect(0, 0, c.width, c.height);
  drawFrameDecor(g, c, f, pad, footer);

  photos.forEach((p, i) => {
    const x = pad + (i % cols) * (sw + gap);
    const y = pad + Math.floor(i / cols) * (sh + gap);
    g.drawImage(p, x, y, sw, sh);
    if (f.line) {
      g.strokeStyle = f.line;
      g.lineWidth = 3;
      g.strokeRect(x - 1.5, y - 1.5, sw + 3, sh + 3);
    }
  });

  return c;
}

function downloadStrip() {
  if (!state.stripCanvas) return;
  state.stripCanvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `puzzle-cam-${Date.now()}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

async function finish() {
  setPhase("finished");
  try { await document.fonts.ready; } catch { /* abaikan */ }
  state.stripCanvas = buildStrip(state.saved);
  resultImg.src = state.stripCanvas.toDataURL("image/png");
  resultEl.hidden = false;
  downloadStrip();
}

downloadBtn.addEventListener("click", downloadStrip);

/* ============================================================
   Mulai ulang
   ============================================================ */
function resetAll() {
  if (state.phase === "idle" || state.phase === "loading") return;

  state.saved = [];
  state.photo = null;
  state.order = [];
  state.held = -1;
  state.pinching = false;
  state.fistStart = 0;
  state.stripCanvas = null;
  state.cooldownUntil = performance.now() + 800;
  resetFrameTracking();

  buildSlots();
  updateProgressText();
  resultEl.hidden = true;
  setPhase("frame");
}

resetBtn.addEventListener("click", resetAll);
againBtn.addEventListener("click", resetAll);

/* ============================================================
   Kembali ke pilihan awal (jumlah foto, mode, filter, bingkai)
   ============================================================ */
function goBack() {
  if (state.phase === "idle" || state.phase === "loading") return;

  // foto yang sudah diambil dibuang, karena pilihan bisa mengubah susunan strip
  state.saved = [];
  state.photo = null;
  state.order = [];
  state.held = -1;
  state.pinching = false;
  state.fistStart = 0;
  state.stripCanvas = null;
  state.cooldownUntil = 0;
  state.cursor.seen = false;
  resetFrameTracking();

  buildSlots();
  updateProgressText();
  resultEl.hidden = true;
  startEl.hidden = false;
  startBtn.disabled = false;
  setPhase("idle");
  setMessage("atur dulu pilihannya, lalu tekan mulai lagi");
}

backBtns.forEach((b) => b.addEventListener("click", goBack));

initOptions();