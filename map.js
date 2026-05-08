/**
 * ════════════════════════════════════════════════════════════════
 *  SYNTHCITY MAP ENGINE — map.js
 *  Grafika Komputer · Native Canvas API
 *
 *  Fitur Utama:
 *  1. Generate Graph → Adjacency List (node + edge)
 *  2. Verifikasi Konektivitas → BFS / DFS
 *  3. Transformasi Manual (Matrix 3×3) untuk Zoom & Pan
 *  4. Render Vector: Jalan lurus & kurva (Bezier), Bangunan, Kendaraan
 *  5. Animasi kendaraan yang bergerak di atas edges
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

/* ════════════════════════════════════════════════
   §0  SEEDED RANDOM (Pseudo-RNG deterministik)
════════════════════════════════════════════════ */
function SeededRNG(seed) {
  let s = seed >>> 0;
  return {
    next() {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 0xFFFFFFFF;
    },
    range(a, b) { return a + this.next() * (b - a); },
    int(a, b)   { return Math.floor(this.range(a, b + 1)); },
  };
}

/* ════════════════════════════════════════════════
   §1  TRANSFORMASI MATRIKS 3×3 (Manual — NO ctx.scale / ctx.translate)
   
   Matriks affine 3×3 dalam representasi row-major:
   [ a  b  tx ]
   [ c  d  ty ]
   [ 0  0   1 ]
   
   Untuk Scaling  : x' = sx * x,  y' = sy * y
   Untuk Translasi: x' = x + tx,  y' = y + ty
════════════════════════════════════════════════ */
const Mat3 = {
  identity() {
    return [1, 0, 0,
            0, 1, 0,
            0, 0, 1];
  },

  /**
   * Scale seragam (Zoom).
   * Formula: x' = s * x,  y' = s * y
   */
  scale(s) {
    return [s, 0, 0,
            0, s, 0,
            0, 0, 1];
  },

  /**
   * Translasi.
   * Formula: x' = x + dx,  y' = y + dy
   */
  translate(dx, dy) {
    return [1, 0, dx,
            0, 1, dy,
            0, 0,  1];
  },

  /**
   * Perkalian dua matriks 3×3.
   * Hasil: C = A × B
   */
  multiply(A, B) {
    return [
      A[0]*B[0] + A[1]*B[3] + A[2]*B[6],
      A[0]*B[1] + A[1]*B[4] + A[2]*B[7],
      A[0]*B[2] + A[1]*B[5] + A[2]*B[8],

      A[3]*B[0] + A[4]*B[3] + A[5]*B[6],
      A[3]*B[1] + A[4]*B[4] + A[5]*B[7],
      A[3]*B[2] + A[4]*B[5] + A[5]*B[8],

      A[6]*B[0] + A[7]*B[3] + A[8]*B[6],
      A[6]*B[1] + A[7]*B[4] + A[8]*B[7],
      A[6]*B[2] + A[7]*B[5] + A[8]*B[8],
    ];
  },

  /**
   * Terapkan matriks ke titik 2D (homogen).
   * [x', y'] = M × [x, y, 1]
   */
  applyPoint(M, x, y) {
    return {
      x: M[0]*x + M[1]*y + M[2],
      y: M[3]*x + M[4]*y + M[5],
    };
  },

  /**
   * Bangun matriks transformasi gabungan:
   * T = Translate(cx,cy) × Scale(s) × Translate(-cx,-cy) × Translate(dx,dy)
   * (zoom di sekitar pusat kanvas, lalu translasi offset pan)
   */
  buildViewMatrix(scale, tx, ty, cx, cy) {
    const S  = Mat3.scale(scale);
    const T1 = Mat3.translate(cx, cy);       // geser ke pusat
    const T2 = Mat3.translate(-cx, -cy);     // kembalikan
    const Tp = Mat3.translate(tx, ty);       // pan offset
    // T = Tp × T1 × S × T2
    return Mat3.multiply(Tp, Mat3.multiply(T1, Mat3.multiply(S, T2)));
  },
};

/* ════════════════════════════════════════════════
   §2  STRUKTUR DATA GRAPH (Adjacency List)
════════════════════════════════════════════════ */
class CityGraph {
  constructor() {
    /** @type {Map<number, {id:number, x:number, y:number, label:string, type:string}>} */
    this.nodes = new Map();
    /** @type {Map<number, Array<{to:number, weight:number, curved:boolean, cp:{x,y}|null, laneType:string}>>} */
    this.adj   = new Map();
    /** @type {Array<{from:number, to:number, curved:boolean, cp:{x,y}|null, laneType:string}>} */
    this.edges = [];
    this.nextId = 0;
  }

  addNode(x, y, type = 'intersection', label = null) {
    const id = this.nextId++;
    this.nodes.set(id, { id, x, y, label: label ?? `N${id}`, type });
    this.adj.set(id, []);
    return id;
  }

  addEdge(a, b, curved = false, cp = null, laneType = 'minor') {
    if (!this.nodes.has(a) || !this.nodes.has(b)) return;
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    const dx = nb.x - na.x, dy = nb.y - na.y;
    const weight = Math.sqrt(dx*dx + dy*dy);

    this.adj.get(a).push({ to: b, weight, curved, cp, laneType });
    this.adj.get(b).push({ to: a, weight, curved, cp, laneType });
    this.edges.push({ from: a, to: b, curved, cp, laneType });
  }

