---
name: run-and-profile
description: Launch the Liveline example app on the iOS simulator and/or measure a before-after CPU delta for a library change. Use when asked to run the app, screenshot it, visually verify a rendering change, or profile / benchmark / measure the performance impact of a change to src/.
---

# Running and profiling Liveline

Two independent halves. Read only the one you need.

## Part 1 — Launch

The library is pure TypeScript, so Metro picks up every `src/` change.
**Skip `expo run:ios`** (full native rebuild, minutes) unless you touched
`example/ios`, `example/android`, or a native dep.

```bash
xcrun simctl boot "iPhone 17 Pro"; open -a Simulator

# 8081 is usually held by another project (dev/predict). Don't kill it.
#   lsof -ti:8081 | xargs -I{} ps -p {} -o command=
cd example && npx expo start --port 8083 > /tmp/metro.log 2>&1 &

APP=$(find ~/Library/Developer/Xcode/DerivedData/LivelineExample-*/Build/Products/Debug-iphonesimulator -name "*.app" | head -1)
xcrun simctl install booted "$APP"

# Not an expo-dev-client build => no deep-link override. Port comes from
# RCT_jsLocation in the app's simulator prefs, and persists until changed.
C=$(xcrun simctl get_app_container booted liveline.example data)
P="$C/Library/Preferences/liveline.example.plist"
/usr/libexec/PlistBuddy -c "Add :RCT_jsLocation string localhost:8083" "$P" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :RCT_jsLocation localhost:8083" "$P"

xcrun simctl launch booted liveline.example   # first bundle ~20s, ~1500 modules
```

Bundle id: `liveline.example`.

Driving with `agent-device`:

- Coordinates are **points, not pixels** — screenshots are 3x, divide by 3.
- Use `snapshot -i` then `press @eNN`. `find "X" click` matches inner text and
  hits the wrong element.
- **Scrub cannot be automated.** Synthetic swipes (fast, slow, hold-drag) never
  engage the pan gesture. Anything touching scrub needs a human. Don't retry.

## Part 2 — Profile a `src/` change

**fps cannot show a win here** — recording is capped at ~60
(`MIN_FRAME_INTERVAL_MS`), so both arms read 60 no matter how much cheaper each
frame got. Measure CPU. Also: `top -stats cpu` parses its own header year as a
sample (max of "2026"); `ps aux` %CPU is a lifetime average.

```bash
cpusec(){ ps -p $1 -o cputime= 2>/dev/null \
  | awk -F: '{n=NF; s=$n; if(n>=2) s+=$(n-1)*60; if(n>=3) s+=$(n-2)*3600; print s}'; }
measure(){ PID=$1; W=$2; A=$(cpusec $PID); T0=$(date +%s.%N); sleep $W;
  B=$(cpusec $PID); T1=$(date +%s.%N);
  echo "$A $B $T0 $T1" | awk '{printf "%.1f", ($2-$1)/($4-$3)*100}'; }

PID=$(pgrep -f "LivelineExample.app/LivelineExample" | head -1)
for i in 1 2 3; do echo "run$i: $(measure $PID 20)%"; done
```

>100% is normal (UI + render + JS threads).

A/B protocol:

1. Swap **only** `src/`: `git checkout <base> -- src/`, restore with
   `git checkout HEAD -- src/`. Holding `example/` constant isolates the library.
   Commit/stash first.
2. **Screenshot the baseline arm.** If the old `src/` throws, you're timing a
   red error screen — cheap to render, looks like a huge win.
3. Relaunch between arms, settle ~20s. Use the default Line tab where possible:
   it survives a reload with no navigation, removing a variance source.
4. 3 runs/arm. Within-arm spread should be 2-3 points; much wider means the host
   is too busy to measure on.
5. Re-measure the first arm at the end as a drift control.
6. Log `uptime` per arm — shared 8-core box, has run at load 24. Relative deltas
   survive moderate load; absolute numbers don't.

Reference (2026-07-27, iPhone 17 Pro sim, Debug, load ~8-11), `main` 60e493e →
`perf-hardening` 2fb7ff2: Line 127.8% → 85.4%, Candles 108.5% → 63.5%.

Does not establish: Simulator + Debug + loaded host, whole-pipeline only (can't
attribute to one change). Sim Skia is Metal; Android is a GL backend. **Release
on physical Android hardware remains unmeasured** — standing open item.

## Part 3 — Symbol-level attribution (where the time goes)

Part 2 gives a total; this gives a breakdown. Note that `react-native
profile-hermes` and RN DevTools' JS profiler are **useless here** — they attach
to the main JS runtime, and the engine runs in the Reanimated UI runtime.

### iOS — xctrace (verified)

`--attach <host pid>` fails with "Cannot find process": simulator processes need
the device context. Attach **by name with `--device`**.

```bash
UDID=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
xcrun xctrace record --template "Time Profiler" --device $UDID \
  --attach LivelineExample --time-limit 20s --no-prompt --output /tmp/lv.trace
xcrun xctrace export --input /tmp/lv.trace \
  --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > /tmp/tp.xml
```

**Parsing trap:** frame *and* thread names are interned — defined once as
`id="N" name="..."`, then referenced as `ref="N"`. A naive regex filter matches
only the first definition and silently reports n=1. Resolve both maps first:

```python
fnames = dict(re.findall(r'<frame id="(\d+)"[^>]*?name="([^"]*)"', xml))
tnames = dict(re.findall(r'<thread id="(\d+)"[^>]*?fmt="([^"]*)"', xml))
# per row: <thread (id=...fmt="X" | ref="N")>, frames likewise
```

On iOS the Reanimated UI runtime **is** the Main Thread — that thread is the
engine. A separate `com.facebook.react.runtime.JavaScript` thread is the example
app's own data generation, not library cost.

Reference (2026-07-27, Candles, Debug): Main Thread 51-61%, JS thread 30-41%
(varies with app activity). Within Main Thread the split is stable across
traces — Hermes-only (worklet JS) **51-53%**, Skia-only **34%**, both 9-10%. Top Skia frames are Metal upload/renderpass, `aaa_fill_path`,
`generate_distance_field_from_image`. Takeaway: past this point the engine thread
is roughly half JS interpretation, so Skia call-count tuning has limited headroom.
Debug inflates the Hermes share — treat 51% as an upper bound.

### Android — simpleperf (UNVERIFIED: no SDK on this machine)

No `adb`/`emulator`/`ANDROID_HOME` here as of 2026-07-27, so the below is written
from the tool docs and has **not** been run. Verify before trusting it. A
`liveline_test` AVD dir and prebuilt debug+release APKs exist under
`example/android/app/build/outputs/apk/`.

```bash
PID=$(adb shell pidof com.liveline.example)
adb shell simpleperf record -p $PID --call-graph fp --duration 20 \
  -o /data/local/tmp/perf.data
adb shell simpleperf report -i /data/local/tmp/perf.data --sort dso,symbol
```

Needs unstripped `.so`/symfs for readable Skia frames. Perfetto covers the other
half (frame timeline, thread states) and `adb shell dumpsys gfxinfo <pkg>
framestats` is the cheap frame-time histogram. Part 2's CPU A/B ports directly —
read `utime+stime` from `/proc/<pid>/stat` instead of `ps -o cputime`.
