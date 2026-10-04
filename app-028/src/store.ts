/** 全局状态（Vue 自带 ref / computed / watch，不引入任何状态库） */
import { computed, ref, watch } from 'vue'
import {
  BUILTIN_PAPERS,
  BUILTIN_PHOTO_SIZES,
  BUILTIN_TEMPLATES,
  groupsFromTask,
  newId,
  optionsFromTask,
  resolvePaper,
} from './logic/library'
import { pack, sheetsFromPlacements } from './logic/packer'
import { loadJSON, saveJSON } from './logic/storage'
import type {
  Leftover,
  PackResult,
  Paper,
  PaperTemplate,
  PhotoRef,
  PhotoSize,
  Placement,
  Settings,
  Sheet,
  Task,
} from './logic/types'

const KEY = {
  customPapers: 'ppis.customPapers.v1',
  customSizes: 'ppis.customSizes.v1',
  settings: 'ppis.settings.v1',
  tasks: 'ppis.tasks.v1',
  leftovers: 'ppis.leftovers.v1',
}

export const DEFAULT_SETTINGS: Settings = {
  gapMm: 0,
  kerfMm: 0.5,
  safeEdgeMm: 3,
  allowRotate: true,
  exportDpi: 300,
}

export const customPapers = ref<Paper[]>(loadJSON<Paper[]>(KEY.customPapers, []))
export const customSizes = ref<PhotoSize[]>(loadJSON<PhotoSize[]>(KEY.customSizes, []))
export const settings = ref<Settings>({ ...DEFAULT_SETTINGS, ...loadJSON(KEY.settings, {}) })
export const tasks = ref<Task[]>(loadJSON<Task[]>(KEY.tasks, []))
export const leftovers = ref<Leftover[]>(loadJSON<Leftover[]>(KEY.leftovers, []))

watch(customPapers, (v) => saveJSON(KEY.customPapers, v), { deep: true })
watch(customSizes, (v) => saveJSON(KEY.customSizes, v), { deep: true })
watch(settings, (v) => saveJSON(KEY.settings, v), { deep: true })
watch(tasks, (v) => saveJSON(KEY.tasks, v), { deep: true })
watch(leftovers, (v) => saveJSON(KEY.leftovers, v), { deep: true })

export const allPapers = computed<Paper[]>(() => [...BUILTIN_PAPERS, ...customPapers.value])
export const allSizes = computed<PhotoSize[]>(() => [...BUILTIN_PHOTO_SIZES, ...customSizes.value])
export const templates = computed<PaperTemplate[]>(() => BUILTIN_TEMPLATES)

/** 照片文件只在本机内存里保留，绝不写入存储、绝不上传 */
const photoCache = new Map<string, { url: string; ref: PhotoRef }>()
/** 内存照片变化计数（Map 本身不是响应式的，用它触发重绘） */
export const photoVersion = ref(0)

export function photoKey(itemId: string, copyIndex: number): string {
  return `${itemId}#${copyIndex}`
}

export function setItemPhoto(key: string, url: string, ref: PhotoRef): void {
  const old = photoCache.get(key)
  if (old) URL.revokeObjectURL(old.url)
  photoCache.set(key, { url, ref })
  photoVersion.value++
}

export function getItemPhoto(key: string): { url: string; ref: PhotoRef } | undefined {
  return photoCache.get(key)
}

export function clearItemPhoto(key: string): void {
  const old = photoCache.get(key)
  if (old) URL.revokeObjectURL(old.url)
  photoCache.delete(key)
  photoVersion.value++
}

/** 每张照片（placement）对应第几张底片。
 *  按 seq 顺序计数：手工拖动/跨纸移动只改位置不改编号，底片映射保持稳定 */
export function copyIndexMap(sheets: Sheet[]): Map<number, number> {
  const counter = new Map<string, number>()
  const out = new Map<number, number>()
  const ordered = sheets
    .flatMap((s) => s.placements)
    .slice()
    .sort((a, b) => a.seq - b.seq)
  for (const p of ordered) {
    const n = counter.get(p.itemId) ?? 0
    out.set(p.seq, n)
    counter.set(p.itemId, n + 1)
  }
  return out
}

/** placement -> 本机照片（key + objectURL），未导入照片时返回 undefined */
export function makePhotoResolver(task: Task, sheets: Sheet[]) {
  const map = copyIndexMap(sheets)
  const repeat = new Map(task.items.map((i) => [i.id, i.repeatSamePhoto]))
  return (p: Placement): { key: string; url: string } | undefined => {
    const ci = repeat.get(p.itemId) === false ? map.get(p.seq) ?? 0 : 0
    const k = photoKey(p.itemId, ci)
    const ph = getItemPhoto(k)
    return ph ? { key: k, url: ph.url } : undefined
  }
}

