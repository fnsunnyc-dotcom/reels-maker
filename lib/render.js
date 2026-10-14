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
  cute: { name: "귀여운", font: "Jua", weight: 400, size: 78, color: "#ffffff", stroke: "#FF7A59", strokeW: 14, box: null, emph: "#FFD23F", cardBg: ["#FFEDE4", "#FFD3C2"], cardText: "#5b3a2e", accent: "#FF7A59" },
};
export const POSITIONS = { top: 0.32, middle: 0.5, bottom: 0.68 };
const MOTIONS = ["zoomIn", "panLeft", "zoomOut", "panRight"];

const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const back = (t) => { t = Math.min(1, Math.max(0, t)); const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

// ── 장면표 ─────────────────────────────────────────
export function planScenes({ dur, units, map, images, sentences, hookCard, mediaUse = "once", pace = 2.5 }) {
  const ranges = imageRanges(units, map, dur);
  // 첫 화면 글자 카드 (첫 문장, 최대 2.4초, 첫 사진이 1초 이상 보이게)
  let card = null;
  if (hookCard && sentences.length) {
    const first = ranges[0];
    const len = Math.min(2.4, sentences[0].end - 0, Math.max(0, first.b - first.a - 1.0));
    if (len >= 0.8) card = { a: 0, b: len, text: sentences[0].text };
  }
  const scenes = [];
  ranges.forEach((rg, ri) => {
    let a = rg.a;
    if (card && a < card.b) a = card.b;
    if (rg.b - a < 0.05) return;
    const k = mediaUse === "repeat" ? Math.max(1, Math.round((rg.b - a) / pace)) : 1;
    for (let s = 0; s < k; s++) scenes.push({ img: rg.img, rep: s, a: a + ((rg.b - a) * s) / k, b: a + ((rg.b - a) * (s + 1)) / k });
  });
  scenes.forEach((sc, i) => { sc.motion = MOTIONS[i % MOTIONS.length]; sc.variant = sc.rep % 3; });
  return { scenes, card };
}

// ── 그리기 도구 ───────────────────────────────────
function cover(iw, ih, w, h) { const s = Math.max(w / iw, h / ih); return { w: iw * s, h: ih * s }; }
function contain(iw, ih, w, h) { const s = Math.min(w / iw, h / ih); return { w: iw * s, h: ih * s }; }

export async function prepareImages(files, bg) {
  const out = [];
  for (const f of files) {
    const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
    let blurred = null;
    const portrait = bmp.width / bmp.height < 0.6;
    if (!portrait && bg.mode === "blur") {
      const c = new OffscreenCanvas(W / 4, H / 4), x = c.getContext("2d");
      x.filter = "blur(10px) brightness(0.62)";
      const s = cover(bmp.width, bmp.height, W / 4 * 1.25, H / 4 * 1.25);
      x.drawImage(bmp, (W / 4 - s.w) / 2, (H / 4 - s.h) / 2, s.w, s.h);
      blurred = c;
    }
    out.push({ bmp, blurred, portrait });
  }
  return out;
}

function drawImageScene(ctx, im, sc, t, bg) {
  const p = (t - sc.a) / Math.max(0.01, sc.b - sc.a);
  const base = [1, 1.3, 1.3][sc.variant], oy = [0, -0.18, 0.18][sc.variant];
  let s = base, dx = 0, dy = 0;
  if (sc.motion === "zoomIn") s = base * (1 + 0.12 * p);
  else if (sc.motion === "zoomOut") s = base * (1.14 - 0.12 * p);
  else if (sc.motion === "panLeft") { s = base * 1.12; dx = (0.04 - 0.08 * p) * W; }
  else if (sc.motion === "panRight") { s = base * 1.12; dx = (-0.04 + 0.08 * p) * W; }
  dy = oy * H * (s - 1);
  if (im.portrait) {
    const c = cover(im.bmp.width, im.bmp.height, W, H);
    ctx.drawImage(im.bmp, (W - c.w * s) / 2 + dx, (H - c.h * s) / 2 + dy, c.w * s, c.h * s);
  } else {
    if (bg.mode === "blur" && im.blurred) ctx.drawImage(im.blurred, 0, 0, W, H);
    else { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); }
    const c = contain(im.bmp.width, im.bmp.height, W, H);
    ctx.drawImage(im.bmp, (W - c.w * s) / 2 + dx, (H - c.h * s) / 2 + dy, c.w * s, c.h * s);
  }
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
export async function renderReel({ voice, dur, images, plan, chunks, opts, onProgress }) {
  const P = { ...PRESETS[opts.preset] || PRESETS.clean };
  const bg = { mode: opts.bgMode, color: opts.bgColor };
  const capY = H * (POSITIONS[opts.position] ?? 0.68);

  // 글꼴 미리 불러오기 (자막에 쓰이는 글자만)
  const allText = chunks.map((c) => c.words.map((w) => w.text).join(" ")).join(" ") + (plan.card?.text || "") + "0123456789";
  for (const f of [fontOf(P, 80), `900 80px "Pretendard"`]) { try { await document.fonts.load(f, allText); } catch {} }

  // 효과음 자리
  const sfx = [];
  if (opts.useSfx) {
    sfx.push({ kind: "impact", t: 0, vol: 0.5 });
    plan.scenes.forEach((sc, i) => { if (i > 0 && i % 2 === 1) sfx.push({ kind: "whoosh", t: sc.a - 0.12, vol: 0.32 }); });
    let last = -9;
    if (opts.captions) chunks.forEach((c) => { if (c.words.some((w) => w.emphasis) && c.start - last > 2.2) { sfx.push({ kind: "pop", t: c.start, vol: 0.32 }); last = c.start; } });
    sfx.push({ kind: "chime", t: Math.max(0, dur - 1.6), vol: 0.32 });
  }
  onProgress?.(0.02, "소리 합치는 중…");
  const audio = await mixAudio(voice, dur, sfx);

  const vcodec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width: W, height: H });
  const acodec = await getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: 2, sampleRate: 48000 });
  if (!vcodec) throw new Error("이 휴대폰(브라우저)에서는 영상 저장 기능을 쓸 수 없어요. 크롬 최신 버전에서 열어 주세요.");

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const vsrc = new CanvasSource(canvas, { codec: vcodec, bitrate: 6_000_000, keyFrameInterval: 2 });
  output.addVideoTrack(vsrc, { frameRate: FPS });
  let asrc = null;
  if (acodec) { asrc = new AudioBufferSource({ codec: acodec, bitrate: 128_000 }); output.addAudioTrack(asrc); }
  await output.start();

  const total = Math.ceil((dur + 0.4) * FPS);
  const scenes = plan.scenes;
  const TR = 0.25; // 장면 전환(겹치기) 시간
  for (let f = 0; f < total; f++) {
    const t = f / FPS;
    ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    // 사진 장면 (+ 전환: 앞 장면 위에 새 장면이 살짝 확대되며 나타남)
    let idx = scenes.findIndex((s) => t >= s.a && t < s.b);
    if (idx < 0) idx = t >= (scenes.at(-1)?.b ?? 0) ? scenes.length - 1 : 0;
    const sc = scenes[idx];
    if (sc) {
      const into = t - sc.a;
      if (idx > 0 && into < TR) {
        drawImageScene(ctx, images[scenes[idx - 1].img], scenes[idx - 1], t, bg);
        ctx.save(); ctx.globalAlpha = ease(into / TR);
        const z = 1 + 0.06 * (1 - ease(into / TR));
        ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
        drawImageScene(ctx, images[sc.img], sc, t, bg);
        ctx.restore();
      } else drawImageScene(ctx, images[sc.img], sc, t, bg);
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
      const words = (chunks.length ? chunks.filter((c) => c.sentence === 0).flatMap((c) => c.words) : card.text.split(/\s+/).map((x) => ({ text: x })));
      drawTextBlock(ctx, P, words, W / 2, H * 0.46, Math.round(P.size * 1.4), { color: P.cardText, emph: P.emph, stroke: null, box: null, scale: 0.85 + 0.15 * back(t / 0.35), alpha: Math.min(1, t / 0.2) * out, maxW: 900 });
    }
    // 자막 (카드가 보이는 동안은 숨김)
    if (opts.captions && !(card && t < card.b)) {
      const c = chunks.find((k) => t >= k.start && t < k.end);
      if (c) {
        const k = (t - c.start) / 0.14;
        drawTextBlock(ctx, P, c.words, W / 2, capY, P.size, { color: P.color, emph: P.emph, stroke: P.stroke, strokeW: P.strokeW, box: P.box, radius: P.radius, scale: 0.82 + 0.18 * back(k), alpha: Math.min(1, k * 1.5) });
      }
    }
    // 맨 위 진행 바
    if (opts.progressBar) { ctx.fillStyle = P.accent; ctx.fillRect(0, 0, W * Math.min(1, t / dur), 12); }

    await vsrc.add(t, 1 / FPS);
    if (f % 15 === 0) onProgress?.(0.05 + 0.9 * (f / total), `영상 만드는 중… ${Math.round((f / total) * 100)}%`);
  }
  vsrc.close();
  if (asrc) { await asrc.add(audio); asrc.close(); }
  onProgress?.(0.97, "파일로 저장하는 중…");
  await output.finalize();
  return { blob: new Blob([target.buffer], { type: "video/mp4" }), vcodec, acodec };
}
