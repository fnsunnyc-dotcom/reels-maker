// 릴스메이커 모바일 — 모든 작업이 휴대폰 안에서 이뤄져요 (사진·음성이 밖으로 나가지 않음)
import { decodeFile, processVoice, speechPieces } from "./lib/audio.js";
import { tokensToWords, buildCaptions, linesToText, sceneUnits, imageRanges } from "./lib/text.js";
import { buildTimeline, assembleVoice, shiftCaptions } from "./lib/timeline.js";
import { PRESETS, planScenes, renderReel } from "./lib/render.js";

const $ = (s) => document.querySelector(s);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MAX_SEC = 60, SAFE_SEC = 58, MAX_SPEED = 1.6, MAX_IMG = 30;

const DEFAULT = { captions: true, preset: "clean", position: "bottom", bgMode: "blur", bgColor: "#FFFFFF", speed: 1.2, gap: 0.12, motion: "normal", hookCard: true, useSfx: true, progressBar: true };
let opt = { ...DEFAULT };
let S = blank();
function blank() { return { images: [], voiceFile: null, raw: null, asr: null, proc: null, words: [], lines: [], lineTexts: [], slotMap: null, extra: null, busy: false, video: null }; }

// ── 음성 인식 일꾼 ─────────────────────────────
let worker = null, reqId = 0;
function asrWorker() { if (!worker) worker = new Worker("lib/asr-worker.js"); return worker; }
function askWorker(msg, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++reqId, w = asrWorker();
    const h = (e) => {
      const d = e.data;
      if (d.type === "progress") return onProgress?.(d.msg, d.pct);
      if (d.id !== id) return;
      w.removeEventListener("message", h);
      d.type === "error" ? reject(new Error(d.message)) : resolve(d);
    };
    w.addEventListener("message", h);
    w.postMessage({ ...msg, id }, msg.pieces ? msg.pieces.map((p) => p.buffer) : []);
  });
}
async function modelCached() {
  try { const keys = await caches.keys(); for (const k of keys) if (k.startsWith("reels-model-v1")) { const c = await caches.open(k); if ((await c.keys()).length >= 12) return true; } } catch {}
  return false;
}

// ── 1. 사진 ──────────────────────────────────
$("#pickImg").onclick = () => $("#imgInput").click();
$("#imgInput").onchange = async (e) => {
  const files = [...e.target.files].filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  e.target.value = "";
  const room = MAX_IMG - S.images.length;
  if (files.length > room) alert(`사진은 ${MAX_IMG}장까지 넣을 수 있어요. 앞의 ${room}장만 넣을게요.`);
  for (const f of files.slice(0, room)) S.images.push({ file: f, url: await thumbUrl(f) });
  S.slotMap = null; S.extra = null; render();
};
// 미리보기용 작은 사진 (원본을 화면에 그대로 띄우면 사진이 많을 때 휴대폰 메모리가 부족해짐)
async function thumbUrl(f) {
  try {
    const b = await createImageBitmap(f, { imageOrientation: "from-image" });
    const k = Math.min(1, 300 / Math.max(b.width, b.height));
    const c = document.createElement("canvas"); c.width = Math.round(b.width * k); c.height = Math.round(b.height * k);
    c.getContext("2d").drawImage(b, 0, 0, c.width, c.height); b.close();
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
    return URL.createObjectURL(blob);
  } catch { return URL.createObjectURL(f); }
}
function renderThumbs() {
  $("#thumbs").innerHTML = S.images.map((im, i) => `<div class="thumb"><img src="${im.url}" alt=""><span class="no">${i + 1}</span>
    <div class="tools"><button data-mv="${i}" data-d="-1" aria-label="앞으로">◀</button><button data-rm="${i}" aria-label="빼기">✕</button><button data-mv="${i}" data-d="1" aria-label="뒤로">▶</button></div></div>`).join("");
  $("#c1").classList.toggle("done", S.images.length > 0);
}

