#!/usr/bin/env python3
"""Keep the walking graph of a station model out of what you cannot walk through.

OpenStreetMap's paths and the builder's links across open floors (build_station3d.py, mesh_areas) are straight lines.
Some of them cut across the well of a stair or an escalator, through the railing round it, through a lift's shaft or
through a wall that the 3D companion (stations3d/<key>.solid.js) has: the route then runs through them, and in the 3D
view the walk goes straight through a balustrade or a glass shaft. This step repairs the graph of stations3d/<key>.js
with the companion's geometry:

  obstacles  on each level: the wells (the holes of the floor slabs), lift shafts (LIFT_R round each lift), railings
             round the wells and OpenStreetMap's indoor walls (solid.walls 'rail' / 'wall'), the walls the cadastral
             survey measured (solid.av.walls). The first and last metres of a walk at a stair, escalator, ramp or lift
             it leads onto do not count (you step onto it there).
  each walk edge on one whole level that crosses an obstacle
    1. is dropped when the graph already has a way round on that level no longer than DETOUR (no new geometry);
    2. else it is bent round the obstacle: the shortest way inside the floors of that level, kept CLEAR off the
       obstacles and within a corridor round the edge (never to another platform or across the tracks), no longer
       than DETOUR; the edge becomes a chain of edges through new nodes (appended: no node changes its index), with
       the edge's own attributes;
    3. else it stays, and is listed for a look at that station.
  Then every stop and entrance must reach what it reached before, walking and step-free (both directions, one-way
  edges as they are), or nothing is written.

Usage:
  python tools/station3d_clear.py zurich          # rewrites stations3d/zurich.js in place
  python tools/station3d_clear.py zurich --dry    # only reports (one pass)

Run it after tools/station3d_solid.py and tools/station3d_av.py (it reads their output). It repeats until a pass
changes nothing, so running it again changes nothing more. Needs shapely and numpy (as the other builders).
"""
import heapq
import json
import math
import os
import re
import sys
from collections import defaultdict

import numpy as np
import shapely
import shapely.ops
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIFT_R = 0.9        # m: half the width of a lift shaft round its point
LINE_W = 0.12       # m: half the thickness of a railing or a wall
APRON = 1.6         # m: at a connector's end, this much of a walk may lie in its well (the step onto it)
CLEAR = 0.35        # m: a bent walk keeps this far off obstacles
CELL = 0.3          # m: grid of the search for a way round
CORRIDOR = (6.0, 18.0)   # m: half-width of the corridor round an edge the way round must stay in (min, max)
SAMPLE = 0.25       # m: steps along an edge when testing it
NODE_MOVE = 4.0     # m: a node in a well or a shaft is moved out onto the floor at most this far


STEEP = 0.08       # a walk steeper than this is not step-free (station-route.ts: V_STEEP)


def steep(e):
    return abs(e.get('incline') or 0) > STEEP


def detour_limit(length):
    return max(1.6 * length, length + 25.0)


def read_js(path):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    m = re.search(r'^(.*?\]\s*=\s*)(\{.*\});\s*$', text, re.S)
    if not m:
        raise SystemExit(f'{path}: not a model file')
    return m.group(1), json.loads(m.group(2))


