/**
 * 手工微调几何与规则：
 *  - 拖动松手后吸附到安全边 / 相邻照片的边或「标称间隙」位置
 *  - 任何调整都被钳制在安全边范围内，不允许跑出纸外
 *  - 旋转必须同时满足任务级与照片级许可（证件照方向有要求时不能转）
 *  - 跨纸移动：压掉空纸、压缩 sheetIndex，并在目标纸上寻找不重叠的落点
 * 调整结果的 guillotine 合法性由 packer.sheetsFromPlacements 重建并真实验证。
 */
import type { Paper, PhotoSize, Placement, Task } from './types'

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface AdjustContext {
  paper: Paper
  sizes: PhotoSize[]
  /** 相邻照片的标称净间距（刀口两侧各补 kerf/2，共边时净间距 = kerf） */
  kerf: number
  gap: number
  safeEdge: number
}

export function boundsOf(task: Task, paper: Paper): Bounds {
  const inset = paper.marginMm + task.safeEdgeMm
  return { minX: inset, minY: inset, maxX: paper.wMm - inset, maxY: paper.hMm - inset }
}

/** 相邻照片互不压住时，净间距的最小值（刀口补偿 + 用户设定间隙） */
export function clearGap(ctx: AdjustContext): number {
  return ctx.kerf + ctx.gap
}

export interface Rectish {
  x: number
  y: number
  w: number
  h: number
}

function overlaps(a: Rectish, b: Rectish, eps = 1e-6): boolean {
  return (
    a.x < b.x + b.w - eps &&
    b.x < a.x + a.w - eps &&
    a.y < b.y + b.h - eps &&
    b.y < a.y + a.h - eps
  )
}

/** 把照片矩形钳制在安全边范围内（绝不允许跑出纸外）；digits 控制坐标精度 */
export function clampToBounds(p: Placement, b: Bounds, digits = 1): Placement {
  const f = Math.pow(10, digits)
  const fix = (n: number) => Math.round(n * f) / f
  const x = Math.min(Math.max(p.x, b.minX), Math.max(b.minX, b.maxX - p.w))
  const y = Math.min(Math.max(p.y, b.minY), Math.max(b.minY, b.maxY - p.h))
  return { ...p, x: fix(x), y: fix(y) }
}

/** 该照片当前是否允许旋转 90°（任务级开关 + 该清单项许可，两者缺一不可） */
export function rotationAllowed(task: Task, p: Placement): boolean {
  if (!task.allowRotate) return false
  const item = task.items.find((i) => i.id === p.itemId)
  return !!item?.rotateAllowed
}

export function isSquare(p: Placement): boolean {
  return Math.abs(p.w - p.h) < 1e-6
}

/** 位置取整到 0.001mm：吸收浮点噪声，但不破坏自动排样的 0.01mm 级共边坐标 */
function roundPos(n: number): number {
  return Math.round(n * 1000) / 1000
}

interface AxisCandidate {
  /** 吸附后的坐标 */
  value: number
  /** 吸附依据（用于调试/提示） */
  kind: 'edge' | 'align' | 'gap'
  /** 与自由落点的偏差，越小越优先 */
  dist: number
}

/**
 * 单轴吸附：
 *  - edge：自身边对齐安全边
 *  - align：自身边与另一张照片的边齐平（一致间隙排版）
 *  - gap：与另一张照片保持标称净间距（kerf + gap）
 * 落在另一轴上投影不相交的邻居只参与「边对齐」，不参与「间隙」。
 */