  /* ── BFS dari source s ─────────────────────────────── */
  bfs(start) {
    const visited = new Set();
    const order   = [];
    const queue   = [start];
    visited.add(start);

    while (queue.length) {
      const u = queue.shift();
      order.push(u);
      for (const { to } of (this.adj.get(u) ?? [])) {
        if (!visited.has(to)) {
          visited.add(to);
          queue.push(to);
        }
      }
    }
    return { visited, order };
  }

  /* ── DFS dari source s ─────────────────────────────── */
  dfs(start) {
    const visited = new Set();
    const order   = [];
    const stack   = [start];

    while (stack.length) {
      const u = stack.pop();
      if (visited.has(u)) continue;
      visited.add(u);
      order.push(u);
      for (const { to } of (this.adj.get(u) ?? [])) {
        if (!visited.has(to)) stack.push(to);
      }
    }
    return { visited, order };
  }

  /* ── Cek koneksi penuh ─────────────────────────────── */
  isFullyConnected() {
    if (this.nodes.size === 0) return true;
    const startId = this.nodes.keys().next().value;
    const { visited } = this.bfs(startId);
    return visited.size === this.nodes.size;
  }

  /* ── Tambah edge agar graph terhubung (Spanning) ────── */
  ensureConnected(rng) {
    if (this.nodes.size < 2) return;
    const startId = this.nodes.keys().next().value;
    const { visited } = this.bfs(startId);

    for (const [id] of this.nodes) {
      if (!visited.has(id)) {
        // Temukan node terdekat yg sudah terhubung
        let closest = -1, minD = Infinity;
        const ni = this.nodes.get(id);
        for (const vid of visited) {
          const nv = this.nodes.get(vid);
          const d = Math.hypot(ni.x - nv.x, ni.y - nv.y);
          if (d < minD) { minD = d; closest = vid; }
        }
        if (closest !== -1) {
          const isCurved = rng.next() > 0.5;
          const ni2 = this.nodes.get(id);
          const nc  = this.nodes.get(closest);
          const cp  = isCurved ? {
            x: (ni2.x + nc.x) / 2 + rng.range(-60, 60),
            y: (ni2.y + nc.y) / 2 + rng.range(-60, 60),
          } : null;
          this.addEdge(id, closest, isCurved, cp, 'minor');
          visited.add(id);
        }
      }
    }
  }
}

