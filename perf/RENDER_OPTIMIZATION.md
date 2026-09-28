# Render loop optimization

## Background

On Android 15+ some ROMs log this line once per WebView draw:

```
I/View: setRequestedFrameRate frameRate=-4.0, this=...InAppWebView{...}, caller=... WebViewChromium.onDraw ...
```

`-4.0` is `REQUESTED_FRAME_RATE_CATEGORY_HIGH`, not an FPS value: the WebView tells the adaptive
refresh rate system that it is animating. The log comes from the framework and cannot be silenced
from the app (filter it with `adb logcat View:S *:V`). It is a symptom, not the cost: the real cost
is the render loop that makes the WebView draw.

Measured on a real device (R7AX715NM1N, release build, `model.vrm` idle):

| State | log lines / 5s | WebView renderer CPU | App CPU |
|---|---|---|---|
| Foreground | 164 (~32/s) | 61% | 42% |
| Background (after pause fix) | 0 | 0% | 0% |

One log line per rendered frame (the 30fps cap in `loop()`); rAF callbacks that skip rendering do
not trigger `onDraw`. So the log rate, and the cost, scale with the number of frames actually rendered.

## Done: pause while the app is not visible

- `vrmApi.setPaused(v)` in `assets/web/index.html` stops `renderer.setAnimationLoop` while
  `paused || document.hidden`.
- `lib/main.dart` observes `AppLifecycleState`: `hidden`/`paused` pause the loop, `resumed` restarts it.
  `inactive` keeps rendering because the viewer is still visible (e.g. split screen).
- No Flutter route covers the WebView today. The file picker is a separate activity, so the app gets
  `paused`. If a full-screen route is added later, pause there too (e.g. with `RouteAware`).

## Idle still animates

Idle is not static: breathing, blinking and spring bones (hair/cloth) change every frame, so rendering
cannot simply stop. The options reduce either the number of frames or the cost of each frame.

### A. Dynamic FPS (recommended first step)

Render idle at 20fps; switch to 30fps while an action plays or the user orbits the camera.

- Idle motion is slow, so 20fps is hard to tell apart; a 150ms blink still gets 3 frames.
- Expected: about 1/3 less CPU/GPU and log lines while idle.
- Change is local to `loop()` (make `FRAME` depend on the current action and on `OrbitControls`
  start/end events).
- Check: spring bones get a larger `dt`; make sure hair does not jitter.

### B. Lower render resolution while idle

Drop the pixel ratio from 1.5 to 1.0 while idle.

- Large GPU saving (fewer fragments per frame).
- Visibly softer image, and switching resizes the canvas, which can flicker.
  Probably only worth it as a low-battery mode.

### C. Profile before optimizing further

61% renderer CPU is high for one character at 30fps. Find where the time goes before picking a fix:

- Skinning and morph targets (`model.vrm` has 118 morph targets).
- Spring bone simulation in `vrm.update(dt)`.
- Draw calls / material count.
- `applyExpressions` sets every expression every frame, even unchanged ones.

Use `perf/measure.mjs` plus a Chrome DevTools performance trace over `chrome://inspect`.
This may reveal a bigger win than A, but takes longer.

Suggested order: A, then C.
