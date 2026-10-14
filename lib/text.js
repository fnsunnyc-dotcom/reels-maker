// 자막·문장·장면 맞추기 (PC판 릴스메이커와 같은 규칙)
export const r3 = (n) => Math.round(n * 1000) / 1000;
const PUNCT = /^[.,?!。，？！…~]+$/;
const ATTACH = new Set("을 를 이 가 은 는 의 에 도 만 면 야 요 서 고 다 로 지 죠 네 게 와 과 랑 며 니 데 든 나 까 라 자 요 면서 에서 으로 까지 부터 처럼 보다 하고 이랑 이나 에게 한테 께서 마다 밖에 이다 입니다 예요 이에요 해요 했어요 어요 아요 습니다 니다 세요 해 했 요.".split(" "));
const SOLO = new Set("그 이 저 안 못 잘 꼭 더 또 왜 집 옷 책 물 밥 눈 손 몸 첫 한 두 세 네 것 걸 거 게 데 때 좀 참 곧 늘 막 뭐 뭘 난 넌 날 널 일 삼 사 오 육 칠 팔 구 십 백 천 만 몇 각 새 온 맨 및 즉 단 약 총 꽤 다 딱 쭉 확 툭 쏙".split(" "));

// 음성 인식 토큰(시간 포함) → 단어 (한국어 띄어쓰기 보정)
export function tokensToWords(tokens, segments) {
  // 토큰 → 단어. 모델이 띄어쓰기를 들쭉날쭉하게 내놓아서 한국어 규칙으로 보정
  const words = [];
  for (const tk of tokens) {
    const txt = tk.t.replace(/▁/g, " ");
    const x = txt.trim();
    if (!x) continue;
    const prev = words.at(-1);
    if (PUNCT.test(x)) { if (prev) { prev.text += x; if (/[.?!。？！]/.test(x)) prev.end_of_sentence = true; } continue; }
    const spaced = /^\s/.test(txt);
    let join = false;
    if (prev && !tk.groupStart && !prev.end_of_sentence) {
      if (!spaced) join = true;
      else if (ATTACH.has(x)) join = true;
      else if (x.length === 1 && prev.text.length === 1 && !SOLO.has(prev.text)) join = true;
    }
    if (join) prev.text += x; else words.push({ text: x, start: tk.time });
  }
  const segOf = (t) => segments.filter((s) => s.start <= t + 0.1).at(-1);
  words.forEach((w) => { w.start = Math.max(0, w.start - 0.05); }); // 인식 시간은 실제보다 살짝 늦게 잡히는 편이라 당김
  words.forEach((w, i) => {
    const seg = segOf(w.start);
    const next = words[i + 1];
    let end = next ? next.start - 0.02 : (seg ? seg.end : w.start + 0.4);
    if (seg && end > seg.end + 0.05) { end = seg.end; w.end_of_phrase = true; }
    w.end = Math.max(w.start + 0.12, end);
    w.start = r3(w.start); w.end = r3(w.end);
  });
  return words.filter((w) => w.text);
}

const clean = (s) => String(s).replace(/\*\*/g, "").replace(/[\s.,!?~…·"'“”‘’()\[\]{}:;\-–—]/g, "");
const len = (w) => Math.max(1, clean(w.text).length);

// 기획서에서 강조 키워드 찾기: **단어** 와 "키워드:" 줄
export function planKeywords(planText = "") {
  const set = new Set();
  for (const m of planText.matchAll(/\*\*(.+?)\*\*/g)) m[1].split(/[,/·]/).forEach((x) => clean(x).length >= 2 && set.add(clean(x)));
  for (const line of planText.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]?\s*(키워드|강조|핵심\s*단어)\s*[:：]\s*(.+)$/);
    if (m) m[2].split(/[,/·、]/).forEach((x) => clean(x).length >= 2 && set.add(clean(x)));
  }
  return [...set];
}

