# Android profiling

How to measure a `src/` rendering change on Android without producing a number
that is silently wrong.

Companion to `.claude/skills/run-and-profile/SKILL.md` (iOS CPU A/B + simpleperf
symbol attribution). That skill's Part 2 discipline is the model; this doc ports
it to Android.

**Package id: `liveline.example`** — no `com.` prefix.

Every command below was executed on the `liveline_test` emulator (Android 34,
`google_apis`, arm64, Apple M2 host) against a release build on 2026-07-30,
except where explicitly marked **unverified**.

---

## 0. Why not fps, and why not `gfxinfo` either

The engine paces frames at ~60 (`MIN_FRAME_INTERVAL_MS = 15` in
`src/engine/constants.ts`). Both arms of any A/B will read 60fps no matter how
much cheaper each frame got. **Measure frame *time* and CPU, never frame rate.**
Any procedure that reports fps has measured the pacing constant.

The obvious next reach is `dumpsys gfxinfo <pkg> framestats`. **On this app it
does not measure the thing you care about** — see §3. It is documented here so
the next person does not have to rediscover that, but the primary metric is
per-thread CPU (§4) and the per-frame timeline comes from Perfetto (§5).

---

## 1. Preconditions — check both, every session

Android measurement on this project has been invalidated twice. Both causes are
invisible in the numbers: you get a plausible-looking result that is simply
wrong. Run both checks and record the output alongside every number.

### 1a. GPU acceleration is actually on

The `liveline_test` AVD has **`hw.gpu.enabled=no`** persisted in its config
(still true as of 2026-07-30), which software-renders everything.

```bash
grep hw.gpu ~/.android/avd/liveline_test.avd/config.ini
```

**The launch flag overrides the config file** — verified — so the cheap fix is
to always pass `-gpu host`:

```bash
emulator -avd liveline_test -gpu host -no-snapshot -no-boot-anim &
```

Permanent fix, if you prefer not to remember the flag — edit
`~/.android/avd/liveline_test.avd/config.ini` while the emulator is **not**
running: set `hw.gpu.enabled=yes` and `hw.gpu.mode=host`.

Either way, **verify from the guest** rather than trusting the flag. Do not use
`getprop ro.hardware.egl` — it reads `emulation` in both the accelerated and the
software case and will happily confirm a broken setup. The renderer string is
the real signal:

```bash
adb shell dumpsys SurfaceFlinger | grep GLES
```

Good (host GPU) — names real hardware. Actual output from a correct boot:

```
GLES: Google (Apple), Android Emulator OpenGL ES Translator (Apple M2), OpenGL ES 3.0 (4.1 Metal - 90.5)
```

Bad — if the string contains **SwiftShader**, or otherwise names no real GPU,
you are software-rendering. Stop; do not record a number.

### 1c. Make sure the app is talking to the Metro you think it is

Cost roughly an hour on 2026-08-01. Symptoms looked exactly like a code bug: a
red screen reading `Unable to resolve module
@babel/runtime/helpers/createForOfIteratorHelperLoose from src/engine/state.ts`,
naming a file edited that same day and a `for...of` construct added that same
day. It was neither.

Two things conspire here:

- **`adb reverse` does not apply.** The app connects to `10.0.2.2:<port>`,
  which is the emulator's NAT route to the *host*. `adb reverse` maps *device*
  localhost to the host, so it is bypassed entirely. Mapping `tcp:8082` did
  nothing.
- **A stale Metro can hold the port.** There was a second, older Metro on host
  8082 whose module map had been corrupted earlier (its own error was
  `Unable to resolve module expo`). Android hits 8082; iOS was on 8083 and
  perfectly healthy. Same repo, same files, one platform broken.

The diagnostic that settles it in one command — ask each server directly,
which removes the emulator, the app's cached error screen and your assumptions
from the picture:

```bash
for port in 8081 8082 8083; do
  printf "%s: " $port
  curl -s -o /tmp/b.txt -w "%{http_code}\n" -m 240 \
    "http://localhost:$port/.expo/.virtual-metro-entry.bundle?platform=android&dev=true&lazy=true&app=liveline.example"
done
```