// ── 2. 음성 분석 ─────────────────────────────
$("#pickVoice").onclick = () => $("#voiceInput").click();
$("#voiceInput").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (!(await modelCached()) && navigator.connection?.type === "cellular" && !confirm("음성 인식 파일(약 230MB)을 처음 한 번 내려받아요. 지금 모바일 데이터를 쓰고 있어요. 계속할까요?")) return;
  S.voiceFile = f; S.raw = null; S.asr = null; S.slotMap = null; S.extra = null; S.lineTexts = [];
  analyze(true);
};
function status(html, pct) {
  const el = $("#voiceStatus"); el.hidden = false;
  el.innerHTML = html + (pct != null ? `<div class="bar"><i style="width:${Math.round(pct * 100)}%"></i></div>` : "");
}
async function analyze(full) {
  if (!S.voiceFile || S.busy) return;
  S.busy = true; render(); hideErr();
  try {
    if (!S.raw) { status(`⏳ <b>${esc(S.voiceFile.name)}</b> 불러오는 중…`); S.raw = await decodeFile(S.voiceFile); }
    // 속도: 1분을 넘으면 자동으로 올림
    let speed = opt.speed, note = "";
    let proc = processVoice(S.raw, { speed, keepGap: opt.gap });
    if (proc.duration > MAX_SEC) {
      speed = Math.min(MAX_SPEED, Math.ceil(((speed * proc.duration) / SAFE_SEC) * 100) / 100);
      proc = processVoice(S.raw, { speed, keepGap: opt.gap });
      note = `1분을 넘지 않도록 ${speed}배속으로 자동 조정했어요.`;
      if (proc.duration > MAX_SEC) throw new Error(`음성이 너무 길어요. ${MAX_SPEED}배속으로도 ${proc.duration.toFixed(1)}초예요. 음성을 1분 10초 안쪽으로 줄여 주세요.`);
    }
    proc.note = note;
    // 음성 인식은 원본에서 한 번만 (속도를 바꿔도 다시 하지 않음)
    if (!S.asr) {
      status("⏳ 음성 인식 준비 중…");
      await navigator.storage?.persist?.().catch(() => {});
      const pieces = await speechPieces(S.raw, proc.map);
      const meta = pieces.map((p) => ({ a: p.a, m: p.m }));
      const r = await askWorker({ type: "decode", pieces: pieces.map((p) => p.samples) }, (msg, pct) => status("⏳ " + esc(msg), pct));
      S.asr = { meta, out: r.out };
    }
    // 인식 결과 시간을 완성 음성 기준으로 옮기기
    const tokens = [];
    S.asr.out.forEach((r, k) => {
      const { a, m } = S.asr.meta[k];
      const toOut = (t) => m.out + (Math.min(Math.max(t, m.a), m.b) - m.a) / proc.speed;
      r.tokens.forEach((t, i) => tokens.push({ t, time: toOut(a + (r.timestamps[i] ?? 0)), groupStart: i === 0 }));
    });
    S.proc = proc;
    S.words = tokensToWords(tokens, proc.segments);
    const cap = buildCaptions(S.words, { maxChars: 12 });
    // 고친 자막은 줄 수가 같으면 그대로 유지 (속도·쉼만 바꾼 경우)
    if (S.lineTexts.length !== cap.lines.length) S.lineTexts = cap.lines.map((l) => l.text);
    S.lines = cap.lines;
    status(`✅ 완성 길이 <b>${proc.duration.toFixed(1)}초</b> <span class="small">· 원본 ${proc.original.toFixed(1)}초에서 무음 ${proc.removed.toFixed(1)}초 제거 · ${proc.speed}배속</span>${note ? `<br><span class="small">${esc(note)}</span>` : ""}${S.words.length ? "" : `<br><span class="small" style="color:var(--warn)">말소리를 받아 적지 못했어요. 자막 없이 만들 수 있어요.</span>`}`);
  } catch (err) {
    status(`⚠ 분석하지 못했어요`);
    showErr(err.message);
  } finally { S.busy = false; render(); }
}