// 단어 목록 → 문장 (마침표·물음표 또는 0.45초 이상 쉼에서 끊기)
export function sentencesFromWords(words) {
  const out = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const gap = next ? next.start - w.end : 9;
    if (w.end_of_sentence || gap >= 0.45 || !next) { out.push(cur); cur = []; }
  });
  return out;
}

function chunkWords(words, maxChars) {
  const total = words.reduce((a, w) => a + len(w), 0);
  const n = Math.max(1, Math.ceil(total / maxChars));
  const target = total / n;
  const chunks = [];
  let cur = [], curLen = 0;
  for (const w of words) {
    if (cur.length && curLen + len(w) > target + 2 && chunks.length < n - 1) { chunks.push(cur); cur = []; curLen = 0; }
    cur.push(w); curLen += len(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function smooth(chunks) {
  chunks.forEach((c, i) => {
    const n = chunks[i + 1];
    if (n && n.start - c.end < 0.3) c.end = n.start;
    if (c.end - c.start < 0.4) c.end = Math.min(c.start + 0.4, n ? n.start : c.start + 0.4);
  });
  return chunks;
}

const emphOf = (w, keywords) => !!w.emphasis || keywords.some((k) => clean(w.text).includes(k));

export function buildCaptions(words, { maxChars = 12, keywords = [] } = {}) {
  if (!words?.length) return { sentences: [], chunks: [], lines: [] };
  const chunks = [];
  const sentences = sentencesFromWords(words).map((ws, si) => {
    for (const cw of chunkWords(ws, maxChars)) {
      chunks.push({ sentence: si, start: cw[0].start, end: cw.at(-1).end,
        words: cw.map((w) => ({ text: w.text, start: w.start, end: w.end, emphasis: emphOf(w, keywords) })) });
    }
    const text = ws.map((w) => w.text).join(" ");
    return { text, plain: text, tag: "", start: ws[0].start, end: ws.at(-1).end };
  });
  smooth(chunks);
  return { sentences, chunks, lines: toLines(chunks) };
}

// 화면에서 고칠 수 있도록 '한 줄 = 한 자막', 문장이 끝나면 빈 줄
export function toLines(chunks) {
  return chunks.map((c, i) => ({
    start: c.start, end: c.end,
    text: c.words.map((w) => (w.emphasis ? `**${w.text}**` : w.text)).join(" ").replace(/\*\* \*\*/g, " "),
    sentenceEnd: !chunks[i + 1] || chunks[i + 1].sentence !== c.sentence,
  }));
}
export const linesToText = (lines) => lines.map((l) => l.text + (l.sentenceEnd ? "\n" : "")).join("\n").trim();

// 사용자가 고친 자막 적용
// - 줄 수가 같으면: 각 줄 시간 그대로, 글자만 교체
// - 줄 수가 다르면: 전체 글자를 음성 단어 시간 위에 글자 비율로 다시 배치
export function applyEditedText(words, origLines, editedText, { keywords = [] } = {}) {
  const raw = String(editedText || "").split(/\r?\n/);
  const lines = [], ends = [];
  raw.forEach((l, i) => {
    if (!l.trim()) return;
    lines.push(l.trim());
    ends.push(!raw[i + 1]?.trim() || /[.?!]$/.test(l.trim()));
  });
  if (!lines.length || !words?.length) return { sentences: [], chunks: [] };
  const parse = (line) => {
    let emph = false;
    return line.split(/\s+/).filter(Boolean).map((w) => {
      const marks = (w.match(/\*\*/g) || []).length;
      const o = { text: w.replace(/\*\*/g, ""), emphasis: emph || marks > 0 };
      if (marks % 2) emph = !emph;
      return o;
    }).filter((w) => w.text);
  };
  let timed;
  if (origLines && lines.length === origLines.length) {
    timed = lines.map((l, i) => ({ words: parse(l), start: origLines[i].start, end: origLines[i].end }));
  } else {
    const W = words.reduce((a, w) => a + len(w), 0);
    const all = lines.map(parse);
    const C = all.flat().reduce((a, w) => a + len(w), 0) || 1;
    const timeAt = (p) => {
      const target = (p / C) * W;
      let acc = 0;
      for (const w of words) { const l = len(w); if (target <= acc + l) return w.start + ((target - acc) / l) * (w.end - w.start); acc += l; }
      return words.at(-1).end;
    };
    let pos = 0;
    timed = all.map((ws) => { const a = pos; pos += ws.reduce((x, w) => x + len(w), 0); return { words: ws, start: timeAt(a), end: timeAt(pos) }; });
  }
  const chunks = [], sentences = [];
  let si = 0, sentStart = null, sentText = [];
  timed.forEach((ln, i) => {
    if (!ln.words.length) return;
    const total = ln.words.reduce((a, w) => a + len(w), 0);
    let p = 0;
    const ws = ln.words.map((w) => {
      const s = ln.start + (p / total) * (ln.end - ln.start); p += len(w);
      return { text: w.text, start: s, end: ln.start + (p / total) * (ln.end - ln.start), emphasis: emphOf(w, keywords) };
    });
    chunks.push({ sentence: si, start: ln.start, end: ln.end, words: ws });
    if (sentStart === null) sentStart = ln.start;
    sentText.push(ws.map((w) => w.text).join(" "));
    if (ends[i] || i === timed.length - 1) {
      const text = sentText.join(" ");
      sentences.push({ text, plain: text, tag: "", start: sentStart, end: ln.end });
      si++; sentStart = null; sentText = [];
    }
  });
  smooth(chunks);
  return { sentences, chunks };
}

// 장면 맞추기: 음성을 '말 덩어리(문장)'로 나누고, 덩어리마다 몇 번 사진·영상을 보여줄지 정합니다.
// - 사진은 항상 첨부 순서대로 (뒤로 돌아가지 않음)
// - 사진이 바뀌는 순간 = 해당 문장이 시작되는 순간 (말과 화면이 같이 바뀜)

const PUNCT_END = /[.?!。？！]$/;

// ① 말 덩어리 만들기 (같은 입력이면 항상 같은 결과)
export function buildUnits({ words = [], segments = [], dur = 0 }) {
  let units = [];
  if (words.length) {
    const segStarts = segments.map((s) => s.start);
    const isSegStart = (t) => segStarts.some((s) => Math.abs(s - t) < 0.2);
    let cur = [];
    const flush = () => { if (cur.length) units.push({ words: cur }); cur = []; };
    words.forEach((w, i) => {
      if (cur.length) {
        const curDur = cur.at(-1).end - cur[0].start;
        // 문장이 끝났거나(마침표·물음표), 원래 음성에서 쉬었던 곳이면서 덩어리가 충분히 길 때 나눔
        if (PUNCT_END.test(cur.at(-1).text) || cur.at(-1).end_of_sentence || (isSegStart(w.start) && curDur >= 2.5) || curDur >= 7) flush();
      }
      cur.push(w);
    });
    flush();
    units = units.map((u) => ({ start: u.words[0].start, end: u.words.at(-1).end, text: u.words.map((w) => w.text).join(" "), words: u.words }));
  } else if (segments.length) {
    units = segments.map((s) => ({ start: s.start, end: s.end, text: "", words: [] }));
  } else {
    units = [{ start: 0, end: dur, text: "", words: [] }];
  }
  return units;
}

// 사진 수보다 덩어리가 적으면, 긴 덩어리를 단어 사이(가장 긴 쉼)에서 나눔
function splitToAtLeast(units, N) {
  units = units.map((u) => ({ ...u }));
  let guard = 0;
  while (units.length < N && guard++ < 100) {
    let li = -1, best = 0;
    units.forEach((u, i) => { const d = u.end - u.start; if (d > best && (u.words.length >= 2 || (!u.words.length && d >= 1.2))) { best = d; li = i; } });
    if (li < 0) break;
    const u = units[li];
    let A, B;
    if (u.words.length >= 2) {
      // 가운데 근처에서 쉼이 가장 긴 곳
      let k = 1, score = -1;
      const mid = (u.start + u.end) / 2;
      for (let j = 1; j < u.words.length; j++) {
        const gap = u.words[j].start - u.words[j - 1].end;
        const s = gap - Math.abs(u.words[j].start - mid) / (u.end - u.start) * 0.3;
        if (s > score) { score = s; k = j; }
      }
      const w1 = u.words.slice(0, k), w2 = u.words.slice(k);
      A = { start: w1[0].start, end: w1.at(-1).end, text: w1.map((w) => w.text).join(" "), words: w1 };
      B = { start: w2[0].start, end: w2.at(-1).end, text: w2.map((w) => w.text).join(" "), words: w2 };
    } else {
      const m = (u.start + u.end) / 2;
      A = { ...u, end: m }; B = { ...u, start: m };
    }
    units.splice(li, 1, A, B);
  }
  return units;
}

// ② 자동 배정: 순서를 지키면서, 사진마다 보이는 시간이 고르게 되도록 묶음
export function autoMap(units, N) {
  const n = units.length;
  if (N <= 0) return [];
  if (n <= N) return units.map((_, i) => i); // 덩어리 수 ≤ 사진 수 (splitToAtLeast로 보통 n ≥ N)
  const dur = units.map((u, i) => (i < n - 1 ? units[i + 1].start : u.end) - (i === 0 ? 0 : u.start));
  const pre = [0]; dur.forEach((d, i) => pre.push(pre[i] + d));
  const target = pre[n] / N;
  const INF = 1e18;
  const dp = Array.from({ length: N + 1 }, () => new Array(n + 1).fill(INF));
  const from = Array.from({ length: N + 1 }, () => new Array(n + 1).fill(-1));
  dp[0][0] = 0;
  for (let i = 1; i <= N; i++) for (let j = i; j <= n - (N - i); j++) for (let k = i - 1; k < j; k++) {
    if (dp[i - 1][k] === INF) continue;
    const d = pre[j] - pre[k] - target;
    const c = dp[i - 1][k] + d * d;
    if (c < dp[i][j]) { dp[i][j] = c; from[i][j] = k; }
  }
  const map = new Array(n);
  let j = n;
  for (let i = N; i >= 1; i--) { const k = from[i][j]; for (let x = k; x < j; x++) map[x] = i - 1; j = k; }
  return map;
}

// 사용자가 고친 배정을 안전하게: 0~N-1, 첫 덩어리는 1번, 뒤로 가면 안 됨
export function sanitizeMap(map, n, N) {
  if (!Array.isArray(map) || map.length !== n) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    let v = Math.max(0, Math.min(N - 1, parseInt(map[i], 10) || 0));
    if (i === 0) v = 0;
    if (i > 0 && v < out[i - 1]) v = out[i - 1];
    out.push(v);
  }
  return out;
}

// 화면·영상 만들기에서 함께 쓰는 진입점
export function sceneUnits({ words, segments, dur, N, userMap }) {
  const units = splitToAtLeast(buildUnits({ words, segments, dur }), N);
  const auto = autoMap(units, N);
  const map = sanitizeMap(userMap, units.length, N) || auto;
  const unused = [];
  for (let i = 0; i < N; i++) if (!map.includes(i)) unused.push(i);
  return {
    units: units.map((u) => ({ start: r3(u.start), end: r3(u.end), text: u.text })),
    map, auto, unused,
  };
}

// 사진별 시간 구간 (사진이 바뀌는 순간은 말 시작보다 0.08초 먼저 — 화면이 살짝 먼저 바뀌어야 자연스러움)
export function imageRanges(units, map, dur) {
  const LEAD = 0.08;
  const ranges = [];
  map.forEach((img, i) => {
    if (i > 0 && map[i - 1] === img) return;
    const a = i === 0 ? 0 : Math.max(0, units[i].start - LEAD);
    if (ranges.length) ranges.at(-1).b = a;
    ranges.push({ img, a, b: dur });
  });
  return ranges;
}