/* ════════════════════════════════════════════════
   §3  GENERATOR PETA KOTA
════════════════════════════════════════════════ */
function generateCity(nodeCount, seed) {
  const rng   = SeededRNG(seed);
  const graph = new CityGraph();

  const W = 900, H = 700;
  const MARGIN = 60;

  /* ── 3A. Grid blok kota utama ─────────────────────── */
  const COLS = Math.ceil(Math.sqrt(nodeCount * 1.4));
  const ROWS = Math.ceil(nodeCount / COLS);
  const cellW = (W - MARGIN * 2) / (COLS - 1 || 1);
  const cellH = (H - MARGIN * 2) / (ROWS - 1 || 1);

  const gridIds = [];
  let placed = 0;

  for (let r = 0; r < ROWS && placed < nodeCount; r++) {
    gridIds[r] = [];
    for (let c = 0; c < COLS && placed < nodeCount; c++) {
      const jitter = 18;
      const x = MARGIN + c * cellW + rng.range(-jitter, jitter);
      const y = MARGIN + r * cellH + rng.range(-jitter, jitter);
      const type = (r === 0 || r === ROWS-1 || c === 0 || c === COLS-1) ? 'endpoint' : 'intersection';
      gridIds[r][c] = graph.addNode(
        Math.max(MARGIN, Math.min(W - MARGIN, x)),
        Math.max(MARGIN, Math.min(H - MARGIN, y)),
        type
      );
      placed++;
    }
  }

  /* ── 3B. Edge grid (horizontal + vertikal) ────────── */
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < (gridIds[r]?.length ?? 0); c++) {
      const id = gridIds[r][c];
      if (id === undefined) continue;

      // Horizontal
      if (c + 1 < (gridIds[r]?.length ?? 0)) {
        const idR = gridIds[r][c + 1];
        if (idR !== undefined) {
          const isCurved = rng.next() > 0.85; // Kurva lebih jarang
          const na = graph.nodes.get(id), nb = graph.nodes.get(idR);
          const cp = isCurved ? {
            x: (na.x + nb.x) / 2 + rng.range(-12, 12), // Offset lebih kecil
            y: (na.y + nb.y) / 2 + rng.range(-18, 18),
          } : null;
          graph.addEdge(id, idR, isCurved, cp, r === 0 || r === ROWS - 1 ? 'highway' : 'main');
        }
      }

      // Vertikal
      if (r + 1 < ROWS && gridIds[r + 1]?.[c] !== undefined) {
        const idD = gridIds[r + 1][c];
        const isCurved = rng.next() > 0.85;
        const na = graph.nodes.get(id), nb = graph.nodes.get(idD);
        const cp = isCurved ? {
          x: (na.x + nb.x) / 2 + rng.range(-18, 18),
          y: (na.y + nb.y) / 2 + rng.range(-12, 12),
        } : null;
        graph.addEdge(id, idD, isCurved, cp, c === 0 || c === COLS - 1 ? 'highway' : 'main');
      }
    }
  }

  /* ── 3C. Extra diagonal / shortcut edges ──────────── */
  const allIds = [...graph.nodes.keys()];
  const extraCount = Math.floor(nodeCount * 0.25); // Lebih sedikit edge extra
  for (let i = 0; i < extraCount; i++) {
    const a = allIds[rng.int(0, allIds.length - 1)];
    const b = allIds[rng.int(0, allIds.length - 1)];
    if (a === b) continue;
    // Avoid duplicate edges
    const alreadyConnected = graph.adj.get(a).some(e => e.to === b);
    if (alreadyConnected) continue;
    const na = graph.nodes.get(a), nb = graph.nodes.get(b);
    const dist = Math.hypot(na.x - nb.x, na.y - nb.y);
    if (dist < 220 && dist > 40) {
      const isCurved = rng.next() > 0.75; // Lebih jarang kurva
      const cp = isCurved ? {
        x: (na.x + nb.x) / 2 + rng.range(-25, 25), // Offset lebih kecil
        y: (na.y + nb.y) / 2 + rng.range(-25, 25),
      } : null;
      graph.addEdge(a, b, isCurved, cp, 'minor');
    }
  }

  /* ── 3D. Bundaran (roundabout) node ───────────────── */
  const roundaboutCount = Math.max(2, Math.floor(nodeCount / 12));
  const rbNodes = [];
  for (let i = 0; i < roundaboutCount; i++) {
    const id = graph.addNode(
      rng.range(MARGIN + 80, W - MARGIN - 80),
      rng.range(MARGIN + 80, H - MARGIN - 80),
      'roundabout',
      `RB${i}`
    );
    rbNodes.push(id);
  }
  // Hubungkan bundaran ke 3-4 node terdekat (lebih sedikit dan lurus)
  for (const rbId of rbNodes) {
    const rb = graph.nodes.get(rbId);
    const sorted = allIds
      .filter(id => id !== rbId)
      .map(id => ({ id, d: Math.hypot(graph.nodes.get(id).x - rb.x, graph.nodes.get(id).y - rb.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);

    for (const { id } of sorted) {
      const alreadyConnected = graph.adj.get(rbId).some(e => e.to === id);
      if (alreadyConnected) continue;
      const nb = graph.nodes.get(id);
      // Sebagian besar lurus, minimal kurva
      const isCurved = rng.next() > 0.8;
      const cp = isCurved ? {
        x: (rb.x + nb.x) / 2 + rng.range(-20, 20),
        y: (rb.y + nb.y) / 2 + rng.range(-20, 20),
      } : null;
      graph.addEdge(rbId, id, isCurved, cp, 'main');
    }
  }

  /* ── 3E. Pastikan connected ───────────────────────── */
  graph.ensureConnected(rng);

  /* ── 3F. Generate Bangunan di antara blok ─────────── */
  const buildings = generateBuildings(graph, rng, W, H);

  return { graph, buildings, rng };
}

/* ════════════════════════════════════════════════
   §4  GENERATOR BANGUNAN
════════════════════════════════════════════════ */
function generateBuildings(graph, rng, W, H) {
  const buildings = [];
  const TYPES = ['residential', 'commercial', 'industrial', 'park'];
  const count = 28 + rng.int(0, 12);
  const ROAD_BUFFER = 36; // Buffer dari jalan/node

  // Helper: cek jarak dari titik ke garis (edge)
  function distToLineSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    return Math.hypot(px - closestX, py - closestY);
  }

  // Buat daftar obstacle: nodes + edges
  const obstacles = [];
  
  // Tambah nodes sebagai circular obstacle
  for (const [, n] of graph.nodes) {
    obstacles.push({ type: 'node', x: n.x, y: n.y, r: ROAD_BUFFER });
  }
  
  // Tambah edges sebagai line obstacle
  for (const edge of graph.edges) {
    const na = graph.nodes.get(edge.from);
    const nb = graph.nodes.get(edge.to);
    if (na && nb) {
      obstacles.push({ type: 'edge', x1: na.x, y1: na.y, x2: nb.x, y2: nb.y });
    }
  }

  for (let i = 0; i < count; i++) {
    let validPos = false;
    let x, y;
    
    // Coba posisi random hingga menemukan tempat yang aman
    for (let attempt = 0; attempt < 15; attempt++) {
      x = rng.range(50, W - 50);
      y = rng.range(50, H - 50);

      // Cek jarak ke semua obstacles
      let tooClose = false;
      for (const obs of obstacles) {
        if (obs.type === 'node') {
          if (Math.hypot(obs.x - x, obs.y - y) < obs.r) {
            tooClose = true;
            break;
          }
        } else if (obs.type === 'edge') {
          const dist = distToLineSegment(x, y, obs.x1, obs.y1, obs.x2, obs.y2);
          if (dist < ROAD_BUFFER) {
            tooClose = true;
            break;
          }
        }
      }
      
      if (!tooClose) {
        validPos = true;
        break;
      }
    }
    
    if (!validPos) continue;

    const type = TYPES[rng.int(0, TYPES.length - 1)];
    const w = rng.range(14, type === 'commercial' ? 36 : 28);
    const h = rng.range(14, type === 'industrial' ? 40 : 26);
    buildings.push({ x, y, w, h, type, floors: rng.int(1, 8) });
  }
  return buildings;
}

/* ════════════════════════════════════════════════
   §5  SISTEM KENDARAAN
════════════════════════════════════════════════ */
class Vehicle {
  constructor(graph, rng) {
    this.graph  = graph;
    this.rng    = rng;
    this.t      = rng.next();            // posisi di edge [0..1]
    this.speed  = rng.range(0.001, 0.004);
    this.type   = rng.next() > 0.7 ? 'truck' : 'car';
    this.color  = this._pickColor();
    this._pickEdge();
  }

  _pickColor() {
    const cols = ['#ffb300','#ff3d5a','#00e5ff','#a78bfa','#00e676','#ffffff'];
    return cols[Math.floor(this.rng.next() * cols.length)];
  }

  _pickEdge() {
    const edges = this.graph.edges;
    if (!edges.length) return;
    const e = edges[Math.floor(this.rng.next() * edges.length)];
    this.edgeFrom = e.from;
    this.edgeTo   = e.to;
    this.curved   = e.curved;
    this.cp       = e.cp;
    this.t        = 0;
    this.dir      = this.rng.next() > 0.5 ? 1 : -1;
  }

  /** Hitung posisi di kurva Bezier kuadratik atau garis lurus */
  getPosition() {
    const na = this.graph.nodes.get(this.edgeFrom);
    const nb = this.graph.nodes.get(this.edgeTo);
    if (!na || !nb) return { x: 0, y: 0, angle: 0 };

    const tt = this.dir > 0 ? this.t : 1 - this.t;

    if (this.curved && this.cp) {
      const cp = this.cp;
      const x = (1-tt)*(1-tt)*na.x + 2*(1-tt)*tt*cp.x + tt*tt*nb.x;
      const y = (1-tt)*(1-tt)*na.y + 2*(1-tt)*tt*cp.y + tt*tt*nb.y;
      // Tangent
      const dt = 0.01;
      const t2 = Math.min(tt + dt, 1);
      const x2 = (1-t2)*(1-t2)*na.x + 2*(1-t2)*t2*cp.x + t2*t2*nb.x;
      const y2 = (1-t2)*(1-t2)*na.y + 2*(1-t2)*t2*cp.y + t2*t2*nb.y;
      return { x, y, angle: Math.atan2(y2 - y, x2 - x) };
    } else {
      const x = na.x + tt * (nb.x - na.x);
      const y = na.y + tt * (nb.y - na.y);
      const angle = Math.atan2(nb.y - na.y, nb.x - na.x) * (this.dir > 0 ? 1 : -1);
      return { x, y, angle };
    }
  }

  update(speedMul) {
    this.t += this.speed * speedMul;
    if (this.t >= 1) this._pickEdge();
  }
}

/* ════════════════════════════════════════════════
   §6  RENDERER — semua gambar di Canvas
════════════════════════════════════════════════ */
function renderMap(ctx, graph, buildings, vehicles, viewMatrix, highlightSet, W, H) {
  ctx.clearRect(0, 0, W, H);

  /* ── Latar ground ─────────────────────────────────── */
  ctx.fillStyle = '#07090f';
  ctx.fillRect(0, 0, W, H);

  /* Kisi latar (grid kota) */
  drawGrid(ctx, viewMatrix, W, H);

  /* ── Bangunan (di bawah jalan) ───────────────────── */
  for (const b of buildings) {
    drawBuilding(ctx, b, viewMatrix);
  }

  /* ── Edges / Jalan ────────────────────────────────── */
  for (const edge of graph.edges) {
    const na = graph.nodes.get(edge.from);
    const nb = graph.nodes.get(edge.to);
    if (!na || !nb) continue;

    const pa = Mat3.applyPoint(viewMatrix, na.x, na.y);
    const pb = Mat3.applyPoint(viewMatrix, nb.x, nb.y);

    // Konfigurasi visual per tipe lane
    const cfg = {
      highway: { width: 6, color: '#c8d6ff', shadowBlur: 6, shadowColor: '#5572ff44' },
      main:    { width: 3.5, color: '#8899cc', shadowBlur: 3, shadowColor: '#3355ff22' },
      minor:   { width: 2, color: '#4a5a80', shadowBlur: 0, shadowColor: 'transparent' },
    }[edge.laneType] ?? { width: 2, color: '#4a5a80', shadowBlur: 0 };

    ctx.save();
    
    // Jika ada highlight (BFS/DFS), tampilkan path yang dilalui lebih terang
    if (highlightSet.size > 0) {
      if (highlightSet.has(edge.from) && highlightSet.has(edge.to)) {
        // Edge yang ada dalam traversal path
        ctx.strokeStyle = edge.laneType === 'highway' ? '#ffe066' : '#ffd700';
        ctx.lineWidth = cfg.width + 2;
        ctx.shadowBlur = 12;
        ctx.shadowColor = '#ffe06688';
        ctx.globalAlpha = 1;
      } else {
        // Edge yang tidak dalam path - dim
        ctx.globalAlpha = 0.15;
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = cfg.width;
        ctx.shadowBlur = 0;
      }
    } else {
      ctx.strokeStyle = cfg.color;
      ctx.lineWidth   = cfg.width;
      ctx.shadowBlur  = cfg.shadowBlur;
      ctx.shadowColor = cfg.shadowColor;
    }

    ctx.lineCap = 'round';

    ctx.beginPath();
    if (edge.curved && edge.cp) {
      const pc = Mat3.applyPoint(viewMatrix, edge.cp.x, edge.cp.y);
      ctx.moveTo(pa.x, pa.y);
      ctx.quadraticCurveTo(pc.x, pc.y, pb.x, pb.y);
    } else {
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ── Nodes / Persimpangan ─────────────────────────── */
  for (const [, node] of graph.nodes) {
    const p = Mat3.applyPoint(viewMatrix, node.x, node.y);
    drawNode(ctx, p.x, p.y, node.type, highlightSet.has(node.id), node.id);
  }

  /* ── Kendaraan ────────────────────────────────────── */
  for (const v of vehicles) {
    const raw = v.getPosition();
    const p   = Mat3.applyPoint(viewMatrix, raw.x, raw.y);
    drawVehicle(ctx, p.x, p.y, raw.angle, v.type, v.color);
  }
}

/* ── Gambar grid latar ─────────────────────────────── */
function drawGrid(ctx, M, W, H) {
  const step = 50;
  ctx.save();
  ctx.strokeStyle = '#12182e';
  ctx.lineWidth   = 1;

  for (let gx = -500; gx < 1400; gx += step) {
    const pa = Mat3.applyPoint(M, gx, -200);
    const pb = Mat3.applyPoint(M, gx, 900);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }
  for (let gy = -200; gy < 900; gy += step) {
    const pa = Mat3.applyPoint(M, -500, gy);
    const pb = Mat3.applyPoint(M, 1400, gy);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }
  ctx.restore();
}

/* ── Gambar node persimpangan / bundaran ──────────────── */
function drawNode(ctx, x, y, type, highlighted, nodeId) {
  ctx.save();
  if (type === 'roundabout') {
    // Bundaran: lingkaran besar dengan inner
    const r = 12;
    ctx.strokeStyle = highlighted ? '#ffe066' : '#00e5ff';
    ctx.fillStyle   = '#0d1220';
    ctx.lineWidth   = 2.5;
    ctx.shadowBlur  = highlighted ? 18 : 10;
    ctx.shadowColor = highlighted ? '#ffe066' : '#00e5ff';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = highlighted ? '#ffe066aa' : '#00e5ff55';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.stroke();
  } else if (type === 'endpoint') {
    ctx.fillStyle   = highlighted ? '#ffe066' : '#ff3d5a';
    ctx.shadowBlur  = highlighted ? 14 : 8;
    ctx.shadowColor = highlighted ? '#ffe066' : '#ff3d5a';
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle   = highlighted ? '#ffe066' : '#00e5ff';
    ctx.shadowBlur  = highlighted ? 14 : 6;
    ctx.shadowColor = highlighted ? '#ffe066' : '#00e5ff';
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  
  // Tampilkan label node (ID)
  ctx.font = 'bold 10px Syne Mono';
  ctx.fillStyle = highlighted ? '#ffe066' : '#00e5ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(nodeId.toString(), x, y - 8);
  
  ctx.restore();
}

/* ── Gambar bangunan ──────────────────────────────────── */
function drawBuilding(ctx, b, M) {
  const corners = [
    Mat3.applyPoint(M, b.x - b.w/2, b.y - b.h/2),
    Mat3.applyPoint(M, b.x + b.w/2, b.y - b.h/2),
    Mat3.applyPoint(M, b.x + b.w/2, b.y + b.h/2),
    Mat3.applyPoint(M, b.x - b.w/2, b.y + b.h/2),
  ];

  const COLORS = {
    residential: { fill: '#141e34', stroke: '#2a3a60' },
    commercial:  { fill: '#1a1f3a', stroke: '#3d5aff' },
    industrial:  { fill: '#1a1510', stroke: '#604020' },
    park:        { fill: '#0d2010', stroke: '#1a4020' },
  };
  const col = COLORS[b.type] ?? COLORS.residential;

  ctx.save();
  ctx.fillStyle   = col.fill;
  ctx.strokeStyle = col.stroke;
  ctx.lineWidth   = 1;
  ctx.shadowBlur  = b.type === 'commercial' ? 6 : 0;
  ctx.shadowColor = '#3d5aff44';

  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Jendela (untuk bangunan komersial & residensial)
  if (b.type !== 'park') {
    const winCount = Math.min(b.floors, 4);
    const wStep = (corners[1].x - corners[0].x) / (winCount + 1);
    const hStep = (corners[2].y - corners[1].y) / (winCount + 1);
    ctx.fillStyle = b.type === 'commercial' ? '#3d5aff44' : '#ffd70022';
    for (let wi = 1; wi <= winCount; wi++) {
      for (let hi = 1; hi <= winCount; hi++) {
        const wx = corners[0].x + wi * wStep;
        const wy = corners[0].y + hi * hStep;
        const ws = Math.max(1, wStep * 0.35);
        ctx.fillRect(wx - ws/2, wy - ws/2, ws, ws);
      }
    }
  }
  ctx.restore();
}

/* ── Gambar kendaraan ─────────────────────────────────── */
function drawVehicle(ctx, x, y, angle, type, color) {
  const L = type === 'truck' ? 10 : 7;
  const W = type === 'truck' ?  5 : 3.5;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // Body
  ctx.fillStyle   = color;
  ctx.shadowBlur  = 8;
  ctx.shadowColor = color;
  ctx.beginPath();
  ctx.roundRect(-L/2, -W/2, L, W, 1.5);
  ctx.fill();

  // Lampu depan
  ctx.fillStyle = '#fffde7';
  ctx.shadowBlur = 5;
  ctx.shadowColor = '#fffde7';
  ctx.beginPath(); ctx.arc(L/2 - 1, -W/2 + 1, 1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(L/2 - 1,  W/2 - 1, 1, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

/* ════════════════════════════════════════════════
   §7  APLIKASI UTAMA
════════════════════════════════════════════════ */
(function App() {
  /* ── Canvas setup ─────────────────────────────────── */
  const canvas  = document.getElementById('mapCanvas');
  const ctx     = canvas.getContext('2d');
  const wrapper = document.getElementById('canvasWrapper');

  function resizeCanvas() {
    canvas.width  = wrapper.clientWidth;
    canvas.height = wrapper.clientHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', () => { resizeCanvas(); requestRender(); });

  /* ── State ────────────────────────────────────────── */
  let graph     = new CityGraph();
  let buildings = [];
  let vehicles  = [];
  let rngRef    = null;

  // Transformasi: scale, tx, ty (dikelola MANUAL via Mat3)
  let viewScale = 1;
  let viewTx    = 0;
  let viewTy    = 0;

  let highlightSet  = new Set();
  let animRunning   = true;
  let vehicleSpeed  = 1.0;
  let animFrameId   = null;

  // State untuk animasi BFS/DFS
  let traversalAnimating = false;
  let traversalOrder = [];
  let traversalStep = 0;
  let traversalSpeed = 100; // ms per node

  /* ── UI Refs ──────────────────────────────────────── */
  const cfgNodes    = document.getElementById('cfgNodes');
  const cfgNodesVal = document.getElementById('cfgNodesVal');
  const cfgSeed     = document.getElementById('cfgSeed');
  const cfgScale    = document.getElementById('cfgScale');
  const cfgScaleVal = document.getElementById('cfgScaleVal');
  const cfgTx       = document.getElementById('cfgTx');
  const cfgTxVal    = document.getElementById('cfgTxVal');
  const cfgTy       = document.getElementById('cfgTy');
  const cfgTyVal    = document.getElementById('cfgTyVal');
  const cfgSpeed    = document.getElementById('cfgSpeed');
  const cfgSpeedVal = document.getElementById('cfgSpeedVal');
  const zoomLabel   = document.getElementById('zoomLabel');
  const matrixText  = document.getElementById('matrixText');
  const logBox      = document.getElementById('logBox');
  const nodeTooltip = document.getElementById('nodeTooltip');
  const statNodes   = document.getElementById('stat-nodes');
  const statEdges   = document.getElementById('stat-edges');
  const statConn    = document.getElementById('stat-connected');

  /* ── Bangun matriks tampilan ──────────────────────── */
  function getViewMatrix() {
    const cx = canvas.width  / 2;
    const cy = canvas.height / 2;
    return Mat3.buildViewMatrix(viewScale, viewTx, viewTy, cx, cy);
  }

  /* ── Update tampilan matriks di UI ───────────────── */
  function updateMatrixDisplay() {
    const s  = viewScale.toFixed(3);
    const tx = viewTx.toFixed(1);
    const ty = viewTy.toFixed(1);
    matrixText.textContent =
      `[ ${s}    0    ${tx} ]\n` +
      `[  0    ${s}  ${ty} ]\n` +
      `[  0      0      1  ]`;
    zoomLabel.textContent = `${Math.round(viewScale * 100)}%`;
    cfgScale.value = viewScale;
    cfgScaleVal.textContent = viewScale.toFixed(2) + '×';
    cfgTx.value   = viewTx;
    cfgTxVal.textContent = viewTx.toFixed(0) + ' px';
    cfgTy.value   = viewTy;
    cfgTyVal.textContent = viewTy.toFixed(0) + ' px';
  }

  /* ── Log helper ───────────────────────────────────── */
  function log(msg, cls = '') {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = msg;
    logBox.appendChild(p);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function clearLog() { logBox.innerHTML = ''; }

  /* ══════════════════════════════════════════════════
     GENERATE PETA
  ══════════════════════════════════════════════════ */
  function generate() {
    const nodeCount = parseInt(cfgNodes.value);
    const seed      = parseInt(cfgSeed.value);
    const result    = generateCity(nodeCount, seed);
    graph           = result.graph;
    buildings       = result.buildings;
    rngRef          = result.rng;

    // Generate kendaraan
    vehicles = [];
    const vCount = Math.max(8, Math.floor(nodeCount * 0.8));
    for (let i = 0; i < vCount; i++) {
      vehicles.push(new Vehicle(graph, SeededRNG(seed + i * 7)));
    }

    // Stats
    statNodes.textContent = `Nodes: ${graph.nodes.size}`;
    statEdges.textContent = `Edges: ${graph.edges.length}`;
    const connected = graph.isFullyConnected();
    statConn.textContent  = `Graph: ${connected ? '✓ Connected' : '✗ Disconnected'}`;
    statConn.className    = 'stat-chip ' + (connected ? 'connected' : '');

    // Reset view
    viewScale = 1; viewTx = 0; viewTy = 0;
    highlightSet.clear();
    traversalAnimating = false;
    traversalStep = 0;
    traversalOrder = [];
    updateMatrixDisplay();

    clearLog();
    log(`✓ Graph digenerate: ${graph.nodes.size} node, ${graph.edges.length} edge`, 'log-ok');
    log(`  Seed: ${seed} | Kendaraan: ${vehicles.length}`, 'log-ok');
    log(`  Konektivitas: ${connected ? 'FULLY CONNECTED ✓' : 'DISCONNECTED ✗'}`,
        connected ? 'log-ok' : 'log-warn');

    requestRender();
  }

  /* ══════════════════════════════════════════════════
     BFS / DFS
  ══════════════════════════════════════════════════ */
  function runBFS() {
    if (!graph.nodes.size) return;
    clearLog();
    const startId = graph.nodes.keys().next().value;
    const t0 = performance.now();
    const { visited, order } = graph.bfs(startId);
    const ms = (performance.now() - t0).toFixed(2);

    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'log-bfs');
    log(`⊙ BREADTH-FIRST SEARCH (BFS)`, 'log-bfs');
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'log-bfs');
    log(`🔴 Mulai dari: Node #${startId}`, 'log-bfs');
    log(`📊 Algoritma: QUEUE (FIFO) - menjelajahi per LEVEL`, 'log-bfs');
    log(`🎬 Menganimasikan...`, 'log-bfs');
    log(`  Waktu komputasi: ${ms}ms`, 'log-bfs');

    // Start traversal animation
    traversalAnimating = true;
    traversalOrder = order;
    traversalStep = 0;
    highlightSet.clear();
    
    // Ensure animation loop is running
    if (!animFrameId) animFrameId = requestAnimationFrame(animLoop);
    requestRender();
  }

  function runDFS() {
    if (!graph.nodes.size) return;
    clearLog();
    const startId = graph.nodes.keys().next().value;
    const t0 = performance.now();
    const { visited, order } = graph.dfs(startId);
    const ms = (performance.now() - t0).toFixed(2);

    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'log-dfs');
    log(`⊙ DEPTH-FIRST SEARCH (DFS)`, 'log-dfs');
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'log-dfs');
    log(`🔴 Mulai dari: Node #${startId}`, 'log-dfs');
    log(`📊 Algoritma: STACK (LIFO) - menjelajahi DALAM SEBELUM LUAS`, 'log-dfs');
    log(`🎬 Menganimasikan...`, 'log-dfs');
    log(`  Waktu komputasi: ${ms}ms`, 'log-dfs');

    // Start traversal animation
    traversalAnimating = true;
    traversalOrder = order;
    traversalStep = 0;
    highlightSet.clear();
    
    // Ensure animation loop is running
    if (!animFrameId) animFrameId = requestAnimationFrame(animLoop);
    requestRender();
  }

  /* ══════════════════════════════════════════════════
     RENDER LOOP
  ══════════════════════════════════════════════════ */
  let lastTraversalTime = 0;

  function updateTraversalAnimation(currentTime) {
    if (!traversalAnimating || traversalOrder.length === 0) return;

    // Kontrol kecepatan animasi
    if (currentTime - lastTraversalTime < traversalSpeed) return;

    lastTraversalTime = currentTime;
    
    if (traversalStep < traversalOrder.length) {
      const nodeId = traversalOrder[traversalStep];
      highlightSet.add(nodeId);
      traversalStep++;
    } else {
      // Animasi selesai
      traversalAnimating = false;
      const visited = highlightSet.size;
      const total = graph.nodes.size;
      log(``, '');
      log(`✓ Traversal selesai! ${visited}/${total} node dikunjungi.`, 'log-ok');
    }
  }

  function requestRender() {
    if (animRunning) return; // sudah ada loop
    drawFrame();
  }

  function drawFrame() {
    const M = getViewMatrix();
    renderMap(ctx, graph, buildings, vehicles, M, highlightSet, canvas.width, canvas.height);
  }

  function animLoop() {
    if (!animRunning && !traversalAnimating) { animFrameId = null; return; }
    
    const now = performance.now();
    
    // Update vehicles
    if (animRunning) {
      for (const v of vehicles) v.update(vehicleSpeed);
    }
    
    // Update traversal animation
    if (traversalAnimating) {
      updateTraversalAnimation(now);
    }
    
    drawFrame();
    animFrameId = requestAnimationFrame(animLoop);
  }

  function startAnim() {
    animRunning = true;
    if (!animFrameId) animFrameId = requestAnimationFrame(animLoop);
  }

  function stopAnim() {
    animRunning = false;
    drawFrame();
  }

  /* ══════════════════════════════════════════════════
     ZOOM & PAN (Manual Matrix — No ctx.scale/translate)
  ══════════════════════════════════════════════════ */

  /**
   * Zoom di sekitar titik (px, py) di layar.
   * Rumus: tx' = px - s' * (px - tx) / s  (mempertahankan posisi kursor)
   * Di sini disederhanakan menjadi zoom di tengah + offset pan.
   */
  function applyZoom(factor, pivotX, pivotY) {
    const prevScale = viewScale;
    viewScale = Math.max(0.15, Math.min(8, viewScale * factor));

    const cx = canvas.width  / 2;
    const cy = canvas.height / 2;

    // Adjust tx/ty agar zoom terjadi di sekitar pivot (kursor)
    // Rumus: tx' = pivotX + (tx - pivotX) * (newScale / oldScale) — diubah ke offset dari tengah
    const ratio = viewScale / prevScale;
    viewTx = pivotX + (viewTx + cx - pivotX) * ratio - cx;
    viewTy = pivotY + (viewTy + cy - pivotY) * ratio - cy;

    updateMatrixDisplay();
  }

  /* Wheel zoom ─────────────────────────────────────── */
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect   = canvas.getBoundingClientRect();
    const px     = e.clientX - rect.left;
    const py     = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    applyZoom(factor, px, py);
    drawFrame();
  }, { passive: false });

  /* Drag pan ───────────────────────────────────────── */
  let isDragging = false, dragStart = { x: 0, y: 0 };
  canvas.addEventListener('mousedown', e => {
    isDragging = true;
    dragStart  = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('mousemove', e => {
    if (isDragging) {
      viewTx += e.clientX - dragStart.x;
      viewTy += e.clientY - dragStart.y;
      dragStart = { x: e.clientX, y: e.clientY };
      updateMatrixDisplay();
      drawFrame();
    }

    // Tooltip: node terdekat
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const M  = getViewMatrix();
    let nearNode = null, nearDist = 14;
    for (const [, n] of graph.nodes) {
      const p = Mat3.applyPoint(M, n.x, n.y);
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < nearDist) { nearDist = d; nearNode = n; }
    }
    if (nearNode) {
      nodeTooltip.style.left    = (mx + 14) + 'px';
      nodeTooltip.style.top     = (my - 10) + 'px';
      nodeTooltip.style.display = 'block';
      nodeTooltip.textContent   = `${nearNode.label} [${nearNode.type}] (${nearNode.x.toFixed(0)}, ${nearNode.y.toFixed(0)})`;
    } else {
      nodeTooltip.style.display = 'none';
    }
  });
  canvas.addEventListener('mouseup',    () => { isDragging = false; });
  canvas.addEventListener('mouseleave', () => { isDragging = false; nodeTooltip.style.display = 'none'; });

  /* Touch pan & pinch zoom ─────────────────────────── */
  let lastTouches = [];
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    lastTouches = [...e.touches];
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && lastTouches.length === 1) {
      viewTx += e.touches[0].clientX - lastTouches[0].clientX;
      viewTy += e.touches[0].clientY - lastTouches[0].clientY;
      updateMatrixDisplay(); drawFrame();
    } else if (e.touches.length === 2 && lastTouches.length === 2) {
      const d0 = Math.hypot(lastTouches[0].clientX - lastTouches[1].clientX, lastTouches[0].clientY - lastTouches[1].clientY);
      const d1 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const pivotX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const pivotY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      applyZoom(d1 / d0, pivotX, pivotY);
      drawFrame();
    }
    lastTouches = [...e.touches];
  }, { passive: false });

  /* ══════════════════════════════════════════════════
     EVENT LISTENERS (UI Controls)
  ══════════════════════════════════════════════════ */
  cfgNodes.addEventListener('input', () => {
    cfgNodesVal.textContent = cfgNodes.value;
  });

  cfgScale.addEventListener('input', () => {
    viewScale = parseFloat(cfgScale.value);
    updateMatrixDisplay();
    drawFrame();
  });

  cfgTx.addEventListener('input', () => {
    viewTx = parseFloat(cfgTx.value);
    updateMatrixDisplay();
    drawFrame();
  });

  cfgTy.addEventListener('input', () => {
    viewTy = parseFloat(cfgTy.value);
    updateMatrixDisplay();
    drawFrame();
  });

  cfgSpeed.addEventListener('input', () => {
    vehicleSpeed = parseFloat(cfgSpeed.value);
    cfgSpeedVal.textContent = vehicleSpeed.toFixed(1) + '×';
  });

  document.getElementById('btnGenerate').addEventListener('click', generate);
  document.getElementById('btnBFS').addEventListener('click', runBFS);
  document.getElementById('btnDFS').addEventListener('click', runDFS);

  document.getElementById('btnZoomIn').addEventListener('click', () => {
    applyZoom(1.25, canvas.width / 2, canvas.height / 2);
    drawFrame();
  });
  document.getElementById('btnZoomOut').addEventListener('click', () => {
    applyZoom(1 / 1.25, canvas.width / 2, canvas.height / 2);
    drawFrame();
  });
  document.getElementById('btnReset').addEventListener('click', () => {
    viewScale = 1; viewTx = 0; viewTy = 0;
    highlightSet.clear();
    traversalAnimating = false;
    traversalStep = 0;
    traversalOrder = [];
    updateMatrixDisplay();
    drawFrame();
  });

  document.getElementById('btnToggleAnim').addEventListener('click', function () {
    if (animRunning) {
      stopAnim();
      this.textContent = '▶ Resume Kendaraan';
    } else {
      startAnim();
      this.textContent = '⏸ Pause Kendaraan';
    }
  });

  /* ── Init ─────────────────────────────────────────── */
  generate();
  startAnim();
  updateMatrixDisplay();

})();
