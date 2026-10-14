// 음성 가공 (휴대폰 안에서): 무음 제거 → 배속(목소리 높이 유지) → 음량 정리
// PC판(FFmpeg)과 같은 기준: 40dB보다 작은 소리가 0.25초 이상이면 무음, 문장 사이 쉼은 0.12초만 남김
const SR = 48000;

export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SR);
  const ab = await ctx.decodeAudioData(buf);
  // 모노로 합치기
  const n = ab.length, out = new Float32Array(n);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out; // 48kHz 모노
}

function detectSpeech(x, { threshold = -40, minSilence = 0.25 } = {}) {
  const hop = Math.round(SR * 0.01), thr = Math.pow(10, threshold / 20);
  const frames = Math.ceil(x.length / hop);
  const loud = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    let peak = 0;
    for (let i = f * hop, e = Math.min(x.length, i + hop); i < e; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
    loud[f] = peak >= thr ? 1 : 0;
  }
  const total = x.length / SR, minF = Math.round(minSilence / 0.01);
  const silences = [];
  let s = -1;
  for (let f = 0; f <= frames; f++) {
    const q = f < frames && !loud[f];
    if (q && s < 0) s = f;
    if (!q && s >= 0) { if (f - s >= minF) silences.push({ start: s * 0.01, end: Math.min(total, f * 0.01) }); s = -1; }
  }
  const speech = [];
  let t = 0;
  for (const si of silences) { if (si.start - t > 0.05) speech.push({ start: t, end: si.start, silenceAfter: si.end - si.start }); t = si.end; }
  if (total - t > 0.05) speech.push({ start: t, end: total, silenceAfter: 0 });
  return { speech, total };
}

// WSOLA: 목소리 높이를 유지하면서 빠르게
function wsola(x, speed) {
  if (Math.abs(speed - 1) < 1e-3) return x.slice();
  const N = Math.round(SR * 0.04), Hs = N >> 1, Ha = Math.round(Hs * speed), tol = Math.round(SR * 0.01);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const outLen = Math.ceil(x.length / speed) + N;
  const y = new Float32Array(outLen), norm = new Float32Array(outLen);
  let prev = 0; // 이전 프레임의 '자연스러운 다음 위치'
  for (let k = 0, outPos = 0; ; k++, outPos += Hs) {
    const target = k * Ha;
    if (target + N >= x.length) break;
    let best = target;
    if (k > 0) {
      const nat = prev + Hs; // 앞 조각에 이어지는 원래 소리
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 4) {
        const c = target + d;
        if (c < 0 || c + N >= x.length || nat + Hs >= x.length) continue;
        let sc = 0;
        for (let i = 0; i < Hs; i += 4) sc += x[c + i] * x[nat + i];
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
    }
    for (let i = 0; i < N; i++) { y[outPos + i] += x[best + i] * win[i]; norm[outPos + i] += win[i]; }
    prev = best;
  }
  let end = outLen;
  while (end > 0 && norm[end - 1] === 0) end--;
  for (let i = 0; i < end; i++) if (norm[i] > 1e-3) y[i] /= norm[i];
  return y.subarray(0, end);
}

export function processVoice(x, { speed = 1.2, keepGap = 0.12 } = {}) {
  const LEAD = 0.03;
  const { speech, total } = detectSpeech(x);
  if (!speech.length) throw new Error("음성에서 말소리를 찾지 못했어요. 음성 파일을 확인해 주세요.");
  const cuts = speech.map((s, i) => ({ a: Math.max(0, s.start - (i === 0 ? 0 : LEAD)), b: Math.min(total, s.end + Math.min(keepGap, s.silenceAfter)) }));
  // 잘라 붙이기 (이음새는 5ms 페이드)
  const F = Math.round(SR * 0.005);
  let len = 0;
  for (const c of cuts) len += Math.round((c.b - c.a) * SR);
  const joined = new Float32Array(len);
  let p = 0;
  for (const c of cuts) {
    const a = Math.round(c.a * SR), b = Math.round(c.b * SR), n = b - a;
    for (let i = 0; i < n; i++) {
      let g = 1;
      if (i < F) g = i / F; else if (n - i < F) g = (n - i) / F;
      joined[p + i] = x[a + i] * g;
    }
    p += n;
  }
  let y = wsola(joined, speed);
  // 음량 정리: 말소리 평균 크기를 맞추고, 너무 큰 소리는 제한
  let sum = 0, peak = 0;
  for (let i = 0; i < y.length; i++) { sum += y[i] * y[i]; const a = Math.abs(y[i]); if (a > peak) peak = a; }
  const rms = Math.sqrt(sum / Math.max(1, y.length));
  const gain = Math.min(0.18 / Math.max(rms, 1e-4), 0.89 / Math.max(peak, 1e-4));
  for (let i = 0; i < y.length; i++) y[i] *= gain;
  // 시간표: 원본 시간 → 완성 음성 시간
  let acc = 0;
  const map = cuts.map((c, i) => { const m = { a: c.a, b: c.b, out: acc / speed, speechStart: speech[i].start, speechEnd: speech[i].end }; acc += c.b - c.a; return m; });
  acc = 0;
  const segments = cuts.map((c, i) => { const s = { start: (acc + (speech[i].start - c.a)) / speed, end: (acc + (speech[i].end - c.a)) / speed }; acc += c.b - c.a; return s; });
  return { samples: y, duration: y.length / SR, original: total, removed: total - acc, speed, segments, map };
}

// 음성 인식용: 원본에서 말 구간마다 16kHz로 잘라냄 (25초보다 길면 나눔)
export async function speechPieces(x, map) {
  const pieces = [];
  for (const m of map) {
    for (let s = m.speechStart; s < m.speechEnd; s += 25) {
      const e = Math.min(m.speechEnd, s + 25);
      const a = Math.max(0, s - 0.15), b = Math.min(x.length / SR, e + 0.2);
      const seg = x.subarray(Math.floor(a * SR), Math.floor(b * SR));
      pieces.push({ m, a, samples: await resample(seg, 16000) });
    }
  }
  return pieces;
}

export async function resample(x, rate) {
  const len = Math.max(1, Math.round((x.length * rate) / SR));
  const ctx = new OfflineAudioContext(1, len, rate);
  const b = ctx.createBuffer(1, x.length, SR);
  b.copyToChannel(x, 0);
  const src = ctx.createBufferSource();
  src.buffer = b; src.connect(ctx.destination); src.start();
  const r = await ctx.startRendering();
  return r.getChannelData(0).slice();
}

export const SAMPLE_RATE = SR;
