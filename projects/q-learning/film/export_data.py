"""Plays the four attempts for real and saves what happened to data.js, so every move and number in the film is measured.

    python export_data.py      (run from this folder, in the environment that runs main.py)
"""
import contextlib
import io
import json
import random

import gymnasium as gym
import numpy as np

env = gym.make("Taxi-v4").unwrapped
env.reset(seed=7)
env.action_space.seed(7)


def pos(s):  # row, column, passenger (4 = aboard), destination
    return [int(x) for x in env.decode(s)]


def step(s, a):
    env.s = s
    n, r, done, _, _ = env.step(a)
    return int(n), int(r), bool(done)


def run(s, pick, limit=200):
    out, total = [], 0
    for _ in range(limit):
        a = int(pick(s))
        s, r, done = step(s, a)
        total += r
        out.append({"a": a, "r": r, "at": pos(s)[:2], "aboard": pos(s)[2] == 4})
        if done:
            return out, total, True
    return out, total, False


# main.py's own training section, with a seed and a note of which trips were delivered.
src = open("../main.py").read().split("# Testing")[0]
DONE = '    print(f"Episode {episode + 1} completed!")'
RESET = "state, info = env.reset()\nprint("
assert src.count(DONE) == 1 and src.count(RESET) == 1


def train(seed):
    random.seed(seed)
    code = src.replace(DONE, "    log.append((bool(terminated), epsilon))").replace(RESET, f"state, info = env.reset(seed={seed})\nprint(")
    g = {"log": []}
    with contextlib.redirect_stdout(io.StringIO()):
        exec(code, g)
    return g["q_table"], g["log"]


# Every attempt starts here: taxi at row 2, column 3, passenger top right, destination bottom left. Several routes are
# equally short. This keeps the first training run whose route goes north first and never crosses its own path.
START = 266


def drawable(way, done):
    cells = [tuple(w["at"]) for w in way if w["a"] < 4]
    return done and len(way) == 13 and way[0]["a"] == 1 and len(set(cells)) == len(cells) and tuple(pos(START)[:2]) not in cells and (3, 0) in cells


for seed in range(1, 40):
    Q, log = train(seed)
    best = lambda s: np.argmax(Q[s])
    way, total, done = run(START, best)
    if drawable(way, done):
        break
else:
    raise SystemExit("no training run took a route the film can draw")

BUCKET = 10
curve = [{"trip": i + BUCKET, "delivered": sum(d for d, _ in log[i : i + BUCKET]) / BUCKET, "epsilon": log[i + BUCKET - 1][1]} for i in range(0, len(log), BUCKET)]

R = np.array([[step(s, a)[1] for a in range(6)] for s in range(500)])
starts = [s for s in range(500) if pos(s)[2] < 4 and pos(s)[2] != pos(s)[3]]
anything = lambda s: env.action_space.sample()
greedy = lambda s: np.argmax(R[s])


def score(pick, n=1000):
    trips = [run(random.choice(starts), pick) for _ in range(n)]
    return {"delivered": sum(d for _, _, d in trips) / n, "average": sum(t for _, t, _ in trips) / n}


results = {"north": score(lambda s: 1), "random": score(anything), "greedy": score(greedy), "q": score(best)}

# One random trip that did deliver the passenger, kept whole. Most do not (see results).
lucky = None
while lucky is None:
    t = run(START, anything)
    if t[2] and 60 <= len(t[0]) <= 130:
        lucky = t

# The state before each step of the route, its best score, and its rewards.
states, s = [], START
for w in way:
    states.append(s)
    s = step(s, w["a"])[0]
values = [round(float(Q[x].max()), 2) for x in states]
rows = [{"state": x, "r": [int(v) for v in R[x]]} for x in (states[0], states[1], states[3], states[5], states[-3], states[-1])]

out = {
    "start": pos(START), "locs": [[0, 0], [0, 4], [4, 0], [4, 3]], "seed": seed,
    "route": way, "routeTotal": total, "routeValues": values,
    "north": run(START, lambda s: 1)[0], "random": lucky[0], "randomTotal": lucky[1], "greedy": run(START, greedy)[0],
    "rows": rows, "curve": curve, "results": results,
}
open("data.js", "w").write("window.DATA = " + json.dumps(out) + ";\n")
print("seed", seed, "start", pos(START), "route", [w["a"] for w in way], "total", total)
print("cells", [w["at"] for w in way])
print("values", values)
print("lucky random trip:", len(lucky[0]), "steps,", lucky[1], "points, picked up at step", [w["aboard"] for w in lucky[0]].index(True) + 1)
print("results", results)
print("delivered per 10 trips", [c["delivered"] for c in curve[:30]])