/** 生成「placement -> 本机缩略图 URL」的解析函数 */
export function makeThumbResolver(task: Task, sheets: Sheet[]) {
  const resolve = makePhotoResolver(task, sheets)
  return (p: Placement): string | undefined => resolve(p)?.url
}

export function getTask(id: string): Task | undefined {
  return tasks.value.find((t) => t.id === id)
}

export function createTask(partial: Partial<Task> = {}): Task {
  const task: Task = {
    id: newId('task'),
    name: partial.name ?? `拼版任务 ${tasks.value.length + 1}`,
    paperId: partial.paperId ?? 'p5x7',
    customPaper: partial.customPaper,
    items: partial.items ?? [],
    gapMm: partial.gapMm ?? settings.value.gapMm,
    kerfMm: partial.kerfMm ?? settings.value.kerfMm,
    safeEdgeMm: partial.safeEdgeMm ?? settings.value.safeEdgeMm,
    allowRotate: partial.allowRotate ?? settings.value.allowRotate,
    headerText: partial.headerText ?? '',
    footerText: partial.footerText ?? '',
    createdAt: Date.now(),
  }
  tasks.value.unshift(task)
  return task
}

export function deleteTask(id: string): void {
  tasks.value = tasks.value.filter((t) => t.id !== id)
}

export function touch(): void {
  tasks.value = tasks.value.slice()
}

/** 执行排样；返回错误提示（无错误时返回 undefined） */
export function runPack(task: Task): string | undefined {
  const paper = resolvePaper(task, allPapers.value)
  const groups = groupsFromTask(task, allSizes.value)
  if (!groups.length) {
    task.result = undefined
    return '照片清单为空，请先添加照片尺寸与数量'
  }
  const out = pack(groups, optionsFromTask(task, paper))
  if (out.error) {
    task.result = undefined
    return out.error
  }
  task.result = out.result
  task.manual = undefined
  touch()
  return undefined
}

/** 当前生效的相纸版面：手工微调（含同轮重建的切割步骤/利用率）优先于自动排样 */
export function sheetsOf(task: Task): Sheet[] {
  if (task.manual) return task.manual.sheets
  return task.result?.sheets ?? []
}

export function manualPlacementsOf(task: Task): Placement[] {
  if (task.manual) return task.manual.placements
  return (task.result?.sheets ?? []).flatMap((s) => s.placements)
}

/**
 * 由 placements 构造一个 PackResult（stats 与实际版面一致），
 * 供成本核算等「派生结论」在手工微调后同轮刷新。
 */
export function effectiveResult(task: Task): PackResult | undefined {
  if (!task.result && !task.manual) return undefined
  const sheets = sheetsOf(task)
  const totalUsed = sheets.reduce((acc, s) => acc + s.usedAreaMm2, 0)
  const paper = resolvePaper(task, allPapers.value)
  const totalArea = sheets.length * paper.wMm * paper.hMm
  return {
    sheets,
    stats: {
      totalPhotos: sheets.reduce((acc, s) => acc + s.placements.length, 0),
      sheets: sheets.length,
      avgUtilization: totalArea > 0 ? totalUsed / totalArea : 0,
      elapsedMs: task.result?.stats.elapsedMs ?? 0,
      keepTogetherBroken: task.result?.stats.keepTogetherBroken ?? [],
    },
  }
}

