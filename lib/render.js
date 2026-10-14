// 휴대폰 안에서 영상 만들기: 캔버스에 한 장면씩 그리고 → 휴대폰 영상 기능(WebCodecs)으로 MP4 저장
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec } from "../vendor/mediabunny.min.mjs";
import { imageRanges } from "./text.js";

export const W = 1080, H = 1920, FPS = 30;

export const PRESETS = {
  clean: { name: "깔끔 굵게", font: "Pretendard", weight: 800, size: 74, color: "#ffffff", stroke: "#000000", strokeW: 14, box: null, emph: "#FFE14D", cardBg: ["#232b3d", "#11151f"], cardText: "#ffffff", accent: "#FFE14D" },
  box: { name: "박스 자막", font: "Pretendard", weight: 700, size: 60, color: "#ffffff", stroke: null, strokeW: 0, box: "rgba(0,0,0,0.74)", radius: 22, emph: "#7CF0D6", cardBg: ["#f7f2ea", "#ece2d3"], cardText: "#2a2622", accent: "#0f9d7f" },
  variety: { name: "예능 노랑", font: "Do Hyeon", weight: 400, size: 94, color: "#FFE14D", stroke: "#000000", strokeW: 16, box: null, emph: "#FF5A5A", cardBg: ["#FFE14D", "#F5C400"], cardText: "#111111", accent: "#FFE14D" },
  highlight: { name: "형광펜", font: "Pretendard", weight: 800, size: 62, color: "#111111", stroke: null, strokeW: 0, box: "#FFF06A", radius: 6, emph: "#E03131", cardBg: ["#FFFDF2", "#FFF3B8"], cardText: "#111111", accent: "#F5C400" },
  impact: { name: "임팩트", font: "Black Han Sans", weight: 400, size: 90, color: "#ffffff", stroke: "#000000", strokeW: 16, box: null, emph: "#FFD400", cardBg: ["#ff4b3a", "#c9281b"], cardText: "#ffffff", accent: "#FFD400" },
  handwrite: { name: "손글씨", font: "Nanum Pen Script", weight: 400, size: 112, color: "#ffffff", stroke: "#1D2420", strokeW: 11, box: null, emph: "#FFE14D", cardBg: ["#FBF7EF", "#F1E8D6"], cardText: "#3B3026", accent: "#E06D3C" },
  memo: { name: "손글씨 메모", font: "Nanum Pen Script", weight: 400, size: 100, color: "#3B3026", stroke: null, strokeW: 0, box: "rgba(255,250,238,0.94)", radius: 14, emph: "#E06D3C", cardBg: ["#FFF8E8", "#F3E6C9"], cardText: "#3B3026", accent: "#E06D3C" },
  cute: { name: "귀여운", font: "Jua", weight: 400, size: 78, color: "#ffffff", stroke: "#FF7A59", strokeW: 14, box: null, emph: "#FFD23F", cardBg: ["#FFEDE4", "#FFD3C2"], cardText: "#5b3a2e", accent: "#FF7A59" },
};
export const POSITIONS = { top: 0.32, middle: 0.5, bottom: 0.68 };