200 with ~10MB means that server is healthy. A 500 prints a JSON body naming
the real failure. Do this BEFORE reading anything into a red screen. And check
for strays: `lsof -nP -iTCP:8082 -sTCP:LISTEN`.

Generalised: an error naming a file you just edited is not evidence that your
edit caused it.

### 1b. Host load

This is a **shared** machine and has been measured at load average 24. Relative
deltas survive moderate load; absolute numbers do not.

```bash
uptime
```

Log it **per arm**. Under ~8 on the 8-core box is workable; above that,
within-arm spread widens and the comparison stops meaning anything. If the two
arms ran at meaningfully different load the comparison is void — re-run, don't
try to correct for it.

---

## 2. Build and install the release APK

Release matters: Debug inflates the Hermes share and adds dev-mode overhead, so
a Debug A/B overstates JS cost and understates a Skia win. Release also embeds
the JS bundle, so **no Metro server and no `adb reverse`** — one less variable
between arms.

`example/android/app/build.gradle` reads `android.enableMinifyInReleaseBuilds`
(defaults **false**) and the `release` buildType is already signed with the
**debug keystore**, so this needs no new signing setup.

```bash
cd example
npm run build:android:release      # gradlew assembleRelease
```

Verified: `BUILD SUCCESSFUL in 1m 16s` (warm Gradle cache), producing
`example/android/app/build/outputs/apk/release/app-release.apk` (~115 MB,
unminified).

Two setup traps, both hit on first run:

- **`example/android/` is generated by `expo prebuild` and is not tracked by
  git**, so it is missing in a fresh worktree. Build from the main checkout, or
  run `npx expo prebuild -p android` first.
- **`Unable to locate a Java Runtime`** — the Homebrew JDK is installed but not
  symlinked into `/Library/Java/JavaVirtualMachines`, so `/usr/libexec/java_home`
  cannot see it and Gradle dies. Export it explicitly:

  ```bash
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  ```

Install and launch:

```bash
adb install -r example/android/app/build/outputs/apk/release/app-release.apk
adb shell am start -n liveline.example/.MainActivity
```

Use `am start`. The `adb shell monkey -p liveline.example ...` form quoted in
the iOS skill **fails on this release build** (exits 251, no process starts).

Let it settle ~20s before measuring. Use the default **Line** tab where
possible: it survives a relaunch with no navigation, removing a variance source.

**Screenshot the baseline arm.** If the old `src/` throws, you are timing a red
error screen — cheap to render, looks like a huge win.

---

## 3. `gfxinfo framestats` — measured, and blind to this app

Recorded here as a negative result. **Do not use it as the A/B metric.**

```bash
adb shell dumpsys gfxinfo liveline.example reset     # counters are cumulative
# ... let the chart animate ~10s ...
adb shell dumpsys gfxinfo liveline.example framestats > /tmp/fs.csv
```

Actual measurement, release build, chart animating, 103 clean frames:

```
total      n=103 p50= 138.46ms p95= 302.42ms
ui_record  n=103 p50=   0.10ms p95=   1.39ms
render     n=103 p50=  23.00ms p95=  47.97ms
gpu        n=103 p50=  22.51ms p95=  47.97ms
```

**`ui_record` (`SyncQueued - DrawStart`) is 0.10ms.** That is the HWUI
display-list record pass — and it is empty. Liveline's Skia rendering does not
go through it. `dumpsys SurfaceFlinger --list` shows no separate SurfaceView
layer for the app, so react-native-skia is presenting an externally-updated
texture into the window: HWUI composites one quad (0.1ms) while all the engine
work happens on a thread framestats never samples.

The other columns are equally untrustworthy here. `total` is measured from
`IntendedVsync`, so for a *paced* app it mostly counts time the app deliberately
spent not drawing — 138ms is the pacing, not the cost. The summary histogram
reports `95th gpu percentile: 4950ms`, an obvious emulator artifact. And
`Janky frames: 85.92%` is a consequence of pacing to ~60 while HWUI expects
every vsync, not evidence of a problem.