// ── 3. 장면·자막 편집 ───────────────────────
// 자막 한 줄 = 한 칸. 줄마다 나올 사진 번호를 정하고, 사진마다 '쉼 추가'로 말 없이 더 보이게 함
function monotone(map) { map[0] = 0; for (let i = 1; i < map.length; i++) if (map[i] < map[i - 1]) map[i] = map[i - 1]; return map; }
function slotsInfo() {
  if (!S.proc || !S.images.length) return null;
  const N = S.images.length, dur = S.proc.duration;
  const sm = sceneUnits({ words: S.words, segments: S.proc.segments, dur, N, userMap: null });
  if (!S.lines.length) return { slots: sm.units, auto: sm.map, editable: false };
  // 문장 기준 자동 연결을 자막 줄에 옮김 (줄이 시작되는 시각이 속한 사진)
  const rg = imageRanges(sm.units, sm.map, dur);
  const auto = monotone(S.lines.map((l) => { let k = 0; for (const r of rg) if (l.start + 0.15 >= r.a) k = r.img; return k; }));
  return { slots: S.lines, auto, editable: true };
}
function current() {
  const sl = slotsInfo();
  if (!sl) return null;
  const N = S.images.length;
  let map = S.slotMap && S.slotMap.length === sl.slots.length ? monotone(S.slotMap.map((k) => Math.min(N - 1, k))) : sl.auto;
  const used = new Set(map);
  // 줄이 없는 사진은 자동으로 짧은 쉼을 붙여 보여줌 (기본 1.5초, 1분을 넘지 않게 줄임)
  const autoK = S.images.map((_, k) => k).filter((k) => S.extra?.[k] == null && !used.has(k));
  const userSum = S.images.reduce((a, _, k) => a + (S.extra?.[k] ?? 0), 0);
  const room = Math.max(0, SAFE_SEC - S.proc.duration - userSum);
  const autoEx = autoK.length ? Math.max(0.5, Math.min(1.5, Math.floor((room / autoK.length) * 2) / 2)) : 0;
  const extra = S.images.map((_, k) => S.extra?.[k] ?? (used.has(k) ? 0 : autoEx));
  const tl = buildTimeline({ slots: sl.slots, map, extra, N, dur: S.proc.duration, wordEnds: S.words.map((w) => w.end) });
  return { ...sl, map, extra, tl };
}
const EXTRA = [0, 0.5, 1, 1.5, 2, 3, 4, 5];
function renderMap() {
  const cur = current();
  $("#mapEmpty").hidden = !!cur; $("#mapTools").hidden = !cur; $("#tlSum").hidden = !cur;
  $("#c3").classList.toggle("done", !!cur);
  if (!cur) { $("#mapList").innerHTML = ""; return; }
  const { slots, map, extra, tl, editable } = cur, N = S.images.length;
  const groups = S.images.map(() => []);
  map.forEach((k, i) => groups[k].push(i));
  $("#mapList").innerHTML = groups.map((lines, k) => {
    const r = tl.ranges.find((x) => x.img === k);
    const info = r ? `${r.a.toFixed(1)}초부터 · ${(r.b - r.a).toFixed(1)}초 보임${r.extra ? ` (쉼 ${r.extra}초 포함)` : ""}` : "지금은 안 나와요 · 쉼을 추가하면 나와요";
    const exOpts = EXTRA.map((v) => `<option value="${v}" ${Math.abs(v - extra[k]) < 1e-6 ? "selected" : ""}>${v ? "+" + v + "초" : "없음"}</option>`).join("");
    const rows = lines.length ? lines.map((i) => {
      const min = i === 0 ? 0 : map[i - 1];
      const opts = S.images.map((_, j) => (j < min || (i === 0 && j > 0) ? "" : `<option value="${j}" ${j === k ? "selected" : ""}>${j + 1}번</option>`)).join("");
      const t = tl.shift(slots[i].start).toFixed(1);
      const field = editable
        ? `<input data-li="${i}" value="${esc(S.lineTexts[i] ?? "")}" class="${S.lineTexts[i] !== S.lines[i].text ? "edited" : ""}" enterkeyhint="done" autocomplete="off" aria-label="${i + 1}번째 자막">`
        : `<span class="small">말 구간 ${i + 1}</span>`;
      return `<div class="line"><span class="tm">${t}초</span>${field}<select data-mi="${i}" ${i === 0 ? "disabled" : ""} aria-label="이 줄에 나올 사진">${opts}</select></div>`;
    }).join("") : `<div class="nolines">말 없이 쉼 동안만 보여요</div>`;
    return `<div class="grp${r ? "" : " off"}"><div class="ghead"><img src="${S.images[k].url}" alt=""><div class="gt">${k + 1}번 사진<small>${info}</small></div><label>쉼 추가<select data-ex="${k}" aria-label="${k + 1}번 사진 쉼 추가">${exOpts}</select></label></div>${rows}</div>`;
  }).join("");
  const sumEx = extra.reduce((a, v, k) => a + (tl.ranges.some((x) => x.img === k) ? v : 0), 0);
  const over = tl.total > MAX_SEC;
  $("#tlSum").className = "tlsum" + (over ? " over" : "");
  $("#tlSum").innerHTML = `완성 길이 <b>${tl.total.toFixed(1)}초</b> <span class="small">· 말 ${S.proc.duration.toFixed(1)}초${sumEx ? ` + 쉼 ${sumEx.toFixed(1)}초` : ""}</span>` + (over ? `<br>⚠ 1분을 넘어요. 쉼을 줄여 주세요.` : "");
  const unused = S.images.map((_, k) => k).filter((k) => !tl.ranges.some((x) => x.img === k));
  $("#mapInfo").innerHTML = (S.slotMap || S.extra ? "직접 고친 연결 · " : "자동 연결 · ") + (unused.length ? `<span style="color:var(--warn)">⚠ 안 나오는 사진: ${unused.map((k) => k + 1 + "번").join(", ")}</span>` : "모든 사진이 순서대로 나와요");
}
document.addEventListener("input", (e) => {
  const inp = e.target.closest("input[data-li]");
  if (!inp) return;
  const i = +inp.dataset.li;
  S.lineTexts[i] = inp.value;
  inp.classList.toggle("edited", inp.value !== S.lines[i].text);
});
document.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-mi]"), ex = e.target.closest("select[data-ex]");
  if (sel) {
    const cur = current(), i = +sel.dataset.mi, v = +sel.value, map = [...cur.map], old = map[i];
    map[i] = v;
    for (let k = i + 1; k < map.length; k++) { if (map[k] < map[k - 1]) map[k] = map[k - 1]; else if (v > old && map[k] === old) map[k] = v; }
    S.slotMap = map; renderMap();
  }
  if (ex) { const cur = current(); S.extra = [...cur.extra]; S.extra[+ex.dataset.ex] = parseFloat(ex.value); renderMap(); }
});
$("#mapAuto").onclick = () => { S.slotMap = null; S.extra = null; renderMap(); };
$("#capReset").onclick = () => { if (S.lines.length && confirm("고친 자막을 모두 처음 받아 적은 대로 되돌릴까요?")) { S.lineTexts = S.lines.map((l) => l.text); renderMap(); } };

