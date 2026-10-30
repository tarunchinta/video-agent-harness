#!/bin/bash
# Build checks and the temporal review for the shot (see skills/animated-video/references/review.md, "Temporal checks").
# usage: ./check.sh [outdir]      (default out/check; run `npm run kit` first in a fresh copy)
# Writes: shot.mp4, hero.png, motion.png (one second of consecutive frames), sheet.png (every
# 10th frame), yavg.csv (mean brightness per frame), report.txt (timings, re-render hashes).
# Renders one frame at a time so it can share a machine with other renders.
set -euo pipefail
cd "$(dirname "$0")"
out=${1:-out/check}; rm -rf "$out"; mkdir -p "$out/frames" "$out/again"
comp=Shot; hero=${HERO:-59}; again=${AGAIN:-"0 30 59"}
now() { python3 -c 'import time; print(time.time())'; }
since() { python3 -c "print(round($(now) - $1, 2))"; }

npx tsc -p .
node selftest.ts
b="$out/bundle"; npx remotion bundle src/index.ts --out-dir "$b" --log=error >/dev/null
fps=$(npx remotion compositions "$b" 2>/dev/null | awk -v c=$comp '$1==c {print $2}')
frames=$(npx remotion compositions "$b" 2>/dev/null | awk -v c=$comp '$1==c {print $4}')

# Heaviest frame first (default: the last, closest to the dense grass). Both timings include one
# browser start and scene build, so the per-frame figure is an upper bound.
t=$(now); npx remotion still "$b" $comp "$out/hero.png" --frame=$hero --log=error; still=$(since $t)
t=$(now); npx remotion render "$b" $comp "$out/frames" --sequence --image-format=png --concurrency=1 --log=error; seq=$(since $t)

ffmpeg -v error -y -framerate "$fps" -pattern_type glob -i "$out/frames/*.png" -c:v libx264 -crf 16 -pix_fmt yuv420p "$out/shot.mp4"
mid=$(( frames / 2 - fps / 2 )); [ $mid -lt 0 ] && mid=0
ffmpeg -v error -y -i "$out/shot.mp4" -vf "select='between(n\,$mid\,$((mid + fps - 1)))',scale=480:-1,tile=6x$(( (fps + 5) / 6 ))" -frames:v 1 -fps_mode vfr "$out/motion.png"
ffmpeg -v error -y -i "$out/shot.mp4" -vf "select='not(mod(n\,10))',scale=640:-1,tile=3x$(( (frames / 10 + 2) / 3 ))" -frames:v 1 -fps_mode vfr "$out/sheet.png"
ffprobe -v error -f lavfi -i "movie=$out/shot.mp4,signalstats" -show_entries frame_tags=lavfi.signalstats.YAVG -of csv=p=0 > "$out/yavg.csv"

# Determinism: render a few frames again in a fresh browser and compare with the sequence.
files=("$out"/frames/*.png); same=0; total=0; hashes=""
for f in $again; do
  npx remotion still "$b" $comp "$out/again/$f.png" --frame=$f --log=error
  h1=$(ffmpeg -v error -i "${files[$f]}" -f md5 - | cut -d= -f2); h2=$(ffmpeg -v error -i "$out/again/$f.png" -f md5 - | cut -d= -f2)
  total=$((total + 1)); [ "$h1" = "$h2" ] && same=$((same + 1)); hashes="$hashes\n  frame $f: $h1 $h2"
done
jump=$(python3 -c "
v=[float(l.strip().rstrip(',')) for l in open('$out/yavg.csv') if l.strip()]
d=[abs(b-a) for a,b in zip(v,v[1:])]
print(f'max frame-to-frame YAVG change {max(d):.2f} (median {sorted(d)[len(d)//2]:.2f}) over {len(v)} frames')")
rm -rf "$b"
{
  echo "composition $comp: $frames frames at $fps fps"
  echo "hero still (frame $hero, incl. browser start + scene build): ${still}s"
  echo "sequence of $frames frames, concurrency 1 (incl. one browser start + build): ${seq}s = $(python3 -c "print(round($seq/$frames,3))") s/frame"
  echo "$jump"
  echo -e "re-render identical: $same/$total$hashes"
} | tee "$out/report.txt"
# A frame that renders differently twice has an unseeded random value, a clock or a late texture.
if [ "$same" -ne "$total" ]; then echo "FAIL: $((total - same)) re-rendered frame(s) differ; inspect $out/again" | tee -a "$out/report.txt"; exit 1; fi
echo "PASS: build, self-test and re-render determinism. Motion and look still need eyes: $out/shot.mp4, motion.png" | tee -a "$out/report.txt"