If you ever need to check whether framestats has become useful (e.g. after a
react-native-skia rendering-path change), the test is: capture with the chart
animating and again with it idle. **If `ui_record` p50 does not differ, it is
still blind.** Parse by column *name* — this Android 34 build emits 23 columns
(`FrameTimelineVsyncId`, `FrameDeadline`, `FrameInterval`, `FrameStartTime`,
`CommandSubmissionCompleted` … are interleaved into the classic layout), so
fixed indices silently read the wrong fields:

```python
import sys, statistics
hdr, rows = None, []
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith("Flags,"):
        hdr = [c for c in line.split(",") if c]; continue
    if hdr is None or not line[:1].isdigit(): continue
    p = line.split(",")
    if len(p) < len(hdr): continue
    r = dict(zip(hdr, [int(x) for x in p[:len(hdr)]]))
    if r["Flags"] != 0: continue          # non-zero = atypical frame, drop
    rows.append(r)
m = {"total":     lambda r: r["FrameCompleted"] - r["IntendedVsync"],
     "ui_record": lambda r: r["SyncQueued"]     - r["DrawStart"],
     "render":    lambda r: r["FrameCompleted"] - r["IssueDrawCommandsStart"],
     "gpu":       lambda r: r["GpuCompleted"]   - r["IssueDrawCommandsStart"]}
for name, fn in m.items():
    xs = sorted(fn(r) / 1e6 for r in rows)
    p95 = xs[min(len(xs) - 1, int(.95 * len(xs)))]
    print(f"{name:10s} n={len(xs):3d} p50={statistics.median(xs):7.2f}ms p95={p95:7.2f}ms")
```

All values are absolute nanosecond timestamps on `CLOCK_MONOTONIC` — you
subtract to get durations. `DequeueBufferDuration` / `QueueBufferDuration` are
the exceptions, already durations. framestats keeps only the **last 120 frames**,
so sample close to the activity you care about.

---

## 4. Primary metric — per-thread CPU

This is where Liveline's cost actually shows up. Ports directly from Part 2 of
the iOS skill; read `utime + stime` (fields 14 and 15 of `/proc/<pid>/stat`, in
clock ticks, 100/sec) instead of `ps -o cputime`.

```bash
PID=$(adb shell pidof liveline.example | tr -d '\r')
cpu(){ adb shell cat /proc/$PID/stat | awk '{print $14+$15}'; }
A=$(cpu); sleep 20; B=$(cpu)
echo "$A $B" | awk '{printf "%.1f%%\n", ($2-$1)/100/20*100}'   # % of one core
```

\>100% is normal (main + RenderThread + JS threads).

**Per-thread is more diagnostic than the process total**, because it separates
the engine from the example app's own data generation:

```bash
adb shell 'for t in /proc/'$PID'/task/*; do
  echo "$(cat $t/comm) $(awk "{print \$14+\$15}" $t/stat)"; done' | sort -k2 -rn | head
```

Measured shortly after launch (cumulative ticks, release build):

| thread | ticks | what it is |
|---|---|---|
| `iveline.example` | 7989 | **main** — the Reanimated UI runtime + Skia draw. This is the engine. |
| `mqt_v_js` | 3836 | RN JS thread — largely the example app's data generation, not library cost. |
| `RenderThread` | 2053 | HWUI composite. |
| `hades` (x2) | 749 | Hermes GC. |

Note `comm` is truncated to 15 chars, so the main thread reads
`iveline.example` — match on that, not on the full package name.

This split corroborates the simpleperf reference already recorded in the iOS
skill (main 44.8%, `mqt_v_js` 35.6%, RenderThread 14.0%, hades 4.5%).
**A rendering change should move the main thread**; if your delta shows up in
`mqt_v_js` instead, you changed the example app's workload, not the library.

### Derived per-frame cost

`gfxinfo` is blind to the Skia work but its frame *counter* is still a valid
count of presented frames, so you can turn the CPU number into a per-frame one:

