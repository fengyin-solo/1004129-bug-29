import { allRows, saveAll } from './local-store'
import type { ActionResult, CabinReviewConclusion, EntryRow } from './types'

// 客舱清洁状态机：待清洁 → 清洁中 → 已完成 → 需复查。
// 单向顺序固定，只允许「走到下一个」，禁止越级，也禁止倒退。
export const CABIN_CLEAN_KEY = 'cabin_clean'
export const CABIN_STATUS_FLOW = ['待清洁', '清洁中', '已完成', '需复查'] as const

// 列表/详情上的动作只对应顺序中的下一个状态；复查结论单独走 confirmCabinReview，不改状态。
const NEXT_STATUS_BY_ACTION: Record<string, (typeof CABIN_STATUS_FLOW)[number]> = {
  开始清洁: '清洁中',
  完成清洁: '已完成',
  安排复查: '需复查',
}

const CREW_FIELD = '清洁班组'
const FLIGHT_FIELD = '关联航班'
export const CABIN_CREW_FALLBACK = '待补录'

const FLIGHT_OPS_KEY = 'flight_ops'
const TURNAROUND_KEY = 'turnaround'
const FLIGHT_OPS_FLIGHT_FIELD = '航班号'
const FLIGHT_OPS_NODE_FIELD = '保障节点'
const TURNAROUND_FLIGHT_FIELD = '关联航班'
const TURNAROUND_PROGRESS_FIELD = '保障进度'

const REVIEW_FIELD = '复查结论'
const REVIEW_TIME_FIELD = '复查时间'

// 并发提交保护：同一任务的动作在落盘期间占住一个槽位，重复提交直接拦下。
const inflight = new Set<number>()

export function cabinCrew(row: EntryRow): string {
  const crew = String(row[CREW_FIELD] ?? '').trim()
  // 缺班组归属时不阻断业务，统一兼容显示为「待补录」。
  return crew === '' ? CABIN_CREW_FALLBACK : crew
}

export function isArchived(row: EntryRow): boolean {
  return row.archived === true
}

export function listCabinTasks(): EntryRow[] {
  return allRows()[CABIN_CLEAN_KEY] ?? []
}

