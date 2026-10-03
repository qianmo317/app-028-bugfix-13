/**
 * 手工微调的几何规则（纯函数，纸面视图与自检共用）：
 *  - 吸附：拖动松手时吸附到安全边与相邻照片（边对齐，或保持「隙距 + 刀宽」的一致间隙）
 *  - 夹取：任何移动 / 旋转都不得跑出「纸边留白 + 四周安全边」的可用区
 *  - 旋转：设有方向要求的照片（如证件照）不允许旋转
 */
import { EPS } from './guillotine'
import type { Placement } from './types'

export interface ManualGeom {
  /** 可用区左上角 = 纸边留白 + 四周安全边 */
  inset: number
  /** 可用区宽高 */
  usableW: number
  usableH: number
  /** 相邻照片边到边的标准间距（隙距 + 刀宽补偿，与自动排样一致） */
  spacing: number
}

/** 拖动吸附容差（mm）：落点距吸附目标在此范围内即吸附 */
export const SNAP_TOLERANCE_MM = 2

export function manualGeom(
  paper: { wMm: number; hMm: number; marginMm: number },
  safeEdgeMm: number,
  gapMm: number,
  kerfMm: number,
): ManualGeom {
  const inset = paper.marginMm + safeEdgeMm
  return {
    inset,
    usableW: Math.max(0, paper.wMm - 2 * inset),
    usableH: Math.max(0, paper.hMm - 2 * inset),
    spacing: gapMm + kerfMm,
  }
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi))

/** 0.05mm 网格（兼容刀宽补偿产生的 0.25mm 粒度），避免自由落点出现零碎坐标 */
const grid = (v: number): number => Math.round(v * 20) / 20

/** 把照片夹取到可用区内（照片比可用区还大时贴左上角，由校验如实报出） */
export function clampPlacement(p: Placement, g: ManualGeom): Placement {
  return {
    ...p,
    x: clamp(p.x, g.inset, g.inset + g.usableW - p.w),
    y: clamp(p.y, g.inset, g.inset + g.usableH - p.h),
  }
}

/** 距目标最近的候选坐标；超出容差不吸附。距离并列时取较小坐标，保证结果与候选顺序无关 */
function snap1d(
  target: number,
  candidates: number[],
  tolerance: number,
): { v: number; hit: boolean } {
  let best = target
  let bestDist = Infinity
  for (const c of candidates) {
    const d = Math.abs(c - target)
    if (d < bestDist - EPS || (Math.abs(d - bestDist) <= EPS && c < best)) {
      best = c
      bestDist = d
    }
  }
  return bestDist <= tolerance + EPS ? { v: best, hit: true } : { v: target, hit: false }
}

/**
 * 拖动落点吸附：
 *  - 四条安全边
 *  - 与同一纸张上相邻照片的边对齐，或保持「隙距 + 刀宽」的标准间距
 * 吸附命中时取候选的精确值；未命中时落到 0.05mm 网格上；最后夹取进可用区。
 * 同一落点每次吸附结果一致。
 */
export function snapPlacement(
  p: Placement,
  x: number,
  y: number,
  others: Placement[],
  g: ManualGeom,
  tolerance = SNAP_TOLERANCE_MM,
): { x: number; y: number } {
  const loX = g.inset
  const hiX = g.inset + g.usableW - p.w
  const loY = g.inset
  const hiY = g.inset + g.usableH - p.h
  const xs = [loX, hiX]
  const ys = [loY, hiY]
  for (const q of others) {
    xs.push(q.x, q.x + q.w - p.w, q.x - g.spacing - p.w, q.x + q.w + g.spacing)
    ys.push(q.y, q.y + q.h - p.h, q.y - g.spacing - p.h, q.y + q.h + g.spacing)
  }
  const rx = snap1d(x, xs, tolerance)
  const ry = snap1d(y, ys, tolerance)
  const fx = rx.hit ? rx.v : grid(x)
  const fy = ry.hit ? ry.v : grid(y)
  return { x: clamp(fx, loX, hiX), y: clamp(fy, loY, hiY) }
}

/** 旋转前置检查：不允许旋转时返回原因提示，允许时返回 undefined */
export function rotateBlockReason(
  p: Placement,
  itemRotateAllowed: boolean,
  taskAllowRotate: boolean,
  g: ManualGeom,
): string | undefined {
  if (!taskAllowRotate) return '当前任务未开启「允许整体旋转」，不能旋转'
  if (!itemRotateAllowed) return `#${p.seq} 设有方向要求（如证件照），不允许旋转`
  if (p.h > g.usableW + EPS || p.w > g.usableH + EPS) {
    return `#${p.seq} 旋转后超出相纸可用区，未旋转`
  }
  return undefined
}
