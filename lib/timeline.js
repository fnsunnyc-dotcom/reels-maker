// 장면 시간표: 자막 줄(또는 말 덩어리)마다 정한 사진 번호 + 사진별 '쉼 추가' → 완성 영상의 시간표와 소리
// - 사진은 자막 줄이 시작되는 순간에 바뀜 (자막과 사진이 어긋나지 않음)
// - 쉼 추가: 그 사진의 말이 끝난 뒤 말 없이 사진만 더 보여주는 시간 (소리에 무음을 끼워 넣음)
const SR = 48000;

// slots: [{start,end}] (완성 음성 기준 시간), map: 줄별 사진 번호, extra: 사진별 쉼(초)
export function buildTimeline({ slots, map, extra, N, dur, wordEnds = [] }) {
  // 사진별 첫 줄
  const first = new Array(N).fill(-1);
  map.forEach((k, i) => { if (first[k] < 0) first[k] = i; });
  // 사진이 바뀌는 자리(음성 시간): 줄 시작 0.08초 전, 단 앞 단어가 끝나기 전으로는 가지 않음
  const cutAt = (i) => {
    if (i <= 0) return 0;
    const s = slots[i].start;
    const prevEnd = Math.max(...wordEnds.filter((e) => e <= s + 1e-3), slots[i - 1].start);
    return Math.max(prevEnd, s - 0.08);
  };
  // 사진별 음성 구간 [va, vb)
  const va = new Array(N), vb = new Array(N);
  let pos = 0;
  for (let k = 0; k < N; k++) {
    if (first[k] >= 0) pos = k === 0 ? 0 : cutAt(first[k]);
    va[k] = pos;
  }
  for (let k = 0; k < N; k++) {
    let nb = dur;
    for (let j = k + 1; j < N; j++) if (first[j] >= 0) { nb = va[j]; break; }
    vb[k] = first[k] >= 0 ? nb : va[k]; // 줄이 없는 사진은 말 구간 없음 (쉼 동안만 보임)
  }
  const pieces = [], ranges = [];
  let out = 0;
  for (let k = 0; k < N; k++) {
    const len = Math.max(0, vb[k] - va[k]), ex = Math.max(0, extra[k] || 0);
    if (len + ex < 0.05) continue;
    if (len > 0) pieces.push({ va: va[k], vb: vb[k], out, silenceAfter: ex });
    else if (pieces.length) pieces.at(-1).silenceAfter += ex; // 말 없는 사진: 앞 음성 뒤의 쉼으로 이어짐
    ranges.push({ img: k, a: out, b: out + len + ex, voice: len, extra: ex });
    out += len + ex;
  }
  const total = out;
  // 음성 시간 → 영상 시간
  const shift = (t) => {
    for (let i = pieces.length - 1; i >= 0; i--) if (t >= pieces[i].va - 1e-6) return pieces[i].out + Math.min(t, pieces[i].vb) - pieces[i].va;
    return t;
  };
  return { pieces, ranges, total, shift };
}

// 쉼을 끼워 넣은 새 소리 만들기 (이음새는 짧게 페이드)
export function assembleVoice(samples, pieces, total) {
  const y = new Float32Array(Math.ceil(total * SR) + 1);
  const F = Math.round(SR * 0.008);
  for (const p of pieces) {
    const a = Math.round(p.va * SR), b = Math.min(samples.length, Math.round(p.vb * SR)), o = Math.round(p.out * SR), n = b - a;
    for (let i = 0; i < n && o + i < y.length; i++) {
      let g = 1;
      if (p.silenceAfter > 0 && n - i < F) g = (n - i) / F;
      y[o + i] = samples[a + i] * g;
    }
  }
  return y;
}

// 자막·문장 시간을 영상 시간으로 옮기기
export function shiftCaptions(chunks, sentences, tl) {
  const pieceOf = (t) => { for (let i = tl.pieces.length - 1; i >= 0; i--) if (t >= tl.pieces[i].va - 1e-6) return tl.pieces[i]; return tl.pieces[0]; };
  const mv = (t, p) => p.out + Math.min(Math.max(t, p.va), p.vb) - p.va;
  const ch = chunks.map((c) => {
    const p = pieceOf(c.start);
    let end = mv(c.end, p);
    if (c.end > p.vb) end = mv(p.vb, p) + Math.min(p.silenceAfter, 0.6); // 쉼이 시작되면 자막은 잠시 뒤 사라짐
    return { ...c, start: mv(c.start, p), end, words: c.words.map((w) => ({ ...w, start: mv(w.start, p), end: mv(w.end, p) })) };
  });
  const se = sentences.map((s) => ({ ...s, start: tl.shift(s.start), end: tl.shift(s.end) }));
  return { chunks: ch, sentences: se };
}
