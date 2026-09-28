// Measures load time and rendering smoothness of the VRM viewer on a connected device.
//   node perf/measure.mjs <adb-serial> <label>
// Needs the app installed (profile build) and running; drives the WebView over the DevTools protocol
// and reads Android-side stats (gfxinfo, meminfo, GC log lines) over adb. Writes perf/results/<label>-<device>.json.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [serial, label = 'run'] = process.argv.slice(2);
if (!serial) throw new Error('usage: node perf/measure.mjs <adb-serial> <label>');
const PKG = 'com.example.vrm_demo';
const MODELS = ['model.vrm', 'models/Darkness_Shibu.vrm', 'models/AvatarSample_B.vrm', 'models/HairSample_Male.vrm', 'models/Soldier.glb', 'model.vrm'];
const SETTLE_MS = 3000, SAMPLE_MS = 10000;

const adb = (cmd) => execSync(`adb -s '${serial}' ${cmd}`, { encoding: 'utf8', maxBuffer: 64 << 20 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidOf = () => adb(`shell pidof ${PKG}`).trim();

// Fresh start: the app loads model.vrm on launch; wait for the WebView's DevTools socket.
adb(`shell am force-stop ${PKG}`);
adb('logcat -c');
adb(`shell am start -n ${PKG}/.MainActivity`);
let sock;
for (let i = 0; i < 60 && !sock; i++) {
  await sleep(500);
  sock = adb('shell cat /proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1];
}
const pid = pidOf();
const port = 9300 + Math.floor(Math.random() * 600);
adb(`forward tcp:${port} localabstract:${sock}`);
let page;
for (let i = 0; i < 60 && !page; i++) {
  await sleep(500);
  page = (await (await fetch(`http://localhost:${port}/json`)).json()).find((p) => p.url.includes('index.html'));
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
};
let closed = false;
ws.onclose = () => { closed = true; for (const r of pending.values()) r({ closed: true }); };
async function js(expression) {
  if (closed) throw new Error('DevTools connection closed (app/renderer died?)');
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const m = await new Promise((r) => pending.set(id, r));
  if (m.closed) throw new Error('DevTools connection closed (app/renderer died?)');
  if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
  return m.result.result.value;
}

// Wait for the startup load, then hook: every rendered frame calls gl.clear once; long tasks = main-thread stalls.
await js(`new Promise((res) => { const t = setInterval(() => { const s = document.getElementById('status')?.textContent ?? ''; if (window.vrmApi && s.includes(' · ')) { clearInterval(t); res(); } }, 200); setTimeout(() => { clearInterval(t); res(); }, 90000); })`);
await js(`(() => {
  window.__frames = []; window.__lt = [];
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const orig = C.prototype.clear;
    C.prototype.clear = function (...a) { window.__frames.push(performance.now()); return orig.apply(this, a); };
  }
  // long-animation-frame (not longtask) also covers rAF callbacks, where three.js uploads textures and compiles shaders.
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({ type: 'long-animation-frame' });
})()`);

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : null; };
const mb = (kb) => +(kb / 1024).toFixed(1);

function gfxinfo() {
  const t = adb(`shell dumpsys gfxinfo ${PKG}`);
  const n = (re) => +(t.match(re)?.[1] ?? NaN);
  return {
    frames: n(/Total frames rendered: (\d+)/),
    jankyPct: n(/Janky frames: \d+ \(([\d.]+)%\)/),
    jankyLegacyPct: n(/Janky frames \(legacy\): \d+ \(([\d.]+)%\)/),
    p50: n(/50th percentile: (\d+)ms/), p90: n(/90th percentile: (\d+)ms/), p95: n(/95th percentile: (\d+)ms/), p99: n(/99th percentile: (\d+)ms/),
  };
}
function meminfo() {
  const t = adb(`shell dumpsys meminfo ${PKG}`);
  const kb = (re) => +(t.match(re)?.[1] ?? NaN);
  // WebView's GPU/renderer work runs in a separate sandboxed process.
  const r = adb('shell dumpsys meminfo').match(/([\d,]+)K: \S*sandboxed_process\S* \(pid \d+/);
  return {
    pssMB: mb(kb(/TOTAL PSS:\s+(\d+)/)), graphicsMB: mb(kb(/Graphics:\s+(\d+)/)),
    nativeHeapMB: mb(kb(/Native Heap:\s+(\d+)/)), rendererPssMB: r ? mb(+r[1].replace(/,/g, '')) : null,
  };
}
const gcLines = () => adb(`logcat -d --pid=${pid}`).split('\n').filter((l) => /GC freed/.test(l)).length;
const died = () => adb('logcat -d -b events').split('\n').filter((l) => /am_proc_died|am_kill/.test(l) && l.includes(PKG));

const results = { label, serial, model: adb('shell getprop ro.product.model').trim(), android: adb('shell getprop ro.build.version.release').trim(),
  dpr: await js('devicePixelRatio'), ramMB: mb(+adb('shell cat /proc/meminfo').match(/MemTotal:\s+(\d+)/)[1]), steps: [] };
console.log(`${results.model} (Android ${results.android}), DPR ${results.dpr}, RAM ${results.ramMB}MB`);

for (const url of MODELS) {
  const step = { url };
  results.steps.push(step);
  try {
    adb('logcat -c');
    // Load, timing until the viewer reports loaded/error to Flutter.
    const load = await js(`new Promise((res) => {
      const h = window.flutter_inappwebview, orig = h.callHandler, t0 = performance.now();
      window.__lt = [];
      h.callHandler = function (name, msg, ...rest) {
        const m = JSON.parse(msg);
        if (m.type === 'loaded' || m.type === 'error') {
          h.callHandler = orig;
          // Count up to the first frame rendered with the new model (GPU upload + shader compile happen there).
          const tl = performance.now(), n = window.__frames.length;
          const wait = () => window.__frames.length > n ? res({ ms: window.__frames[n] - t0, parseMs: tl - t0, type: m.type, err: m.type === 'error' ? m.data : undefined }) : setTimeout(wait, 5);
          wait();
        }
        return orig.call(this, name, msg, ...rest);
      };
      vrmApi.loadModel(${JSON.stringify(url)});
      setTimeout(() => res({ type: 'timeout' }), 120000);
    })`);
    const lt = await js('window.__lt');
    step.load = { ms: Math.round(load.ms), parseMs: Math.round(load.parseMs), result: load.type, err: load.err,
      longFrames: lt.length, longFrameTotalMs: Math.round(lt.reduce((s, x) => s + x[1], 0)), longestFrameMs: Math.round(Math.max(0, ...lt.map((x) => x[1]))) };
    step.gcDuringLoad = gcLines();

    // Steady state: idle animation.
    await sleep(SETTLE_MS);
    adb('logcat -c');
    adb(`shell dumpsys gfxinfo ${PKG} reset`);
    const t0 = await js('window.__frames = []; window.__lt = []; performance.now()');
    await sleep(SAMPLE_MS);
    const [frames, lt2, t1] = await js('[window.__frames, window.__lt, performance.now()]');
    const gaps = frames.slice(1).map((f, i) => f - frames[i]);
    step.webgl = { fps: +(frames.length / ((t1 - t0) / 1000)).toFixed(1), frameP50: pct(gaps, 0.5), frameP95: pct(gaps, 0.95), frameMax: pct(gaps, 1),
      stallsOver50ms: gaps.filter((g) => g > 50).length, longFrames: lt2.length };
    step.gfx = gfxinfo();
    step.gcPer10s = gcLines();
    step.mem = meminfo();
  } catch (e) {
    step.error = String(e.message ?? e);
  }
  step.alive = pidOf() === pid;
  console.log(JSON.stringify(step));
  if (!step.alive) { step.deaths = died(); break; }
}

ws.close();
adb(`forward --remove tcp:${port}`);
mkdirSync('perf/results', { recursive: true });
const file = `perf/results/${label}-${results.model.replace(/\W+/g, '_')}.json`;
writeFileSync(file, JSON.stringify(results, null, 2));
console.log('saved', file);