const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const easeIO = (t) => { t = Math.min(1, Math.max(0, t)); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const back = (t) => { t = Math.min(1, Math.max(0, t)); const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const lerp = (r, p) => (r ? r[0] + (r[1] - r[0]) * p : 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 카메라 움직임 9가지 (s=확대, x·y=이동(화면 비율), r=회전(도))
const MOVES = [
  { s: [1.0, 1.22] },                                  // 다가가기
  { s: [1.2, 1.2], x: [0.08, -0.08] },                 // 왼쪽으로 훑기
  { s: [1.26, 1.02] },                                 // 물러나기
  { s: [1.2, 1.2], y: [0.08, -0.08] },                 // 위로 올라가기
  { s: [1.04, 1.26], x: [-0.06, 0.05], y: [0.05, -0.04] }, // 대각선으로 다가가기
  { s: [1.2, 1.2], x: [-0.08, 0.08] },                 // 오른쪽으로 훑기
  { s: [1.12, 1.26], r: [-2.2, 1.2] },                 // 살짝 돌며 다가가기
  { s: [1.2, 1.2], y: [-0.08, 0.08] },                 // 아래로 내려가기
  { s: [1.32, 1.06], x: [0.06, 0], y: [-0.06, 0] },    // 구석에서 전체로
];
const TRANS = ["zoom", "slideL", "flash", "slideU", "whip"];
const PACE = { calm: { pace: 4.2, amp: 0.65 }, normal: { pace: 3.0, amp: 0.85 }, dynamic: { pace: 2.2, amp: 1 } };

// ── 장면표 ─────────────────────────────────────────
// 사진 하나가 길게 나오면 그 안에서 구도(확대·위치)를 바꿔 여러 컷으로 나눔 → 정지화면처럼 보이지 않게
export function planScenes({ dur, units, map, sentences, hookCard, motion = "dynamic" }) {
  const M = PACE[motion] || PACE.dynamic;
  const ranges = imageRanges(units, map, dur);
  let card = null;
  if (hookCard && sentences.length) {
    const first = ranges[0];
    const len = Math.min(2.4, sentences[0].end - 0, Math.max(0, first.b - first.a - 1.0));
    if (len >= 0.8) card = { a: 0, b: len, text: sentences[0].text };
  }
  const scenes = [];
  let g = 0, photo = 0;
  ranges.forEach((rg) => {
    let a = rg.a;
    if (card && a < card.b) a = card.b;
    const len = rg.b - a;
    if (len < 0.05) return;
    let k = Math.max(1, Math.round(len / M.pace));
    k = Math.max(1, Math.min(k, Math.floor(len / 1.3)));
    for (let s = 0; s < k; s++) {
      scenes.push({
        img: rg.img, sub: s, a: a + (len * s) / k, b: a + (len * (s + 1)) / k,
        move: (g * 4 + photo) % MOVES.length,
        zoomBase: s === 0 ? 1 : [1.18, 1.1, 1.24][s % 3],
        focus: s === 0 ? 0 : [-0.8, 0.8, -0.4, 0.5][s % 4],
        trans: scenes.length === 0 ? "none" : s > 0 ? "cut" : TRANS[photo % TRANS.length],
      });
      g++;
    }
    photo++;
  });
  return { scenes, card, amp: M.amp };
}

// ── 사진 불러오기 (필요한 사진만 그때그때 작게 줄여서 → 사진이 많아도 메모리 부족 없이) ──
function cover(iw, ih, w, h) { const s = Math.max(w / iw, h / ih); return { w: iw * s, h: ih * s }; }
function contain(iw, ih, w, h) { const s = Math.min(w / iw, h / ih); return { w: iw * s, h: ih * s }; }

export function imageLoader(files, bg) {
  const cache = new Map();
  async function load(i) {
    const full = await createImageBitmap(files[i], { imageOrientation: "from-image" });
    const iw = full.width, ih = full.height, portrait = iw / ih < 0.6;
    const fit = portrait ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
    const k = Math.min(1, fit * 1.35);
    let bmp = full;
    if (k < 0.98) { bmp = await createImageBitmap(full, { resizeWidth: Math.round(iw * k), resizeHeight: Math.round(ih * k), resizeQuality: "high" }); full.close(); }
    let blurred = null;
    if (!portrait && bg.mode === "blur") {
      const c = new OffscreenCanvas(W / 4, H / 4), x = c.getContext("2d");
      x.filter = "blur(10px) brightness(0.62)";
      const s = cover(bmp.width, bmp.height, W / 4 * 1.25, H / 4 * 1.25);
      x.drawImage(bmp, (W / 4 - s.w) / 2, (H / 4 - s.h) / 2, s.w, s.h);
      blurred = c;
    }
    return { bmp, blurred, portrait };
  }
  return {
    get(i) { if (!cache.has(i)) cache.set(i, load(i)); return cache.get(i); },
    keep(set) { for (const [i, pr] of cache) if (!set.has(i)) { cache.delete(i); pr.then((im) => im.bmp.close()).catch(() => {}); } },
    closeAll() { this.keep(new Set()); },
  };
}

function drawImageScene(ctx, im, sc, t, bg, amp) {
  const len = Math.max(0.01, sc.b - sc.a), into = t - sc.a;
  const p = clamp(into / len, 0, 1.15);
  const mv = MOVES[sc.move];
  let s = (1 + (lerp(mv.s, p) - 1) * amp) * sc.zoomBase;
  if (sc.trans === "cut" || sc.trans === "flash") s *= 1 + 0.09 * (1 - ease(into / 0.32)); // 컷이 바뀔 때 '툭' 다가오는 느낌
  const r = (lerp(mv.r, p) * amp * Math.PI) / 180;
  // 돌릴 때 모서리가 비지 않도록 필요한 만큼 확대
  const need = Math.cos(Math.abs(r)) + (H / W) * Math.sin(Math.abs(r));
  if (im.portrait && s < need) s = need;
  const room = Math.max(0, (s - (im.portrait ? need : 1)) / 2) * 0.92;
  const x = clamp(lerp(mv.x, p) * amp, -room, room);
  const y = clamp(lerp(mv.y, p) * amp + sc.focus * room, -room, room);
  if (!im.portrait) {
    if (bg.mode === "blur" && im.blurred) ctx.drawImage(im.blurred, 0, 0, W, H);
    else { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); }
  }
  const c = im.portrait ? cover(im.bmp.width, im.bmp.height, W, H) : contain(im.bmp.width, im.bmp.height, W, H);
  ctx.save();
  ctx.translate(W / 2 + x * W, H / 2 + y * H);
  if (r) ctx.rotate(r);
  ctx.scale(s, s);
  ctx.drawImage(im.bmp, -c.w / 2, -c.h / 2, c.w, c.h);
  ctx.restore();
}

function fontOf(P, size, weight) { return `${weight || P.weight} ${size}px "${P.font}", "Pretendard", sans-serif`; }

// 단어 목록을 maxW 안에서 줄바꿈
function layoutWords(ctx, words, maxW) {
  const lines = [[]];
  let w = 0;
  const sp = ctx.measureText(" ").width;
  for (const word of words) {
    const ww = ctx.measureText(word.text).width;
    if (lines.at(-1).length && w + sp + ww > maxW) { lines.push([]); w = 0; }
    if (lines.at(-1).length) w += sp;
    lines.at(-1).push({ ...word, w: ww });
    w += ww;
  }
  return lines.map((l) => ({ words: l, width: l.reduce((a, x) => a + x.w, 0) + sp * Math.max(0, l.length - 1) }));
}

function drawTextBlock(ctx, P, words, cx, cy, size, { color, emph, stroke, strokeW, box, radius, scale = 1, alpha = 1, maxW = 940 }) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy); ctx.scale(scale, scale);
  ctx.font = fontOf(P, size);
  ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  const lines = layoutWords(ctx, words, maxW);
  const lh = size * 1.3, total = lh * lines.length;
  const sp = ctx.measureText(" ").width;
  lines.forEach((ln, i) => {
    const y = -total / 2 + lh * (i + 0.5);
    let x = -ln.width / 2;
    if (box) {
      const px = 30 * (size / 60), py = 12 * (size / 60);
      ctx.fillStyle = box;
      ctx.beginPath();
      ctx.roundRect(x - px, y - lh / 2 - py * 0.2, ln.width + px * 2, lh + py * 0.4, radius ?? 20);
      ctx.fill();
    }
    for (const wd of ln.words) {
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = strokeW * 2; ctx.strokeText(wd.text, x, y); }
      ctx.fillStyle = wd.emphasis ? emph : color;
      ctx.fillText(wd.text, x, y);
      x += wd.w + sp;
    }
  });
  ctx.restore();
}

