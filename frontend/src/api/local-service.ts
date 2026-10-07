import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, refreshFromStorage, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 客舱清洁流转后要同步的台账：按关联航班匹配，把最新清洁结论写进对方的进度字段。
// 已归档（终态）的台账记录保持原状态，不回写。
type LedgerSyncTarget = {
  key: string
  label: string
  flightField: string
  progressField: string
  archivedStatuses: string[]
}

const CABIN_CLEAN_SYNC_TARGETS: LedgerSyncTarget[] = [
  {
    key: 'turnaround',
    label: '过站台账保障进度',
    flightField: '关联航班',
    progressField: '保障进度',
    archivedStatuses: ['正常完成', '已超时'],
  },
  {
    key: 'flight_ops',
    label: '航班保障台账保障节点',
    flightField: '航班号',
    progressField: '保障节点',
    archivedStatuses: ['已就绪', '已延误'],
  },
]

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const meta = moduleMeta(key)
  const displayRows = listRows(key).map((row) => applyFieldFallbacks(meta, row))
  const matched = filterRows(displayRows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 字段兜底只作用于展示与导出，不写回存储：历史归档数据保持原状态。
function applyFieldFallbacks(meta: ModuleMeta, row: EntryRow): EntryRow {
  if (!meta.fieldFallbacks) {
    return row
  }
  const patched = { ...row }
  for (const [field, fallback] of Object.entries(meta.fieldFallbacks)) {
    if (String(patched[field] ?? '').trim() === '') {
      patched[field] = fallback
    }
  }
  return patched
}

// 当前记录上允许执行的动作：登记了流转规则的模块，只放出能从当前状态出发的动作。
export function availableActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  const status = String(row.status)
  return meta.actions.filter((action) => {
    const rule = meta.transitions?.[action]
    return rule ? rule.from.includes(status) : true
  })
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 并发确认只生效一次：动手前先回读持久化数据，别的页签已确认的流转在这里会被拦住。
  refreshFromStorage()
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const rule = meta.transitions?.[action]
  if (rule && !rule.from.includes(current)) {
    const chain = meta.statuses.join('→')
    return {
      ok: false,
      message: `${meta.entity}当前状态为「${current}」，不能执行「${action}」：只能按 ${chain} 单向流转，禁止越级和倒退`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 流转只成功这一次，台账同步也只写这一次，不会重复变更。
  const synced = key === 'cabin_clean' ? syncCabinCleanLedgers(updated, target) : []
  const suffix = synced.length > 0 ? `，已同步${synced.join('、')}` : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

// 把客舱清洁的最新结论同步到过站台账与航班保障台账；已归档的台账记录保持原状态。
function syncCabinCleanLedgers(row: EntryRow, conclusion: string): string[] {
  const flight = String(row['关联航班'] ?? '').trim()
  if (!flight) {
    return []
  }
  const synced: string[] = []
  for (const target of CABIN_CLEAN_SYNC_TARGETS) {
    const ledgerRows = listRows(target.key)
    let touched = false
    const nextRows = ledgerRows.map((item) => {
      if (String(item[target.flightField] ?? '').trim() !== flight) {
        return item
      }
      if (target.archivedStatuses.includes(String(item.status))) {
        return item
      }
      touched = true
      return { ...item, [target.progressField]: `客舱清洁：${conclusion}` }
    })
    if (touched) {
      saveRows(target.key, nextRows)
      synced.push(target.label)
    }
  }
  return synced
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    const display = applyFieldFallbacks(meta, row)
    lines.push([display.id, ...meta.fields.map((field) => display[field] ?? ''), display.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