// 고친 글자를 그 줄의 시간 안에 다시 배치 (빈 칸이면 그 줄 자막 없음)
function retext(c, text, orig) {
  if (text === orig) return c;
  if (!text || !text.trim()) return null;
  let emph = false;
  const ws = text.trim().split(/\s+/).map((w) => {
    const marks = (w.match(/\*\*/g) || []).length;
    const o = { text: w.replace(/\*\*/g, ""), emphasis: emph || marks > 0 };
    if (marks % 2) emph = !emph;
    return o;
  }).filter((w) => w.text);
  if (!ws.length) return null;
  const tot = ws.reduce((a, w) => a + w.text.length, 0);
  let p = 0;
  return { ...c, words: ws.map((w) => { const st = c.start + (p / tot) * (c.end - c.start); p += w.text.length; return { ...w, start: st, end: c.start + (p / tot) * (c.end - c.start) }; }) };
}

// ── 5. 스타일·설정 ───────────────────────────
function presetSample(c, P) {
  const x = c.getContext("2d"), w = c.width, h = c.height;
  x.clearRect(0, 0, w, h);
  x.font = `${P.weight} ${Math.round(P.size * 0.5)}px "${P.font}", "Pretendard", sans-serif`;
  x.textAlign = "center"; x.textBaseline = "middle"; x.lineJoin = "round";
  const t1 = "정리 ", t2 = "10분", w1 = x.measureText(t1).width, w2 = x.measureText(t2).width, sx = w / 2 - (w1 + w2) / 2;
  if (P.box) { x.fillStyle = P.box; x.beginPath(); x.roundRect(sx - 14, h / 2 - P.size * 0.36, w1 + w2 + 28, P.size * 0.72, (P.radius ?? 20) / 2); x.fill(); }
  x.textAlign = "left";
  [[t1, P.color, sx], [t2, P.emph, sx + w1]].forEach(([t, col, px]) => { if (P.stroke) { x.strokeStyle = P.stroke; x.lineWidth = P.strokeW; x.strokeText(t, px, h / 2); } x.fillStyle = col; x.fillText(t, px, h / 2); });
}
function renderPresets() {
  if (!$("#presets").children.length) {
    $("#presets").innerHTML = Object.entries(PRESETS).map(([k, P]) => `<button class="preset" data-preset="${k}"><canvas width="320" height="110"></canvas><span>${P.name}</span></button>`).join("");
    document.fonts.ready.then(() => Promise.all(Object.values(PRESETS).map((P) => document.fonts.load(`${P.weight} 40px "${P.font}"`, "정리 10분").catch(() => {})))).then(() =>
      document.querySelectorAll(".preset").forEach((b) => presetSample(b.querySelector("canvas"), PRESETS[b.dataset.preset])));
  }
  document.querySelectorAll(".preset").forEach((b) => b.setAttribute("aria-pressed", b.dataset.preset === opt.preset));
  document.querySelectorAll("#pos button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === opt.position));
  document.querySelectorAll("#bgMode button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.bg === opt.bgMode));
  document.querySelectorAll("#capToggle button").forEach((b) => b.setAttribute("aria-pressed", (b.dataset.cap === "on") === opt.captions));
  const SW = ["#FFFFFF", "#000000", "#F5EFE6", "#1D2420", "#F2C6C2", "#DCEBE5"];
  $("#bgColors").innerHTML = opt.bgMode === "color" ? SW.map((c) => `<button class="sw" data-sw="${c}" style="background:${c}" aria-pressed="${opt.bgColor === c}" aria-label="${c}"></button>`).join("") : "";
}
for (const id of ["hookCard", "useSfx", "progressBar"]) $("#" + id).onchange = (e) => (opt[id] = e.target.checked);
$("#motion").onchange = (e) => (opt.motion = e.target.value);
$("#speed").onchange = (e) => { opt.speed = parseFloat(e.target.value); if (S.raw) analyze(); };
$("#gap").onchange = (e) => { opt.gap = parseFloat(e.target.value); if (S.raw) analyze(); };

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.mv) { const i = +t.dataset.mv, j = i + +t.dataset.d; if (j >= 0 && j < S.images.length) { [S.images[i], S.images[j]] = [S.images[j], S.images[i]]; S.slotMap = null; S.extra = null; render(); } }
  if (t.dataset.rm) { const [im] = S.images.splice(+t.dataset.rm, 1); URL.revokeObjectURL(im.url); S.slotMap = null; S.extra = null; render(); }
  if (t.dataset.preset) { opt.preset = t.dataset.preset; renderPresets(); }
  if (t.dataset.v) { opt.position = t.dataset.v; renderPresets(); }
  if (t.dataset.bg) { opt.bgMode = t.dataset.bg; renderPresets(); }
  if (t.dataset.sw) { opt.bgColor = t.dataset.sw; renderPresets(); }
  if (t.dataset.cap) { opt.captions = t.dataset.cap === "on"; renderPresets(); }
});