// ── 효과음 (프로그램이 직접 만드는 소리) ─────────────────
function synthSfx(ctx, kind, t, vol) {
  const g = ctx.createGain(); g.connect(ctx.destination);
  const env = (a, d) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  if (kind === "whoosh") {
    const n = ctx.createBufferSource(), len = ctx.sampleRate * 0.5, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    n.buffer = b;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 1.2;
    f.frequency.setValueAtTime(500, t); f.frequency.exponentialRampToValueAtTime(3500, t + 0.35);
    n.connect(f); f.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.15); g.gain.linearRampToValueAtTime(0, t + 0.45);
    n.start(t); n.stop(t + 0.5);
    return;
  }
  const o = ctx.createOscillator(); o.connect(g);
  if (kind === "pop") { o.type = "sine"; o.frequency.setValueAtTime(700, t); o.frequency.exponentialRampToValueAtTime(260, t + 0.12); env(0.004, 0.14); o.start(t); o.stop(t + 0.2); }
  else if (kind === "impact") { o.type = "sine"; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.6); env(0.005, 0.7); o.start(t); o.stop(t + 0.8); }
  else if (kind === "chime") {
    [1047, 1319, 1568].forEach((f, i) => {
      const oo = ctx.createOscillator(), gg = ctx.createGain(); oo.frequency.value = f; oo.connect(gg); gg.connect(ctx.destination);
      const tt = t + i * 0.11; gg.gain.setValueAtTime(0, tt); gg.gain.linearRampToValueAtTime(vol * 0.8, tt + 0.005); gg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.9);
      oo.start(tt); oo.stop(tt + 1);
    });
  }
}

