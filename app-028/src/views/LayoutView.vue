<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SheetView from '../components/SheetView.vue'
import UtilizationBar from '../components/UtilizationBar.vue'
import {
  addLeftover,
  allPapers,
  allSizes,
  effectiveResult,
  getTask,
  makeThumbResolver,
  manualPlacementsOf,
  resetManual,
  setManual,
  sheetsOf,
  photoVersion,
} from '../store'
import { comparePapers, computeCost } from '../logic/cost'
import { findPhotoSize, groupsFromTask, resolvePaper, sizeLabel } from '../logic/library'
import {
  boundsOf,
  clearGap,
  clampToBounds,
  findFreeSpot,
  isSquare,
  moveToSheet as movePlacementToSheet,
  nudgePosition,
  rotatedPlacement,
  rotationAllowed,
  snapPosition,
  type AdjustContext,
} from '../logic/manual'
import { formatCents, formatPercent } from '../logic/units'
import type { PaperCompare } from '../logic/cost'
import type { Placement, Task } from '../logic/types'

const route = useRoute()
const router = useRouter()

const task = computed<Task | undefined>(() => getTask(String(route.params.id)))
const activeSheet = ref(0)
const selectedSeq = ref(-1)
const dragState = ref<{ seq: number; x: number; y: number } | null>(null)
const localMsg = ref('')

const paper = computed(() => (task.value ? resolvePaper(task.value, allPapers.value) : allPapers.value[0]))
const sheets = computed(() => (task.value ? sheetsOf(task.value) : []))
const sheet = computed(() => sheets.value[Math.min(activeSheet.value, Math.max(0, sheets.value.length - 1))])
const result = computed(() => (task.value ? effectiveResult(task.value) : undefined))
const cost = computed(() => (result.value ? computeCost(paper.value, result.value) : undefined))
const totalPhotos = computed(() =>
  sheets.value.reduce((acc, s) => acc + s.placements.length, 0),
)
const totalSteps = computed(() => sheets.value.reduce((acc, s) => acc + s.cutSteps.length, 0))
const rawSteps = computed(() => sheets.value.reduce((acc, s) => acc + s.rawCutCount, 0))

const thumbs = computed(() => {
  void photoVersion.value
  return task.value ? makeThumbResolver(task.value, sheets.value) : () => undefined
})

/** 拖动中用本地覆盖，避免每帧全量校验；拖动过程中同样钳制在安全边内，不会跑出纸外 */
const displaySheets = computed(() => {
  const list = sheets.value
  const d = dragState.value
  if (!d) return list
  return list.map((s) => ({
    ...s,
    placements: s.placements.map((p) =>
      p.seq === d.seq
        ? clampToBounds({ ...p, x: d.x, y: d.y }, boundsOf(task.value!, paper.value))
        : p,
    ),
  }))
})
const displaySheet = computed(() =>
  displaySheets.value[Math.min(activeSheet.value, Math.max(0, displaySheets.value.length - 1))],
)

const scale = computed(() => {
  const p = paper.value
  const maxW = 900
  const maxH = 640
  return Math.max(0.6, Math.min(3, Math.min(maxW / p.wMm, maxH / p.hMm)))
})

const comparisons = ref<PaperCompare[]>([])
const compareError = ref('')

function runCompare() {
  const t = task.value
  if (!t) return
  compareError.value = ''
  const groups = groupsFromTask(t, allSizes.value)
  if (!groups.length) {
    compareError.value = '清单为空'
    return
  }
  comparisons.value = comparePapers(
    groups,
    {
      safeEdgeMm: t.safeEdgeMm,
      gapMm: t.gapMm,
      kerfMm: t.kerfMm,
      allowRotate: t.allowRotate,
    },
    allPapers.value.filter((x) => x.id !== 'proll152'),
    t.paperId,
  )
}

function adjustCtx(): AdjustContext | undefined {
  const t = task.value
  if (!t) return undefined
  return {
    paper: paper.value,
    sizes: allSizes.value,
    kerf: t.kerfMm,
    gap: t.gapMm,
    safeEdge: t.safeEdgeMm,
  }
}

