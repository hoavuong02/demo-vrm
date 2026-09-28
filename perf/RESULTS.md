# Performance measurements

Measured with `perf/measure.mjs` on profile builds (`flutter build apk --profile`), fresh install.
The script restarts the app, then over the WebView DevTools protocol loads each model in turn
(`model.vrm`, Darkness_Shibu, AvatarSample_B, HairSample_Male, Soldier, `model.vrm` again),
waits 3s, and samples 10s of the idle animation.

```sh
node perf/measure.mjs <adb-serial> <label>   # writes perf/results/<label>-<device>.json
node perf/table.mjs perf/results/<file>.json # prints a table like the ones below
```

Columns:
- **Load ms**: `loadModel()` call until the first frame rendered with the new model (includes GPU upload/shader compile).
- **Longest frame during load**: longest `long-animation-frame` entry while loading, i.e. how long the WebView main thread froze.
- **WebGL fps / Frame p95 / Stalls**: from timestamps of rendered frames (hooked `gl.clear`). The viewer caps at 30fps.
- **gfxinfo**: `dumpsys gfxinfo` for the app window over the 10s sample. The new "janky" metric flags nearly every
  frame when content runs at 30fps on a 60/90Hz display, so the legacy percentage is more useful for comparison.
- **PSS / Graphics**: `dumpsys meminfo` of the app process; **Renderer PSS**: largest WebView sandboxed renderer process.
- **GC /10s**: `GC freed` logcat lines from the app process during the sample.

## baseline (commit with morph-texture fix, DPR cap 1.5, 30fps cap, texture cap 2048)

**SM-A057F** (Android 15, DPR 2.8125, RAM 3601.6MB) — label `baseline`

| Model | Load ms | Longest frame during load ms | WebGL fps | Frame p95 ms | Stalls >50ms /10s | gfxinfo janky % (legacy) | gfxinfo p90 ms | PSS MB | Graphics MB | Renderer PSS MB | GC /10s | Alive |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| model.vrm | 7593 | 8301 | 29.9 | 39.2 | 1 | 98.02 (8.25) | 26 | 664.2 | 398.6 | 225.6 | 0 | true |
| Darkness_Shibu.vrm | 1604 | 1841 | 29.8 | 35.8 | 0 | 99.67 (44.52) | 26 | 423.6 | 208.8 | 218.2 | 0 | true |
| AvatarSample_B.vrm | 1097 | 153 | 29.9 | 35.8 | 0 | 98.03 (45.9) | 27 | 427.2 | 220.4 | 341.4 | 0 | true |
| HairSample_Male.vrm | 1078 | 972 | 29.9 | 36.7 | 0 | 98.35 (34.98) | 28 | 417.1 | 203 | 349.9 | 0 | true |
| Soldier.glb | 731 | 691 | 30 | 34.7 | 0 | 97.36 (16.17) | 20 | 284.9 | 96 | 368.6 | 0 | true |
| model.vrm | 7822 | 8699 | 29.9 | 39.6 | 0 | 99.02 (9.48) | 26 | 646.1 | 394.7 | 240.4 | 0 | true |

**sdk_gphone16k_x86_64** (Android 17, DPR 3, RAM 3912.3MB) — label `baseline`

| Model | Load ms | Longest frame during load ms | WebGL fps | Frame p95 ms | Stalls >50ms /10s | gfxinfo janky % (legacy) | gfxinfo p90 ms | PSS MB | Graphics MB | Renderer PSS MB | GC /10s | Alive |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| model.vrm | 1546 | 85 | 23.7 | 54.7 | 31 | 84.77 (100) | 57 | 244.4 | 0 | 359.6 | 0 | true |
| Darkness_Shibu.vrm | 548 | 83 | 28.6 | 44.2 | 7 | 73.26 (98.61) | 42 | 255.1 | 0 | 318.4 | 0 | true |
| AvatarSample_B.vrm | 362 | 60 | 28.2 | 42.6 | 7 | 76.76 (99.65) | 46 | 236.7 | 0 | 456.5 | 0 | true |
| HairSample_Male.vrm | 545 | 74 | 28.7 | 43 | 5 | 73.88 (93.47) | 42 | 240.3 | 0 | 451.8 | 0 | true |
| Soldier.glb | 216 | 145 | 29.3 | 39.3 | 4 | 68.14 (63.73) | 32 | 206.7 | 0 | 467.7 | 0 | true |
| model.vrm | 1788 | 82 | 23.8 | 59.5 | 40 | 92.56 (100) | 61 | 295.4 | 0 | 768.8 | 0 | true |