def write_js(path, head, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(head)
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')


def level_z(levels, lv):
    for l in levels:
        if l['id'] == lv:
            return l['z']
    return None


class Level:
    """The obstacles of one whole level, and its floors."""

    def __init__(self, solid, lv):
        slabs = [s for s in solid['slabs'] if s['level'] == lv]
        self.floor = unary_union([Polygon(s['rings'][0], s['rings'][1:]).buffer(0) for s in slabs]) if slabs else None
        outer = unary_union([Polygon(s['rings'][0]).buffer(0) for s in slabs]) if slabs else None
        # the wells: inside a slab's outline, but not floor (a pillar's hole counts too: it is not walkable)
        self.wells = outer.difference(self.floor) if outer is not None else None
        z = level_z(solid['levels'], lv)
        self.lifts = [tuple(c['xy']) for c in solid['connectors']
                      if c['kind'] == 'elevator' and z is not None and any(abs(q - z) < 0.6 for q in c['zs'])]
        lines = [w['line'] for w in solid['walls'] if w['level'] == lv and w['kind'] in ('rail', 'wall')]
        lines += [w['line'] for w in (solid.get('av') or {}).get('walls', []) if w['level'] == lv]
        self.lines = [LineString(l) for l in lines if len(l) >= 2]
        parts = [Point(p).buffer(LIFT_R, quad_segs=4) for p in self.lifts] + [l.buffer(LINE_W, cap_style='flat') for l in self.lines]
        if self.wells is not None and not self.wells.is_empty:
            parts.append(self.wells)
        self.block = unary_union(parts) if parts else None
        self.block_p = prep(self.block) if self.block is not None and not self.block.is_empty else None
        self.lines_u = unary_union(self.lines) if self.lines else None
        self.floor_p = prep(self.floor) if self.floor is not None else None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dry = '--dry' in sys.argv
    if not args:
        raise SystemExit(__doc__)
    key = args[0]
    mpath = os.path.join(ROOT, 'stations3d', key + '.js')
    spath = os.path.join(ROOT, 'stations3d', key + '.solid.js')
    head, model = read_js(mpath)
    _, solid = read_js(spath)
    # a repair can leave a way round that is itself clear only after the next one: again until nothing changes
    changed = False
    for n in range(4):
        print(f'{key}, pass {n + 1}:')
        if not one_pass(key, model, solid):
            break
        changed = True
        if dry:
            break
    if dry or not changed:
        print('  nothing written' if not dry else '  (dry run: nothing written)')
        return
    write_js(mpath, head, model)
    print(f'  wrote {os.path.relpath(mpath, ROOT)}')


def one_pass(key, model, solid):
    """One round of repairs on the model (in place); True when it changed anything."""
    nodes, edges = model['graph']['nodes'], model['graph']['edges']

    # nodes that are the end of something you step onto: a stair, escalator, ramp or lift
    conn_end = set()
    for e in edges:
        if e['kind'] != 'walk':
            conn_end.add(e['a'])
            conn_end.add(e['b'])

    levels = {}

    def level(lv):
        if lv not in levels:
            levels[lv] = Level(solid, lv)
        return levels[lv]

    def whole(v):
        return abs(v - round(v)) < 1e-6

    # 0. nodes standing in a well, a shaft or a wall (the builder's line along the middle of a platform runs through
    # the well of the stairs in its middle) are moved out onto the floor, NODE_MOVE at most; not the end of a stair or
    # lift itself (it belongs at the well's edge, or in the shaft)
    has_walk = set()
    for e in edges:
        if e['kind'] == 'walk':
            has_walk.add(e['a'])
            has_walk.add(e['b'])
    moved = 0
    for i, n in enumerate(nodes):
        if i in conn_end or i not in has_walk or not whole(n[2]):
            continue
        L = level(int(round(n[2])))
        if L.block_p is None or L.floor is None:
            continue
        p = Point(n[:2])
        if not L.block_p.intersects(p.buffer(0.15)):
            continue
        if not hasattr(L, 'clear'):
            L.clear = L.floor.difference(L.block.buffer(CLEAR + 0.1, quad_segs=4))
        if L.clear.is_empty or L.clear.distance(p) > NODE_MOVE:
            continue
        q = shapely.ops.nearest_points(L.clear, p)[0]
        nodes[i] = [round(q.x, 2), round(q.y, 2), n[2]]
        moved += 1
    if moved:
        for e in edges:
            if e['kind'] == 'walk':
                a, b = nodes[e['a']], nodes[e['b']]
                if a[2] == b[2]:
                    e['len'] = round(math.dist(a[:2], b[:2]), 2)

    def blocked(e):
        """Why this walk edge is through something (or None)."""
        a, b = nodes[e['a']], nodes[e['b']]
        if a[2] != b[2] or not whole(a[2]):
            return None
        L = level(int(round(a[2])))
        if L.block_p is None:
            return None
        seg = LineString([a[:2], b[:2]])
        n = seg.length
        if n < 0.3 or not L.block_p.intersects(seg):
            return None
        # what is excused: the apron where it steps onto a connector, the lift it boards
        keep_out = []
        for i, p in ((e['a'], a), (e['b'], b)):
            if i in conn_end:
                keep_out.append(Point(p[:2]).buffer(APRON, quad_segs=4))
        for q in L.lifts:
            # the walk to the lift's own node (its door; the node stands in the shaft), not one past the shaft
            if (e['a'] in conn_end and math.dist(q, a[:2]) < 2.5) or (e['b'] in conn_end and math.dist(q, b[:2]) < 2.5):
                keep_out.append(Point(q).buffer(LIFT_R + 1.6, quad_segs=4))
        rest = seg.difference(unary_union(keep_out)) if keep_out else seg
        if rest.is_empty or rest.length < 0.2:
            return None
        hit = L.block.intersection(rest)
        # crossing a railing or a wall square on is short (twice its half-thickness): any crossing of its line counts
        crosses_line = L.lines_u is not None and rest.intersects(L.lines_u)
        if (hit.is_empty or hit.length < 0.25) and not crosses_line:
            return None
        why = []
        if L.wells is not None and L.wells.intersection(rest).length > 0.25:
            why.append('well')
        if any(math.dist(q, (p.x, p.y)) < LIFT_R for q in L.lifts for p in [rest.interpolate(t, normalized=True) for t in np.linspace(0, 1, max(2, int(rest.length / SAMPLE)))]):
            why.append('lift')
        if crosses_line:
            why.append('wall')
        return why or ['obstacle']

    def reach(es, step_free, open_only):
        """Directed adjacency over these edges (step-free: no stairs, escalators, wheelchair: false or slopes steeper
        than STEEP; open_only: no edge with a closure)."""
        adj = defaultdict(list)
        for e in es:
            if step_free and (e['kind'] in ('stairs', 'escalator') or e.get('wheelchair') is False or steep(e)):
                continue
            if open_only and e.get('closed'):
                continue
            adj[e['a']].append(e['b'])
            if not e.get('oneway'):
                adj[e['b']].append(e['a'])
        return adj

    def reachable(adj, src):
        seen = {src}
        st = [src]
        while st:
            u = st.pop()
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    st.append(v)
        return seen

    # every node of every stop (a platform's walkway, not only its middle) and every entrance
    ends = sorted({s['node'] for s in model['stops'] if s.get('node') is not None}
                  | {n for s in model['stops'] for n in (s.get('nodes') or [])}
                  | {en['node'] for en in model['entrances']})

    def signature(es):
        out = {}
        for sf in (False, True):
            for oo in (False, True):
                adj = reach(es, sf, oo)
                for s in ends:
                    out[(sf, oo, s)] = frozenset(x for x in reachable(adj, s) if x in ends)
        return out

    before = signature(edges)

    bad = []
    for k, e in enumerate(edges):
        if e['kind'] != 'walk':
            continue
        why = blocked(e)
        if why:
            bad.append((k, why))
    print(f'  {len(bad)} walk edges cross an obstacle '
          + json.dumps({w: sum(1 for _, ws in bad if w in ws) for w in ('well', 'lift', 'wall', 'obstacle')}))

    bad_set = {k for k, _ in bad}
    # 1. a way round in the graph as it is (walk edges on that level that are clear themselves)
    def graph_detour(k):
        """A way round in both directions the edge goes, as usable as it: not over a closed edge, nor (where the edge
        is step-free) over one that is not."""
        e = edges[k]
        ds = [one_way_round(k, e['a'], e['b'])]
        if not e.get('oneway'):
            ds.append(one_way_round(k, e['b'], e['a']))
        return None if any(d is None for d in ds) else max(ds)

    def one_way_round(k, src, dst):
        e = edges[k]
        lv = nodes[src][2]
        limit = detour_limit(e['len'])
        tgt = nodes[dst]
        dist = {src: 0.0}
        heap = [(math.dist(nodes[src][:2], tgt[:2]), 0.0, src)]
        while heap:
            f, d, u = heapq.heappop(heap)
            if u == dst:
                return d
            if d > dist.get(u, 1e18):
                continue
            for j, v in adj_walk[u]:
                if j == k or j in bad_set or j in dropped:
                    continue
                o = edges[j]
                if o.get('closed') and not e.get('closed'):
                    continue
                if o.get('wheelchair') is False and e.get('wheelchair') is not False:
                    continue
                if steep(o) and not steep(e):
                    continue
                if nodes[v][2] != lv:
                    continue
                nd = d + edges[j]['len']
                if nd < dist.get(v, 1e18):
                    h = math.dist(nodes[v][:2], tgt[:2])
                    if nd + h <= limit:
                        dist[v] = nd
                        heapq.heappush(heap, (nd + h, nd, v))
        return None

    adj_walk = defaultdict(list)
    for j, e in enumerate(edges):
        if e['kind'] != 'walk':
            continue
        adj_walk[e['a']].append((j, e['b']))
        if not e.get('oneway'):
            adj_walk[e['b']].append((j, e['a']))

    dropped = set()
    bent = {}          # edge index -> list of intermediate points
    left = []
    for k, why in bad:
        e = edges[k]
        if e.get('oneway'):
            left.append((k, why, 'one-way'))
            continue
        d = graph_detour(k)
        if d is not None:
            dropped.add(k)
            continue
        path = way_round(level(int(round(nodes[e['a']][2]))), nodes[e['a']][:2], nodes[e['b']][:2],
                         e['a'] in conn_end, e['b'] in conn_end, e['len'], bool(e.get('outdoor')))
        if path:
            bent[k] = path
        else:
            left.append((k, why, 'no way round'))

    # the new graph
    new_nodes = [list(n) for n in nodes]
    new_edges = []
    for k, e in enumerate(edges):
        if k in dropped:
            continue
        if k not in bent:
            new_edges.append(e)
            continue
        lv = nodes[e['a']][2]
        ids = [e['a']]
        for p in bent[k]:
            new_nodes.append([round(p[0], 2), round(p[1], 2), lv])
            ids.append(len(new_nodes) - 1)
        ids.append(e['b'])
        for u, v in zip(ids, ids[1:]):
            piece = dict(e)
            piece['a'], piece['b'] = u, v
            piece['len'] = round(math.dist(new_nodes[u][:2], new_nodes[v][:2]), 2)
            new_edges.append(piece)

    after = signature(new_edges)
    lost = [(sf, s, sorted(before[(sf, oo, s)] - after[(sf, oo, s)])) for (sf, oo, s) in before if before[(sf, oo, s)] - after[(sf, oo, s)]]
    print(f'  moved {moved} nodes out of wells and shafts; dropped {len(dropped)} (the graph has a way round), bent {len(bent)} round the obstacle, '
          f'left {len(left)}; {len(new_nodes) - len(nodes)} nodes added')
    for k, why, how in left:
        a, b = nodes[edges[k]['a']], nodes[edges[k]['b']]
        print(f'    left: edge {edges[k]["a"]}-{edges[k]["b"]} ({a[0]:.0f}, {a[1]:.0f}) -> ({b[0]:.0f}, {b[1]:.0f}) '
              f'level {a[2]:g}, {edges[k]["len"]:.0f} m: {",".join(why)} ({how})')
    if lost:
        for sf, s, l in lost[:10]:
            print(f'    LOST ({"step-free" if sf else "walking"}): from node {s} no longer reaches {l}')
        raise SystemExit(f'{key}: the repair would cut stops or entrances off; nothing written')
    model['graph']['nodes'], model['graph']['edges'] = new_nodes, new_edges
    return bool(moved or dropped or bent)


def way_round(L, a, b, a_conn, b_conn, length, outdoor=False):
    """The shortest way from a to b on L's floors, CLEAR off its obstacles, inside a corridor round the straight line
    (grid search, then pulled tight); the points between a and b, or None."""
    seg = LineString([a, b])
    half = max(CORRIDOR[0], min(CORRIDOR[1], 0.45 * length))
    corridor = seg.buffer(half)
    # outdoors (a pavement, a square without a floor of the model): anywhere in the corridor but the obstacles
    if outdoor:
        room = corridor if L.floor is None else corridor.difference(L.wells) if L.wells is not None else corridor
    elif L.floor is None:
        return None
    else:
        room = L.floor.intersection(corridor)
    if L.block is not None:
        room = room.difference(L.block.buffer(CLEAR, quad_segs=4))
    # the ends themselves (at a connector or a lift, or on the edge of a floor): a little room round them
    for p, conn in ((a, a_conn), (b, b_conn)):
        disc = Point(p).buffer(APRON if conn else 0.8, quad_segs=6)
        if L.block is not None and not conn:
            disc = disc.difference(L.block.buffer(0.05))
        room = room.union(disc.intersection(corridor))
    if room.is_empty:
        return None
    x0, y0, x1, y1 = room.bounds
    nx, ny = int(math.ceil((x1 - x0) / CELL)) + 1, int(math.ceil((y1 - y0) / CELL)) + 1
    if nx * ny > 900_000:
        return None
    xs, ys = x0 + np.arange(nx) * CELL, y0 + np.arange(ny) * CELL
    gx, gy = np.meshgrid(xs, ys, indexing='ij')
    free = shapely.contains_xy(room, gx, gy)
    cell = lambda p: (int(round((p[0] - x0) / CELL)), int(round((p[1] - y0) / CELL)))
    sa, sb = cell(a), cell(b)
    for s in (sa, sb):
        if not (0 <= s[0] < nx and 0 <= s[1] < ny):
            return None
        free[s] = True
    # A* with 8 neighbours
    limit = detour_limit(length)
    D = math.sqrt(2) * CELL
    steps = [(1, 0, CELL), (-1, 0, CELL), (0, 1, CELL), (0, -1, CELL), (1, 1, D), (1, -1, D), (-1, 1, D), (-1, -1, D)]
    g = {sa: 0.0}
    prev = {}
    tb = (xs[sb[0]], ys[sb[1]])
    heap = [(0.0, 0.0, sa)]
    found = False
    while heap:
        f, d, u = heapq.heappop(heap)
        if u == sb:
            found = True
            break
        if d > g.get(u, 1e18):
            continue
        for dx, dy, c in steps:
            v = (u[0] + dx, u[1] + dy)
            if not (0 <= v[0] < nx and 0 <= v[1] < ny) or not free[v]:
                continue
            if dx and dy and not (free[u[0] + dx, u[1]] and free[u[0], u[1] + dy]):
                continue   # no corner cutting
            nd = d + c
            if nd < g.get(v, 1e18):
                h = math.hypot(xs[v[0]] - tb[0], ys[v[1]] - tb[1])
                if nd + h > limit:
                    continue
                g[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd + h, nd, v))
    if not found:
        return None
    cells = [sb]
    while cells[-1] != sa:
        cells.append(prev[cells[-1]])
    cells.reverse()
    pts = [a] + [(xs[i], ys[j]) for i, j in cells[1:-1]] + [b]
    # pulled tight: the farthest point still in sight (the line stays in the room)
    room_p = prep(room.buffer(0.01))
    out = [pts[0]]
    i = 0
    while i < len(pts) - 1:
        j = len(pts) - 1
        while j > i + 1 and not room_p.covers(LineString([pts[i], pts[j]])):
            j -= 1
        out.append(pts[j])
        i = j
    total = sum(math.dist(p, q) for p, q in zip(out, out[1:]))
    if total > limit or len(out) < 3:
        return None
    return out[1:-1]


if __name__ == '__main__':
    main()