/** 屏幕上约 6px 的物理吸附半径（限制在 1~6mm），松手后吸附安全边与相邻照片 */
function snapThresholdMm(): number {
  return Math.min(6, Math.max(1, 6 / scale.value))
}

function onMove(payload: { seq: number; x: number; y: number }) {
  // 拖动过程先钳制，照片任何时候都不会被拖到安全边外
  dragState.value = payload
}

function onMoveEnd(payload: { seq: number; x: number; y: number }) {
  dragState.value = null
  const t = task.value
  const ctx = adjustCtx()
  if (!t || !ctx) return
  const list = manualPlacementsOf(t)
  if (!list.some((p) => p.seq === payload.seq)) return
  // 松手：吸附安全边 / 邻居齐平边 / 标称间隙，并钳制在纸内
  const snapped = snapPosition(list, payload.seq, payload.x, payload.y, ctx, snapThresholdMm())
  const next = list.map((p) =>
    p.seq === payload.seq ? { ...p, x: snapped.x, y: snapped.y } : p,
  )
  setManual(t, next)
  localMsg.value = ''
}

function applyEdit(list: Placement[]) {
  const t = task.value
  if (!t) return
  // 写入即同轮重建：版面、切割步骤、刀数、利用率与校验结论一起刷新
  setManual(t, list)
  localMsg.value = ''
}

function rotateSelected() {
  const t = task.value
  if (!t) return
  if (selectedSeq.value < 0) {
    localMsg.value = '请先在纸面上点选一张照片'
    return
  }
  const list = manualPlacementsOf(t)
  const p = list.find((x) => x.seq === selectedSeq.value)
  if (!p) return
  if (!rotationAllowed(t, p)) {
    localMsg.value = '该照片有方向要求（证件照），不允许旋转 90°'
    return
  }
  if (isSquare(p)) {
    localMsg.value = '正方形照片旋转后版面不变'
    return
  }
  const next0 = rotatedPlacement(p)
  const b = boundsOf(t, paper.value)
  if (next0.w > b.maxX - b.minX || next0.h > b.maxY - b.minY) {
    localMsg.value = `旋转后的 ${next0.w.toFixed(0)}×${next0.h.toFixed(0)}mm 超出可用区，不能旋转`
    return
  }
  // 以中心为轴旋转并钳制回安全边内
  const cx = p.x + p.w / 2
  const cy = p.y + p.h / 2
  const held = { ...next0, x: cx - next0.w / 2, y: cy - next0.h / 2 }
  const next = clampToBounds(held, b, 3)
  applyEdit(list.map((x) => (x.seq === p.seq ? next : x)))
}

function moveToSheet(targetSheet: number) {
  const t = task.value
  const ctx = adjustCtx()
  if (!t || !ctx) return
  if (selectedSeq.value < 0) {
    localMsg.value = '请先在纸面上点选一张照片'
    return
  }
  const list = manualPlacementsOf(t)
  const p = list.find((x) => x.seq === selectedSeq.value)
  if (!p || p.sheetIndex === targetSheet) return
  // 目标纸上先找一块不压住别人的空位；找不到时给真实结论，而不是一句空话
  const spot = findFreeSpot(list, targetSheet, p.w, p.h, ctx)
  if (!spot) {
    localMsg.value = `第 ${targetSheet + 1} 张纸上没有能放下这张照片、又不与其它照片相压的空位`
    return
  }
  const moved = movePlacementToSheet(list, p.seq, targetSheet, ctx)
  if (!moved) return
  applyEdit(moved.list)
  // 跨纸移动真正生效：切换到目标纸并保持选中
  const landed = moved.list.find((x) => x.seq === p.seq)
  activeSheet.value = landed?.sheetIndex ?? targetSheet
  localMsg.value = `已移到第 ${activeSheet.value + 1} 张相纸，与相邻照片保持 ${clearGap(ctx).toFixed(1)}mm 净间距`
}