function axisSnap(
  axis: 'x' | 'y',
  list: Placement[],
  seq: number,
  free: number,
  crossFree: number,
  w: number,
  h: number,
  b: Bounds,
  minClear: number,
  threshold: number,
): number {
  const lo = axis === 'x' ? b.minX : b.minY
  const hi = axis === 'x' ? b.maxX : b.maxY
  const size = axis === 'x' ? w : h
  const crossSize = axis === 'x' ? h : w
  const candidates: AxisCandidate[] = []
  const push = (value: number, kind: AxisCandidate['kind']) => {
    if (value < lo - 1e-6 || value + size > hi + 1e-6) return
    const dist = Math.abs(value - free)
    if (dist <= threshold + 1e-9) candidates.push({ value: roundPos(value), kind, dist })
  }

  // 安全边
  push(lo, 'edge')
  push(hi - size, 'edge')

  for (const o of list) {
    if (o.seq === seq) continue
    const oLo = axis === 'x' ? o.x : o.y
    const oHi = oLo + (axis === 'x' ? o.w : o.h)
    const cLo = axis === 'x' ? o.y : o.x
    const cHi = cLo + (axis === 'x' ? o.h : o.w)
    // 投影相交（含贴边）才构成「并排」关系
    const sideBySide = crossFree < cHi - 1e-6 && crossFree + crossSize > cLo + 1e-6
    // 边齐平（无论是否并排都可吸附，行列对齐）
    push(oLo, 'align')
    push(oHi - size, 'align')
    if (sideBySide) {
      // 自身左/上边 贴 邻居右/下边，净间距 = minClear
      push(oHi + minClear, 'gap')
      // 自身右/下边 贴 邻居左/上边
      push(oLo - minClear - size, 'gap')
    }
  }

  if (!candidates.length) return roundPos(free)
  // 吸附优先级：安全边 > 标称间隙 > 一般边齐平（前两者是需求明确要求的强磁铁），
  // 同类再按与自由落点的距离取最近
  const magnetic: Record<AxisCandidate['kind'], number> = { edge: 0.5, gap: 0.75, align: 1 }
  candidates.sort((a, c) => {
    const da = a.dist * magnetic[a.kind]
    const dc = c.dist * magnetic[c.kind]
    return da - dc < -1e-9 ? -1 : da - dc > 1e-9 ? 1 : a.dist - c.dist
  })

  const others = list.filter((p) => p.seq !== seq)
  // 选最近的候选；若吸附后与邻居重叠则依次尝试下一个
  for (const cand of candidates) {
    const trial: Rectish =
      axis === 'x'
        ? { x: cand.value, y: crossFree, w, h }
        : { x: crossFree, y: cand.value, w, h }
    if (!others.some((o) => overlaps(trial, o))) return cand.value
  }
  // 所有吸附候选都造成重叠（如狭窄夹缝）：保持自由落点，交给校验给结论
  return roundPos(free)
}

/**
 * 拖动松手：吸附到安全边与相邻照片。
 * thresholdMm 为物理吸附半径；x/y 独立吸附、独立钳制。
 */
export function snapPosition(
  list: Placement[],
  seq: number,
  rawX: number,
  rawY: number,
  ctx: AdjustContext,
  thresholdMm = 3,
): { x: number; y: number } {
  const self = list.find((p) => p.seq === seq)
  const b = boundsOfManual(ctx)
  if (!self) return { x: roundPos(rawX), y: roundPos(rawY) }
  const free = clampToBounds({ ...self, x: rawX, y: rawY }, b)
  const minClear = clearGap(ctx)
  const x = axisSnap('x', list, seq, free.x, free.y, self.w, self.h, b, minClear, thresholdMm)
  const y = axisSnap('y', list, seq, free.y, x, self.w, self.h, b, minClear, thresholdMm)
  const final = clampToBounds({ ...self, x, y }, b, 3)
  return { x: final.x, y: final.y }
}

function boundsOfManual(ctx: AdjustContext): Bounds {
  const inset = ctx.paper.marginMm + ctx.safeEdge
  return {
    minX: inset,
    minY: inset,
    maxX: ctx.paper.wMm - inset,
    maxY: ctx.paper.hMm - inset,
  }
}

/** 按 1mm（或 0.5mm）步长微调：精确步进，不做吸附；始终钳制在安全边内 */
export function nudgePosition(
  list: Placement[],
  seq: number,
  dx: number,
  dy: number,
  ctx: AdjustContext,
): { x: number; y: number } {
  const self = list.find((p) => p.seq === seq)
  const b = boundsOfManual(ctx)
  if (!self) return { x: 0, y: 0 }
  const next = clampToBounds({ ...self, x: self.x + dx, y: self.y + dy }, b, 4)
  return { x: next.x, y: next.y }
}

/** 旋转 90°：以中心为轴翻转宽高，再钳制回安全边内 */
export function rotatedPlacement(p: Placement): Placement {
  return { ...p, w: p.h, h: p.w, rotated: !p.rotated }
}

/** 压缩 sheetIndex：删掉空纸后，后面的纸整体前移，保证纸张连续编号 */
export function compactSheetIndices(list: Placement[]): Placement[] {
  const used = new Set(list.map((p) => p.sheetIndex))
  const sorted = Array.from(used).sort((a, b) => a - b)
  const map = new Map(sorted.map((idx, i) => [idx, i]))
  return list.map((p) => ({ ...p, sheetIndex: map.get(p.sheetIndex) ?? p.sheetIndex }))
}