// ── 만들기 ───────────────────────────────────
$("#make").onclick = async () => {
  if (S.busy) return;
  S.busy = true; render(); hideErr();
  $("#result").hidden = true; $("#makeBar").hidden = false;
  const prog = (p, msg) => { $("#makeFill").style.width = Math.round(p * 100) + "%"; $("#make").textContent = msg; };
  try {
    prog(0.01, "준비 중…");
    const cur = current();
    if (cur.tl.total > MAX_SEC) {
      const e = new Error(`완성 길이가 ${cur.tl.total.toFixed(1)}초라서 1분을 넘어요.\n3번 '장면·자막 편집'에서 사진별 '쉼 추가'를 줄이거나, 말 없이 쉼으로만 나오는 사진을 줄여 주세요.`);
      e.plain = true; throw e;
    }
    let chunks = [], sentences = [];
    if (S.words.length) {
      const base = buildCaptions(S.words, { maxChars: 12 });
      sentences = base.sentences;
      chunks = base.chunks.map((c, i) => retext(c, S.lineTexts[i], S.lines[i]?.text)).filter(Boolean);
    }
    const sh = shiftCaptions(chunks, sentences, cur.tl);
    const voice = assembleVoice(S.proc.samples, cur.tl.pieces, cur.tl.total);
    const plan = planScenes({ ranges: cur.tl.ranges, sentences: sh.sentences, hookCard: opt.hookCard && sh.chunks.some((c) => c.sentence === 0), motion: opt.motion });
    // 앞에서 만든 영상을 먼저 비워서 휴대폰 영상 기능·메모리를 돌려놓기 (다시 만들기 오류 방지)
    releaseVideo();
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    const job = { voice, dur: cur.tl.total, files: S.images.map((x) => x.file), plan, chunks: sh.chunks, opts: { ...opt }, onProgress: prog };
    let r;
    try { r = await renderReel(job); }
    catch (e1) { // 한 번 더 자동으로 시도
      console.warn("retry", e1);
      prog(0.01, "다시 시도하는 중…");
      await new Promise((res) => setTimeout(res, 1200));
      r = await renderReel(job);
    }
    const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
    S.video = { blob: r.blob, url: URL.createObjectURL(r.blob), name: `릴스_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.mp4` };
    $("#outVideo").src = S.video.url;
    const okCodec = r.vcodec === "avc" && r.acodec === "aac";
    $("#outInfo").innerHTML = `${cur.tl.total.toFixed(1)}초 · ${(r.blob.size / 1048576).toFixed(1)}MB · 만드는 데 ${Math.round((performance.now() - t0) / 1000)}초` +
      (okCodec ? "" : `<br><span style="color:var(--warn)">이 휴대폰은 일반 영상 형식(H.264/AAC)으로 저장하지 못해 다른 형식(${r.vcodec}/${r.acodec || "소리 없음"})으로 저장했어요. 인스타그램에 올라가지 않으면 알려 주세요.</span>`);
    $("#result").hidden = false;
    $("#shareBtn").hidden = !(navigator.canShare && navigator.canShare({ files: [new File([r.blob], S.video.name, { type: "video/mp4" })] }));
    $("#result").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    console.error(err);
    if (err.plain) showErr(err.message); else showErr("영상을 만들지 못했어요.\n" + (err.message || err) + "\n\n· 다른 앱을 닫고 다시 눌러 보세요.\n· 계속 안 되면 [새 작업] 없이 페이지를 새로고침한 뒤 다시 넣어 주세요.");
  } finally { S.busy = false; $("#makeBar").hidden = true; render(); }
};
function releaseVideo() {
  const v = $("#outVideo");
  try { v.pause(); v.removeAttribute("src"); v.load(); } catch {}
  if (S.video) { URL.revokeObjectURL(S.video.url); S.video = null; }
}
$("#saveBtn").onclick = () => { const a = document.createElement("a"); a.href = S.video.url; a.download = S.video.name; document.body.appendChild(a); a.click(); a.remove(); };
$("#shareBtn").onclick = async () => { try { await navigator.share({ files: [new File([S.video.blob], S.video.name, { type: "video/mp4" })], title: "릴스" }); } catch {} };