/** 结构校验：照片数量、尺寸/旋转许可、纸张编号、seq 唯一性 */
function validatePlacementStructure(
  task: Task,
  sizes: PhotoSize[],
  placements: Placement[],
): string[] {
  const errors: string[] = []
  const sizeById = new Map(task.items.map((i) => [i.id, i]))
  const photoSizeById = new Map(sizes.map((s) => [s.id, s]))

  // 每张照片仍在安全边内、尺寸必须与清单一致、旋转必须被许可
  for (const p of placements) {
    const item = sizeById.get(p.itemId)
    if (!item) {
      errors.push(`第 ${p.seq} 号照片对应的清单项已不存在`)
      continue
    }
    const size = photoSizeById.get(item.sizeId)
    if (size) {
      const dimsOk =
        (Math.abs(p.w - size.wMm) < 1e-6 && Math.abs(p.h - size.hMm) < 1e-6) ||
        (Math.abs(p.w - size.hMm) < 1e-6 && Math.abs(p.h - size.wMm) < 1e-6)
      if (!dimsOk) {
        errors.push(`第 ${p.seq} 号照片尺寸 ${p.w}×${p.h}mm 与清单不符`)
      }
      if (p.rotated && (!task.allowRotate || !item.rotateAllowed)) {
        errors.push(`「${size.name}」有方向要求，不允许旋转成横向`)
      }
    }
  }

  // 每个清单项的照片数量不能变（跨纸/拖动不得弄丢或复制照片）
  const counts = new Map<string, number>()
  for (const p of placements) counts.set(p.itemId, (counts.get(p.itemId) ?? 0) + 1)
  for (const item of task.items) {
    if (item.qty <= 0) continue
    const n = counts.get(item.id) ?? 0
    if (n !== item.qty) {
      errors.push(`照片数量发生变化：应为 ${item.qty} 张，实际 ${n} 张`)
    }
  }
  if (counts.size !== task.items.filter((i) => i.qty > 0).length) {
    errors.push('存在清单之外的照片')
  }

  // seq 唯一且纸张编号连续
  const seqs = new Set<number>()
  for (const p of placements) {
    if (seqs.has(p.seq)) errors.push(`编号 #${p.seq} 重复`)
    seqs.add(p.seq)
    if (p.sheetIndex < 0) errors.push(`第 ${p.seq} 号照片所在纸张编号无效`)
  }

  return errors
}

/**
 * 写入手工微调结果并立刻做真实验证（增量校验，不重新排样）：
 * 结构（数量/尺寸/旋转许可/越界/重叠）+ guillotine 贯通裁切在同一轮完成，
 * 切割步骤、刀数、利用率、余料、校验结论全部由同一份 placements 重建。
 */
export function setManual(task: Task, placements: Placement[]): void {
  const paper = resolvePaper(task, allPapers.value)
  const opts = optionsFromTask(task, paper)
  const started = typeof performance !== 'undefined' ? performance.now() : 0
  const structureErrors = validatePlacementStructure(task, allSizes.value, placements)
  const sheetCount = placements.reduce((mx, p) => Math.max(mx, p.sheetIndex + 1), 1)
  const { sheets, errors } = sheetsFromPlacements(placements, opts, sheetCount)
  const allErrors = [...structureErrors, ...errors]
  const stepCount = sheets.reduce((acc, s) => acc + s.cutSteps.length, 0)
  const message = allErrors.length
    ? allErrors.slice(0, 3).join('；') + (allErrors.length > 3 ? ` 等 ${allErrors.length} 处问题` : '')
    : `校验通过：${sheets.length} 张相纸，共 ${stepCount} 刀，刀口全部贯通、照片互不压住`
  task.manual = {
    placements,
    sheets,
    valid: allErrors.length === 0,
    message,
    validationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - started),
    stepCount,
  }
  touch()
}

/** 恢复自动排样：连手工摆位与派生结论（版面/刀数/校验结果）一起清掉，之后仍可再次手工调整 */
export function resetManual(task: Task): void {
  task.manual = undefined
  touch()
}

export function addCustomPaper(p: Omit<Paper, 'id'>): Paper {
  const paper: Paper = { ...p, id: newId('paper') }
  customPapers.value = [...customPapers.value, paper]
  return paper
}

export function addCustomSize(s: Omit<PhotoSize, 'id'>): PhotoSize {
  const size: PhotoSize = { ...s, id: newId('size') }
  customSizes.value = [...customSizes.value, size]
  return size
}

export function removeCustomPaper(id: string): void {
  customPapers.value = customPapers.value.filter((p) => p.id !== id)
}

export function removeCustomSize(id: string): void {
  customSizes.value = customSizes.value.filter((s) => s.id !== id)
}

export function addLeftover(l: Omit<Leftover, 'id' | 'createdAt' | 'usedCount'>): Leftover {
  const item: Leftover = {
    ...l,
    id: newId('leftover'),
    createdAt: Date.now(),
    usedCount: 0,
  }
  leftovers.value = [item, ...leftovers.value]
  return item
}

export function removeLeftover(id: string): void {
  leftovers.value = leftovers.value.filter((l) => l.id !== id)
}

export function markLeftoverUsed(id: string): void {
  leftovers.value = leftovers.value.map((l) =>
    l.id === id ? { ...l, usedCount: l.usedCount + 1 } : l,
  )
}