/**
 * 在目标纸上寻找一块能放下 w×h、且不与现有照片重叠（保持标称净间距）的位置。
 * 刀口切块比照片外扩 kerf/2，单张独占一张纸时切块若压到可用区边界就无法贯通，
 * 因此优先选择「四周留有刀口余量」的位置；再按靠边、靠上排序（版面整齐）。
 */
export function findFreeSpot(
  list: Placement[],
  sheetIndex: number,
  w: number,
  h: number,
  ctx: AdjustContext,
): { x: number; y: number } | undefined {
  const b = boundsOfManual(ctx)
  if (w > b.maxX - b.minX + 1e-6 || h > b.maxY - b.minY + 1e-6) return undefined
  const minClear = clearGap(ctx)
  const m = ctx.kerf / 2
  const peers = list.filter((p) => p.sheetIndex === sheetIndex)

  // 照片净矩形重叠判定（实际要求净间距 ≥ kerf + gap，下面用膨胀框检查）
  const blocked = (x: number, y: number): boolean => {
    if (x < b.minX - 1e-6 || y < b.minY - 1e-6 || x + w > b.maxX + 1e-6 || y + h > b.maxY + 1e-6)
      return true
    const slot = { x: x - minClear, y: y - minClear, w: w + 2 * minClear, h: h + 2 * minClear }
    return peers.some((o) => overlaps(slot, o))
  }

  // 候选坐标：安全边、邻居边/标称间隙、1mm 网格
  const xs = new Set<number>()
  const ys = new Set<number>()
  const addRange = (set: Set<number>, lo: number, hi: number) => {
    for (let v = Math.ceil(lo - 1e-6); v <= hi + 1e-6; v += 1) set.add(v)
  }
  addRange(xs, b.minX, b.maxX - w)
  addRange(ys, b.minY, b.maxY - h)
  xs.add(roundPos(b.minX))
  xs.add(roundPos(b.maxX - w))
  ys.add(roundPos(b.minY))
  ys.add(roundPos(b.maxY - h))
  for (const o of peers) {
    for (const v of [o.x, o.x + o.w - w, o.x + o.w + minClear, o.x - minClear - w]) xs.add(roundPos(v))
    for (const v of [o.y, o.y + o.h - h, o.y + o.h + minClear, o.y - minClear - h]) ys.add(roundPos(v))
  }
  const candX = Array.from(xs)
    .filter((x) => x >= b.minX - 1e-6 && x + w <= b.maxX + 1e-6)
    .sort((a, c) => a - c)
  const candY = Array.from(ys)
    .filter((y) => y >= b.minY - 1e-6 && y + h <= b.maxY + 1e-6)
    .sort((a, c) => a - c)

  let best: { x: number; y: number; score: number } | undefined
  for (const x of candX) {
    for (const y of candY) {
      if (blocked(x, y)) continue
      // 刀口切块四周相对可用区边界的余量（任一方向 ≥ kerf/2 才能贯通修边）
      const padL = x - m - b.minX
      const padT = y - m - b.minY
      const padR = b.maxX - (x + w + m)
      const padB = b.maxY - (y + h + m)
      const minPad = Math.min(padL, padT, padR, padB)
      // 1) 四周余量越足越好（贯通性）；2) 越靠左上越整齐
      const score = Math.min(minPad, m + 2) * 1e6 - (x + y)
      if (!best || score > best.score) best = { x, y, score }
    }
  }
  return best ? { x: roundPos(best.x), y: roundPos(best.y) } : undefined
}

/**
 * 把一张照片移到另一张相纸：目标纸有空位则落地并压缩空纸；
 * 目标纸放不下时返回 undefined（调用方给出真实提示，不做静默失败）。
 */
export function moveToSheet(
  list: Placement[],
  seq: number,
  target: number,
  ctx: AdjustContext,
): { list: Placement[]; x: number; y: number } | undefined {
  const self = list.find((p) => p.seq === seq)
  if (!self || self.sheetIndex === target) return undefined
  const spot = findFreeSpot(list, target, self.w, self.h, ctx)
  if (!spot) return undefined
  const moved = list.map((p) =>
    p.seq === seq ? { ...p, sheetIndex: target, x: spot.x, y: spot.y } : p,
  )
  return { list: compactSheetIndices(moved), x: spot.x, y: spot.y }
}