async function mixAudio(voice, dur, sfxEvents) {
  const SR = 48000, len = Math.ceil((dur + 0.4) * SR);
  const ctx = new OfflineAudioContext(2, len, SR);
  const vb = ctx.createBuffer(1, voice.length, SR); vb.copyToChannel(voice, 0);
  const vs = ctx.createBufferSource(); vs.buffer = vb; vs.connect(ctx.destination); vs.start(0);
  for (const e of sfxEvents) synthSfx(ctx, e.kind, Math.max(0, e.t), e.vol);
  return ctx.startRendering();
}

// ── 영상 만들기 ──────────────────────────────────
export async function renderReel({ voice, dur, files, plan, chunks, opts, onProgress }) {
  const P = { ...PRESETS[opts.preset] || PRESETS.clean };
  const bg = { mode: opts.bgMode, color: opts.bgColor };
  const capY = H * (POSITIONS[opts.position] ?? 0.68);
  const amp = plan.amp ?? 1;

  // 글꼴 미리 불러오기 (자막에 쓰이는 글자만)
  const allText = chunks.map((c) => c.words.map((w) => w.text).join(" ")).join(" ") + (plan.card?.text || "") + "0123456789";
  for (const f of [fontOf(P, 80), `900 80px "Pretendard"`]) { try { await document.fonts.load(f, allText); } catch {} }

  const scenes = plan.scenes;
  // 강조 단어가 나올 때 화면이 살짝 '쿵' 다가옴
  const pulses = [];
  let lastPulse = -9;
  for (const c of chunks) if (c.words.some((w) => w.emphasis) && c.start - lastPulse > 1.2) { pulses.push(c.start); lastPulse = c.start; }

  // 효과음 자리 (사진이 바뀔 때만 휙, 같은 사진 안의 컷 변화에는 넣지 않음)
  const sfx = [];
  if (opts.useSfx) {
    sfx.push({ kind: "impact", t: 0, vol: 0.5 });
    let lw = -9;
    scenes.forEach((sc) => {
      if (sc.trans === "none" || sc.trans === "cut") return;
      if (sc.a - lw < 1.6) return;
      sfx.push({ kind: sc.trans === "flash" ? "pop" : "whoosh", t: sc.a - (sc.trans === "flash" ? 0 : 0.12), vol: sc.trans === "zoom" ? 0.22 : 0.32 });
      lw = sc.a;
    });
    let last = -9;
    if (opts.captions) chunks.forEach((c) => { if (c.words.some((w) => w.emphasis) && c.start - last > 2.2) { sfx.push({ kind: "pop", t: c.start, vol: 0.28 }); last = c.start; } });
    sfx.push({ kind: "chime", t: Math.max(0, dur - 1.6), vol: 0.32 });
  }
  onProgress?.(0.02, "소리 합치는 중…");
  const audio = await mixAudio(voice, dur, sfx);

  const vcodec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width: W, height: H });
  const acodec = await getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: 2, sampleRate: 48000 });
  if (!vcodec) throw new Error("이 휴대폰(브라우저)에서는 영상 저장 기능을 쓸 수 없어요. 크롬 최신 버전에서 열어 주세요.");

  const loader = imageLoader(files, bg);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  let finished = false;
  try {
    const vsrc = new CanvasSource(canvas, { codec: vcodec, bitrate: 6_000_000, keyFrameInterval: 2 });
    output.addVideoTrack(vsrc, { frameRate: FPS });
    let asrc = null;
    if (acodec) { asrc = new AudioBufferSource({ codec: acodec, bitrate: 128_000 }); output.addAudioTrack(asrc); }
    await output.start();

    const total = Math.ceil((dur + 0.4) * FPS);
    let idx = 0;
    for (let f = 0; f < total; f++) {
      const t = f / FPS;
      while (idx < scenes.length - 1 && t >= scenes[idx].b) idx++;
      const sc = scenes[idx], prev = scenes[idx - 1], next = scenes[idx + 1];
      // 지금·앞·다음 사진만 메모리에 두기
      const need = new Set([sc?.img, prev?.img, next?.img].filter((v) => v != null));
      loader.keep(need);
      if (next) loader.get(next.img);

      ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
      if (sc) {
        // 강조 순간 '쿵'
        let pz = 1;
        for (const pt of pulses) { const k = (t - pt) / 0.45; if (k >= 0 && k < 1) pz = Math.max(pz, 1 + 0.045 * amp * Math.sin(Math.PI * k) * (1 - 0.4 * k)); }
        ctx.save();
        if (pz > 1) { ctx.translate(W / 2, H / 2); ctx.scale(pz, pz); ctx.translate(-W / 2, -H / 2); }
        const im = await loader.get(sc.img);
        const into = t - sc.a, TR = 0.32;
        const e = easeIO(into / TR);
        if (prev && into >= 0 && into < TR && sc.trans !== "cut" && sc.trans !== "flash") {
          const pim = await loader.get(prev.img);
          const drawAt = (img, scene, tx, ty, sz, alpha) => {
            ctx.save(); ctx.globalAlpha = alpha;
            ctx.translate(W / 2 + tx, H / 2 + ty); ctx.scale(sz, sz); ctx.translate(-W / 2, -H / 2);
            drawImageScene(ctx, img, scene, t, bg, amp); ctx.restore();
          };
          if (sc.trans === "slideL") { drawAt(pim, prev, -W * e, 0, 1, 1); drawAt(im, sc, W * (1 - e), 0, 1, 1); }
          else if (sc.trans === "slideU") { drawAt(pim, prev, 0, -H * e * 0.35, 1, 1 - e); drawAt(im, sc, 0, H * (1 - e), 1, 1); }
          else if (sc.trans === "whip") { drawAt(im, sc, 0, 0, 1.15 - 0.15 * e, 1); drawAt(pim, prev, 0, 0, 1 + 0.35 * e, 1 - e); }
          else { drawAt(pim, prev, 0, 0, 1, 1); drawAt(im, sc, 0, 0, 1 + 0.08 * (1 - e), e); }
        } else drawImageScene(ctx, im, sc, t, bg, amp);
        ctx.restore();
        if (sc.trans === "flash" && into >= 0 && into < 0.22) { ctx.fillStyle = `rgba(255,255,255,${(0.85 * (1 - into / 0.22)).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
      }
      // 첫 화면 글자 카드
      const card = plan.card;
      if (card && t < card.b + 0.2) {
        const out = t > card.b ? 1 - (t - card.b) / 0.2 : 1;
        ctx.save(); ctx.globalAlpha = out;
        const gr = ctx.createLinearGradient(0, 0, W * 0.6, H);
        gr.addColorStop(0, P.cardBg[0]); gr.addColorStop(1, P.cardBg[1]);
        ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
        ctx.restore();
        const words = (chunks.length ? chunks.filter((c) => c.sentence === 0).flatMap((c) => c.words) : []);
        const ws = words.length ? words : card.text.split(/\s+/).map((x) => ({ text: x }));
        drawTextBlock(ctx, P, ws, W / 2, H * 0.46, Math.round(P.size * 1.4), { color: P.cardText, emph: P.emph, stroke: null, box: null, scale: 0.85 + 0.15 * back(t / 0.35), alpha: Math.min(1, t / 0.2) * out, maxW: 900 });
      }
      // 자막 (카드가 보이는 동안은 숨김)
      if (opts.captions && !(card && t < card.b)) {
        const c = chunks.find((k) => t >= k.start && t < k.end);
        if (c) {
          const k = (t - c.start) / 0.14;
          drawTextBlock(ctx, P, c.words, W / 2, capY, P.size, { color: P.color, emph: P.emph, stroke: P.stroke, strokeW: P.strokeW, box: P.box, radius: P.radius, scale: 0.82 + 0.18 * back(k), alpha: Math.min(1, k * 1.5) });
        }
      }
      if (opts.progressBar) { ctx.fillStyle = P.accent; ctx.fillRect(0, 0, W * Math.min(1, t / dur), 12); }

      await vsrc.add(t, 1 / FPS);
      if (f % 15 === 0) onProgress?.(0.05 + 0.9 * (f / total), `영상 만드는 중… ${Math.round((f / total) * 100)}%`);
    }
    vsrc.close();
    if (asrc) { await asrc.add(audio); asrc.close(); }
    onProgress?.(0.97, "파일로 저장하는 중…");
    await output.finalize();
    finished = true;
    return { blob: new Blob([target.buffer], { type: "video/mp4" }), vcodec, acodec };
  } finally {
    loader.closeAll();
    if (!finished) { try { await output.cancel(); } catch {} } // 실패해도 영상 기능을 꼭 돌려놓기 (다음 만들기 오류 방지)
  }
}