// ── 새 작업 ──────────────────────────────────
$("#newJob").onclick = () => {
  if (S.busy) return alert("만드는 중에는 새 작업을 시작할 수 없어요.");
  if (!confirm("새 작업을 시작할까요?\n넣은 사진·음성·자막·설정이 모두 처음 상태로 돌아가요.")) return;
  S.images.forEach((x) => URL.revokeObjectURL(x.url));
  releaseVideo();
  S = blank(); opt = { ...DEFAULT };
  $("#voiceStatus").hidden = true; $("#result").hidden = true; hideErr();
  $("#speed").value = "1.2"; $("#gap").value = "0.12"; $("#motion").value = "normal";
  for (const id of ["hookCard", "useSfx", "progressBar"]) $("#" + id).checked = true;
  render(); window.scrollTo({ top: 0, behavior: "smooth" });
};

function showErr(m) { $("#err").hidden = false; $("#err").textContent = m; }
function hideErr() { $("#err").hidden = true; }

function render() {
  renderThumbs(); renderMap(); renderPresets();
  $("#c2").classList.toggle("done", !!S.proc);
  const need = [];
  if (!S.images.length) need.push("사진");
  if (!S.proc) need.push("음성");
  $("#need").textContent = need.length ? `아직 없는 것: ${need.join(" · ")}` : "";
  $("#make").disabled = need.length > 0 || S.busy;
  if (!S.busy) $("#make").textContent = "릴스 만들기";
  $("#newJob").disabled = S.busy;
  $("#pickVoice").disabled = S.busy;
}

// 첫 사용 안내 + 홈 화면에 추가(오프라인 화면 저장)
modelCached().then((c) => ($("#modelNote").hidden = c));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
window.__reels = { get S() { return S; }, opt }; // 점검용