export function getCabinTask(id: number): EntryRow | undefined {
  return listCabinTasks().find((row) => Number(row.id) === id)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// 把清洁结论同步到同一航班的航班保障 / 过站台账；两个模块在同一次 saveAll 里落盘，
// 一次动作只写一次，杜绝旧实现把过站保障进度连着改两遍的问题。
function syncFlightLedgers(
  patch: Record<string, EntryRow[]>,
  flightNo: string,
  note: string,
): NonNullable<ActionResult['synced']> {
  const synced: NonNullable<ActionResult['synced']> = []
  if (flightNo.trim() === '') {
    return synced
  }

  const opsRows = (allRows()[FLIGHT_OPS_KEY] ?? []).map((row) => ({ ...row }))
  const opsIds: number[] = []
  for (const row of opsRows) {
    if (String(row[FLIGHT_OPS_FLIGHT_FIELD] ?? '').trim() === flightNo && row[FLIGHT_OPS_NODE_FIELD] !== note) {
      row[FLIGHT_OPS_NODE_FIELD] = note
      opsIds.push(Number(row.id))
    }
  }
  if (opsIds.length > 0) {
    patch[FLIGHT_OPS_KEY] = opsRows
    synced.push({ module: FLIGHT_OPS_KEY, ids: opsIds })
  }

  const turnRows = (allRows()[TURNAROUND_KEY] ?? []).map((row) => ({ ...row }))
  const turnIds: number[] = []
  for (const row of turnRows) {
    if (String(row[TURNAROUND_FLIGHT_FIELD] ?? '').trim() === flightNo && row[TURNAROUND_PROGRESS_FIELD] !== note) {
      row[TURNAROUND_PROGRESS_FIELD] = note
      turnIds.push(Number(row.id))
    }
  }
  if (turnIds.length > 0) {
    patch[TURNAROUND_KEY] = turnRows
    synced.push({ module: TURNAROUND_KEY, ids: turnIds })
  }

  return synced
}

// 列表入口的动作：严格按状态机单向推进一格。
export function runCabinAction(id: number, action: string): ActionResult {
  const target = NEXT_STATUS_BY_ACTION[action]
  if (!target) {
    return { ok: false, message: `清洁任务没有登记「${action}」这个动作` }
  }

  const rows = listCabinTasks()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的清洁任务` }
  }
  const current = String(rows[index].status)
  const currentIndex = CABIN_STATUS_FLOW.indexOf(current as (typeof CABIN_STATUS_FLOW)[number])
  if (currentIndex < 0) {
    return { ok: false, message: `清洁任务当前状态「${current}」不在规范流程内，无法流转` }
  }
  if (isArchived(rows[index])) {
    // 历史归档保持原状态，任何动作都不再改它。
    return { ok: false, message: '该清洁任务已归档，历史归档保持原状态，不能再流转' }
  }
  if (inflight.has(id)) {
    return { ok: false, message: '该任务正在处理中，请勿重复提交' }
  }

  const targetIndex = CABIN_STATUS_FLOW.indexOf(target)
  if (targetIndex === currentIndex) {
    return { ok: false, message: `清洁任务已经是「${target}」，不用重复操作` }
  }
  if (targetIndex < currentIndex) {
    // 例如在「已完成」上再点开始清洁 / 完成清洁：禁止倒退。
    return { ok: false, message: `清洁状态只能按 ${CABIN_STATUS_FLOW.join(' → ')} 前进，不能从「${current}」退回「${target}」` }
  }
  if (targetIndex > currentIndex + 1) {
    // 例如待清洁直接完成：禁止越级。
    return { ok: false, message: `不能从「${current}」直接跳到「${target}」，请先完成中间环节` }
  }

  inflight.add(id)
  try {
    const nextRows = rows.map((row) => ({ ...row }))
    const updated: EntryRow = {
      ...nextRows[index],
      status: target,
      pending: target !== CABIN_STATUS_FLOW[CABIN_STATUS_FLOW.length - 1],
    }
    if (action === '完成清洁' && String(updated['实际完成'] ?? '').trim() === '') {
      updated['实际完成'] = today()
    }
    nextRows[index] = updated

    const flightNo = String(updated[FLIGHT_FIELD] ?? '').trim()
    const patch: Record<string, EntryRow[]> = { [CABIN_CLEAN_KEY]: nextRows }
    const synced = syncFlightLedgers(patch, flightNo, `客舱清洁：${target}`)
    saveAll(patch)

    return { ok: true, message: `清洁任务已${action}，当前状态「${target}」`, synced }
  } finally {
    inflight.delete(id)
  }
}

// 详情页确认复查：只登记复查结论并同步台账，状态保持「需复查」，绝不切回待清洁。
export function confirmCabinReview(id: number, conclusion: CabinReviewConclusion): ActionResult {
  const rows = listCabinTasks()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的清洁任务` }
  }
  const task = rows[index]
  if (String(task.status) !== '需复查') {
    return { ok: false, message: `只有「需复查」的任务才能确认复查，当前为「${String(task.status)}」` }
  }
  if (isArchived(task)) {
    return { ok: false, message: '该清洁任务已归档，历史归档保持原状态，不能再复查' }
  }
  // 已确认过（包括并发里抢先完成的那一次）：并发确认只生效一次。
  if (String(task[REVIEW_FIELD] ?? '').trim() !== '') {
    return { ok: false, message: `复查结论已确认为「${String(task[REVIEW_FIELD])}」，不能重复确认` }
  }
  if (inflight.has(id)) {
    return { ok: false, message: '复查正在提交中，请勿重复确认' }
  }

  inflight.add(id)
  try {
    const nextRows = rows.map((row) => ({ ...row }))
    nextRows[index] = {
      ...nextRows[index],
      [REVIEW_FIELD]: conclusion,
      [REVIEW_TIME_FIELD]: today(),
    }

    const flightNo = String(task[FLIGHT_FIELD] ?? '').trim()
    const patch: Record<string, EntryRow[]> = { [CABIN_CLEAN_KEY]: nextRows }
    // 其它页面的航班保障 / 过站台账同步同一份复查结论。
    const synced = syncFlightLedgers(patch, flightNo, `客舱清洁复查：${conclusion}`)
    saveAll(patch)

    return { ok: true, message: `复查已确认：${conclusion}，清洁状态保持「需复查」`, synced }
  } finally {
    inflight.delete(id)
  }
}