function nudge(dx: number, dy: number) {
  const t = task.value
  const ctx = adjustCtx()
  if (!t || !ctx) return
  if (selectedSeq.value < 0) {
    localMsg.value = '请先在纸面上点选一张照片'
    return
  }
  const list = manualPlacementsOf(t)
  if (!list.some((x) => x.seq === selectedSeq.value)) return
  // 精确步进（不做吸附），始终钳制在安全边内；若压住邻居则由校验给出真实结论
  const { x, y } = nudgePosition(list, selectedSeq.value, dx, dy, ctx)
  applyEdit(list.map((p) => (p.seq === selectedSeq.value ? { ...p, x, y } : p)))
}

function doReset() {
  const t = task.value
  if (!t) return
  // 恢复自动排样：手工摆位与派生结论（切割步骤/刀数/校验）一并清除
  resetManual(t)
  localMsg.value = '已恢复自动排样结果，可重新拖动或旋转进行手工调整'
  selectedSeq.value = -1
  dragState.value = null
  activeSheet.value = 0
}

function registerWaste(w: number, h: number) {
  const t = task.value
  if (!t) return
  addLeftover({
    name: `${t.name} 余料`,
    wMm: Math.round(w * 10) / 10,
    hMm: Math.round(h * 10) / 10,
    marginMm: 0,
    priceCents: 0,
  })
  localMsg.value = `已登记余料 ${w.toFixed(1)}×${h.toFixed(1)}mm`
}

function registerAllWaste() {
  const s = sheet.value
  if (!s) return
  for (const r of s.wasteRects) registerWaste(r.w, r.h)
}

function selectedInfo() {
  const t = task.value
  if (!t || selectedSeq.value < 0) return undefined
  const p = manualPlacementsOf(t).find((x) => x.seq === selectedSeq.value)
  if (!p) return undefined
  const item = t.items.find((i) => i.id === p.itemId)
  return {
    p,
    item,
    size: item ? findPhotoSize(allSizes.value, item.sizeId) : undefined,
    canRotate: rotationAllowed(t, p) && !isSquare(p),
  }
}

const info = computed(selectedInfo)

const manual = computed(() => task.value?.manual)
const lowUtil = computed(() => (sheet.value ? sheet.value.utilization < 0.7 : false))

function goto(routeName: string) {
  const t = task.value
  if (t) router.push(`/${routeName}/${t.id}`)
}

// 利用率低于 70% 时自动试算其它相纸规格做对比
watch(
  () => task.value?.result,
  () => {
    const t = task.value
    if (!t?.result) return
    if (t.result.stats.avgUtilization >= 0.7) {
      comparisons.value = []
      return
    }
    runCompare()
  },
  { immediate: true },
)

// 跨纸移动压掉空纸后，保证当前查看的纸张编号始终有效
watch(
  () => sheets.value.length,
  (n) => {
    if (activeSheet.value > n - 1) activeSheet.value = Math.max(0, n - 1)
  },
)
</script>