```bash
adb shell dumpsys gfxinfo liveline.example reset
A=$(cpu); sleep 20; B=$(cpu)
FRAMES=$(adb shell dumpsys gfxinfo liveline.example | awk '/Total frames rendered/{print $4}')
echo "$A $B $FRAMES" | awk '{printf "%.2f ms cpu/frame\n", ($2-$1)*10/$3}'
```

Because the frame rate is pinned by pacing, this is close to a pure ratio of
the CPU numbers — treat it as a readability convenience, not independent evidence.

### Symbol-level attribution

Use **simpleperf** — already documented and verified in
`.claude/skills/run-and-profile/SKILL.md` §"Android — simpleperf", including the
three traps (`-e cpu-clock` required on emulators, `perf_harden` needs
`adb root`, sort key is `comm` not `thread`).

---

## 5. Perfetto — the per-frame timeline

Use when you need real per-frame durations rather than an averaged CPU rate.
Unlike gfxinfo it samples **every thread**, so it sees the Skia work.

```bash
adb shell perfetto -o /data/misc/perfetto-traces/trace.pftrace -t 15s \
  sched freq idle am wm gfx view binder_driver
adb pull /data/misc/perfetto-traces/trace.pftrace /tmp/
```

Verified working on this emulator (8s run → 13 MB trace). Two notes: pass
`adb shell -t` if you want Ctrl+C to stop the trace gracefully, and drop `hal`
from the category list — the run above used the categories exactly as shown.

Open at <https://ui.perfetto.dev>. What to read, in priority order:

1. **The main thread's slices** during the capture — this is the engine, per §4.
   Its per-frame slice duration is the number a rendering refactor should move.
2. The **Frame Timeline** track (`ActualFrameTiming` /` ExpectedFrameTiming`)
   for per-frame actual vs expected duration with jank classification. Interpret
   its jank flags with the pacing caveat from §3 in mind.

Report **p50 as the headline** (typical per-frame cost) and **p95 alongside**
(catches GC pauses and spike regressions). **Never report the mean** —
frame-time distributions are long-tailed and one GC pause moves the mean while
telling you nothing about typical cost.

---

## 6. A/B protocol

Mirrors the iOS protocol. The discipline is the point — skipping a step is how
the two earlier invalidated results happened.

1. **Swap only `src/`.** `git checkout <base> -- src/`, restore with
   `git checkout HEAD -- src/`. Holding `example/` constant isolates the
   library. Commit or stash first.
2. **Rebuild the release APK for each arm.** Unlike the iOS Debug flow there is
   no Metro to pick up `src/` changes — the bundle is embedded, so an unbuilt
   arm silently measures the *other* arm's code. This is the easiest way to
   produce a fake null result. (Only the JS bundle changes, so rebuilds are
   ~1min warm, not a full native build.)
3. **Screenshot the baseline arm** before measuring (§2).
4. Relaunch between arms, settle ~20s. Prefer the default Line tab.
5. **N = 3 runs per arm.** Within-arm spread should be a few percent; much wider
   means the host is too busy to measure on — stop and come back later.
6. **Re-measure the first arm at the end** as a drift control. If arm-A-final
   does not land within the spread of arm-A-initial, the run is void: something
   drifted (thermal, host load, emulator state) and your "delta" is that drift.
7. **Log `uptime` per arm** (§1b), and the `dumpsys SurfaceFlinger | grep GLES`
   line once per emulator boot (§1a). Record both with the numbers.

### Reporting template

```
date, commit-A -> commit-B, device (emulator liveline_test / hardware model),
build type (release), GLES renderer string, load per arm

arm         n   main-thread CPU %   process CPU %   p50 frame ms (perfetto)
A (base)    3
B (change)  3
A (drift)   3
```

State what the measurement does **not** establish. For the emulator: it is a
gfxstream/Metal translation layer, not a real Adreno/Mali GL driver, so GPU-side
numbers do not transfer to hardware; and it measures the whole pipeline, so a
delta cannot be attributed to one change without simpleperf's breakdown.
**Release on physical Android hardware remains the standing open item.**
