// 음성 인식 일꾼 (화면이 멈추지 않도록 따로 돌아감)
// 모델(약 230MB)은 처음 한 번만 내려받아 휴대폰에 저장해 두고, 다음부터는 저장된 것을 씀
const CACHE = "reels-model-v1";
let recognizer = null;

const say = (msg, pct) => self.postMessage({ type: "progress", msg, pct });

async function loadModelData() {
  const base = new URL("../model/", self.location.href);
  const man = await (await fetch(new URL("manifest.json", base), { cache: "no-cache" })).json();
  const cache = await caches.open(CACHE + ":" + man.version);
  const all = new Uint8Array(man.total);
  let off = 0, done = 0, fromCache = 0;
  for (const p of man.parts) {
    const url = new URL(p.name, base).href;
    let res = await cache.match(url);
    if (res) fromCache++;
    else {
      res = await fetch(url);
      if (!res.ok) throw new Error(`모델 파일을 받지 못했어요 (${p.name}, ${res.status})`);
      try { await cache.put(url, res.clone()); } catch (e) { /* 저장 공간이 부족하면 저장만 건너뜀 */ }
    }
    const b = new Uint8Array(await res.arrayBuffer());
    all.set(b, off); off += b.length; done += b.length;
    say(fromCache === man.parts.length ? "저장된 음성 인식 모델을 불러오는 중…" : `음성 인식 모델 내려받는 중… ${Math.round((done / man.total) * 100)}% (${Math.round(done / 1048576)}/${Math.round(man.total / 1048576)}MB · 처음 한 번만)`, done / man.total);
  }
  // 오래된 모델 저장분 정리
  for (const k of await caches.keys()) if (k.startsWith(CACHE) && k !== CACHE + ":" + man.version) caches.delete(k);
  return all.buffer;
}

async function init() {
  if (recognizer) return;
  const data = await loadModelData();
  say("음성 인식 준비 중…", 1);
  await new Promise((resolve, reject) => {
    self.Module = {
      locateFile: (p) => new URL("../vendor/sherpa/" + p, self.location.href).href,
      getPreloadedPackage: () => data,
      print: () => {}, printErr: () => {},
      onRuntimeInitialized: resolve,
      onAbort: (e) => reject(new Error("음성 인식 엔진을 시작하지 못했어요: " + e)),
    };
    importScripts("../vendor/sherpa/sherpa-onnx-asr.js", "../vendor/sherpa/sherpa-onnx-wasm-main-vad-asr.js");
  });
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { senseVoice: { model: "./sense-voice.onnx", language: "ko", useInverseTextNormalization: 1 }, tokens: "./tokens.txt", numThreads: 1, provider: "cpu", debug: 0 },
  }, self.Module);
}

self.onmessage = async (e) => {
  const { type, id, pieces } = e.data;
  try {
    if (type === "init") { await init(); self.postMessage({ type: "ready", id }); return; }
    if (type === "decode") {
      await init();
      const out = [];
      for (let i = 0; i < pieces.length; i++) {
        say(`말한 내용 받아 적는 중… (${i + 1}/${pieces.length})`, (i + 1) / pieces.length);
        const st = recognizer.createStream();
        st.acceptWaveform(16000, pieces[i]);
        recognizer.decode(st);
        const r = recognizer.getResult(st);
        st.free();
        out.push({ tokens: r.tokens || [], timestamps: r.timestamps || [] });
      }
      self.postMessage({ type: "result", id, out });
    }
  } catch (err) {
    self.postMessage({ type: "error", id, message: err.message || String(err) });
  }
};