<template>
  <div v-if="!task" class="card">
    <h2>任务不存在</h2>
    <p>可能已被删除，请回到<a href="/">新建任务</a>页重新创建。</p>
  </div>
  <div v-else class="stack">
    <div class="row">
      <h1 style="margin: 0">{{ task.name }}</h1>
      <span class="badge brand">{{ paper.name }} {{ paper.wMm }}×{{ paper.hMm }}mm</span>
      <span class="badge">{{ totalPhotos }} 张照片</span>
      <span class="badge">{{ sheets.length }} 张相纸</span>
      <span class="badge">{{ totalSteps }} 刀（未合并 {{ rawSteps }} 刀）</span>
      <div class="spacer"></div>
      <button class="btn" @click="goto('cut')">裁切步骤 →</button>
      <button class="btn primary" @click="goto('export')">导出 1:1 →</button>
    </div>

    <div v-if="localMsg" class="note" :class="manual && !manual.valid ? 'warn' : 'ok'">{{ localMsg }}</div>
    <div
      v-if="manual"
      class="note"
      :class="manual.valid ? 'ok' : 'danger'"
    >
      手工微调：{{ manual.message }}
      （增量校验 {{ manual.validationMs }}ms，共 {{ manual.stepCount }} 刀）
      <button class="btn small" style="margin-left: 8px" @click="doReset">恢复自动排样</button>
    </div>

    <div class="grid sidebar">
      <div class="stack">
        <div class="card">
          <h3>纸面视图</h3>
          <div class="card-sub">
            毫米网格（细线 10mm / 粗线 50mm）；虚线框为「纸边留白 + 安全边」后的可用区
          </div>
          <div class="row" style="margin-bottom: 8px">
            <button
              v-for="(s, i) in sheets"
              :key="s.index"
              class="btn small"
              :class="{ primary: i === activeSheet }"
              @click="activeSheet = i"
            >
              第 {{ i + 1 }} 张
            </button>
          </div>
          <div v-if="displaySheet" class="sheet-wrap">
            <SheetView
              :sheet="displaySheet"
              :paper="paper"
              :safe-edge-mm="task.safeEdgeMm"
              :scale="scale"
              draggable
              :show-cut-labels="true"
              :thumb-of="thumbs"
              @move="onMove"
              @moveend="onMoveEnd"
              @select="(seq) => (selectedSeq = seq)"
            />
          </div>
          <div class="legend" style="margin-top: 8px">
            <span><i style="background: #9aa6b4"></i>切割线</span>
            <span><i style="background: #6d7c8f"></i>照片边界</span>
            <span><i style="background: #c3ccd9"></i>安全边</span>
            <span>↻ = 已旋转 90°</span>
          </div>
        </div>

        <div class="card">
          <h3>第 {{ activeSheet + 1 }} 张：照片清单（对号入座）</h3>
          <table class="data">
            <thead>
              <tr>
                <th class="num">编号</th>
                <th>尺寸</th>
                <th class="num">位置 x/y mm</th>
                <th class="num">宽×高 mm</th>
                <th>旋转</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in displaySheet?.placements ?? []" :key="p.seq">
                <td class="num">#{{ p.seq }}</td>
                <td>
                  {{
                    sizeLabel(
                      findPhotoSize(
                        allSizes,
                        task.items.find((i) => i.id === p.itemId)?.sizeId ?? '',
                      ),
                    )
                  }}
                </td>
                <td class="num">{{ p.x.toFixed(1) }} / {{ p.y.toFixed(1) }}</td>
                <td class="num">{{ p.w.toFixed(1) }}×{{ p.h.toFixed(1) }}</td>
                <td>{{ p.rotated ? '90°' : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <h3>利用率与张数</h3>
          <UtilizationBar
            :value="sheet ? sheet.utilization : 0"
            label="本张利用率"
            :detail="sheet ? `照片面积 ${sheet.usedAreaMm2.toFixed(0)}mm² / 纸张面积 ${sheet.sheetAreaMm2.toFixed(0)}mm²` : ''"
          />
          <div style="height: 10px"></div>
          <UtilizationBar
            :value="result ? result.stats.avgUtilization : 0"
            label="整单平均利用率"
            :detail="`${sheets.length} 张相纸，共 ${totalPhotos} 张照片`"
          />
          <div class="kv" style="margin-top: 12px">
            <dt>排样耗时</dt>
            <dd>{{ result ? result.stats.elapsedMs + ' ms' : '—' }}</dd>
            <dt>切割步数（已合并）</dt>
            <dd>{{ totalSteps }}</dd>
            <dt>切割步数（未合并）</dt>
            <dd>{{ rawSteps }}</dd>
          </div>
        </div>

        <div v-if="lowUtil" class="card">
          <h3>换纸试算</h3>
          <div class="note warn">
            当前利用率低于 70%，建议换更大/更小的纸张试试（点下方按钮试算 2~3 种规格）
          </div>
          <div class="row" style="margin-top: 8px">
            <button class="btn small" @click="runCompare">试算其它相纸</button>
            <span v-if="compareError" class="badge danger">{{ compareError }}</span>
          </div>
          <table v-if="comparisons.length" class="data" style="margin-top: 8px">
            <thead>
              <tr>
                <th>相纸</th>
                <th class="num">张数</th>
                <th class="num">利用率</th>
                <th class="num">总价</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in comparisons" :key="c.paper.id">
                <td>{{ c.paper.name }}</td>
                <td class="num">{{ c.sheets }}</td>
                <td class="num">{{ formatPercent(c.avgUtilization) }}</td>
                <td class="num">{{ formatCents(c.totalCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h3>成本核算</h3>
          <div v-if="cost" class="kv">
            <dt>相纸单价</dt>
            <dd>{{ formatCents(paper.priceCents) }}/张</dd>
            <dt>用纸张数</dt>
            <dd>{{ cost.sheets }}</dd>
            <dt>总材料成本</dt>
            <dd>{{ formatCents(cost.totalCents) }}</dd>
            <dt>每张照片摊薄</dt>
            <dd>{{ formatCents(cost.perPhotoCents) }}</dd>
            <dt>本方案浪费率</dt>
            <dd>{{ formatPercent(cost.wasteRate) }}</dd>
            <dt>逐张打印浪费率</dt>
            <dd>{{ formatPercent(cost.naiveWasteRate) }}</dd>
            <dt>节省</dt>
            <dd>{{ formatCents(cost.savedCents) }}</dd>
          </div>
        </div>

        <div class="card">
          <h3>手工微调</h3>
          <div class="card-sub">
            拖动照片自动吸附到相邻照片与安全边；松开后立刻重新校验 guillotine 合法性（增量校验，不重新排样）
          </div>
          <div v-if="!info" class="note">点选纸面上的一张照片后即可微调</div>
          <div v-else class="stack">
            <div class="kv">
              <dt>选中</dt>
              <dd>#{{ info.p.seq }} {{ info.size?.name }}</dd>
              <dt>位置</dt>
              <dd>{{ info.p.x.toFixed(1) }} / {{ info.p.y.toFixed(1) }} mm</dd>
              <dt>尺寸</dt>
              <dd>{{ info.p.w.toFixed(1) }}×{{ info.p.h.toFixed(1) }} mm</dd>
              <dt>方向</dt>
              <dd>{{ info.canRotate ? '允许旋转' : '有方向要求，不可旋转' }}</dd>
            </div>
            <div class="row">
              <button class="btn small" :disabled="!info.canRotate" @click="rotateSelected">
                旋转 90°
              </button>
              <button class="btn small" @click="nudge(-1, 0)">← 1mm</button>
              <button class="btn small" @click="nudge(1, 0)">→ 1mm</button>
              <button class="btn small" @click="nudge(0, -1)">↑ 1mm</button>
              <button class="btn small" @click="nudge(0, 1)">↓ 1mm</button>
              <button class="btn small" @click="nudge(-0.5, -0.5)">-0.5</button>
              <button class="btn small" @click="nudge(0.5, 0.5)">+0.5</button>
            </div>
            <label class="field">
              移到第几张相纸
              <select
                :value="info.p.sheetIndex"
                @change="moveToSheet(Number(($event.target as HTMLSelectElement).value))"
              >
                <option v-for="(_, i) in sheets" :key="i" :value="i">第 {{ i + 1 }} 张</option>
                <option :value="sheets.length">＋ 另起一张新相纸</option>
              </select>
            </label>
          </div>
        </div>

        <div class="card">
          <h3>
            余料登记
            <button class="btn small" :disabled="!sheet?.wasteRects.length" @click="registerAllWaste">
              全部登记
            </button>
          </h3>
          <div class="card-sub">把剩下的纸边记录下来，下次排样优先使用</div>
          <div v-if="!sheet?.wasteRects.length" class="note">本张相纸没有可登记的余料</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th class="num">位置 mm</th>
                <th class="num">尺寸 mm</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in sheet.wasteRects" :key="i">
                <td class="num">{{ r.x.toFixed(1) }} / {{ r.y.toFixed(1) }}</td>
                <td class="num">{{ r.w.toFixed(1) }} × {{ r.h.toFixed(1) }}</td>
                <td>
                  <button class="btn small" @click="registerWaste(r.w, r.h)">登记</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
