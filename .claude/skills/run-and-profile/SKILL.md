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