Notes:
- Real device: steady rendering holds 30fps with no stalls, and there is no GC while idle. The problem left is loading:
  `model.vrm` freezes the WebView main thread for about 8s. This is the likely cause of "not responding".
- Emulator: GPU-bound (host GPU emulation), so model.vrm renders at ~24fps. Its CPU is much faster, so load stalls are short.

## step2 (fast de-interleave, prune unused morph targets, recover from WebView renderer death)

Changes:
- De-interleave with a typed-array loop instead of `InterleavedBufferAttribute.clone()`. Load-phase timing on the SM-A057F for model.vrm:
  parse 1.3s, `clone()` de-interleave 6.2s, `removeUnnecessaryVertices` 0.3s, shader compile ~35ms.
  After the change, de-interleave takes 0.15s.
- Drop morph targets that no VRM expression binds. Pixel comparison of all 12 expressions on model.vrm against the previous build: identical.
- `onRenderProcessGone` in `lib/main.dart` builds a new WebView instead of letting Android kill the app.

**SM-A057F** (Android 15, DPR 2.8125, RAM 3601.6MB) — label `step2`

| Model | Load ms | Longest frame during load ms | WebGL fps | Frame p95 ms | Stalls >50ms /10s | gfxinfo janky % (legacy) | gfxinfo p90 ms | PSS MB | Graphics MB | Renderer PSS MB | GC /10s | Alive |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| model.vrm | 1386 | 218 | 29.9 | 38.3 | 1 | 99.34 (4.26) | 25 | 404.9 | 153.4 | 244.8 | 0 | true |
| Darkness_Shibu.vrm | 1354 | 184 | 29.9 | 35.6 | 0 | 99.67 (52.79) | 26 | 416.5 | 180.8 | 287.2 | 0 | true |
| AvatarSample_B.vrm | 1131 | 1194 | 29.9 | 39.2 | 0 | 98.03 (56.72) | 28 | 390.2 | 183.5 | 386.1 | 0 | true |
| HairSample_Male.vrm | 1191 | 997 | 29.9 | 37.6 | 0 | 98.36 (55.08) | 29 | 392.3 | 177.9 | 392 | 0 | true |
| Soldier.glb | 788 | 762 | 29.9 | 34.8 | 0 | 99.35 (23.45) | 17 | 280.9 | 95.3 | 409.7 | 0 | true |
| model.vrm | 1996 | 1389 | 29.9 | 40.2 | 0 | 99.67 (20.98) | 26 | 391.4 | 149.5 | 326.9 | 0 | true |

**sdk_gphone16k_x86_64** (Android 17, DPR 3, RAM 3912.3MB) — label `step2`

| Model | Load ms | Longest frame during load ms | WebGL fps | Frame p95 ms | Stalls >50ms /10s | gfxinfo janky % (legacy) | gfxinfo p90 ms | PSS MB | Graphics MB | Renderer PSS MB | GC /10s | Alive |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| model.vrm | 450 | 90 | 28.3 | 45.6 | 8 | 74.74 (100) | 46 | 244.6 | 0 | 288.3 | 0 | true |
| Darkness_Shibu.vrm | 438 | 61 | 29.5 | 37.2 | 2 | 68.01 (68.01) | 32 | 238.5 | 0 | 323.9 | 0 | true |
| AvatarSample_B.vrm | 316 | 2489 | 28.7 | 42.4 | 7 | 79.79 (97.91) | 38 | 224.3 | 0 | 441.9 | 0 | true |
| HairSample_Male.vrm | 373 | 2449 | 29.1 | 39 | 5 | 72.6 (78.42) | 32 | 227.5 | 0 | 439.5 | 0 | true |
| Soldier.glb | 206 | 245 | 29.7 | 36.1 | 2 | 55.37 (34.23) | 32 | 195.3 | 0 | 459.3 | 0 | true |
| model.vrm | 482 | 54 | 27.6 | 47.3 | 6 | 78.78 (98.92) | 48 | 251.2 | 0 | 414.6 | 0 | true |

Notes:
- Real device, model.vrm: load 7.6s to 1.4s, longest main-thread freeze 8.3s to 0.2s, Graphics 399MB to 153MB, PSS 664MB to 405MB.
  The second model.vrm load shows a 1.4s freeze. Other VRoid models still freeze for about 1s inside `GLTFLoader` parsing.
- Emulator numbers are noisy: host load average was 11–18 during the run. Some load entries show a longest frame
  longer than the load itself (a long frame that started before the load).
