<template>
  <section class="page" data-module="cabin_clean">
    <header class="page-head">
      <div>
        <h2>客舱清洁管理</h2>
        <p class="page-desc">维护清洁任务，围绕清洁编号、关联航班、清洁类型、清洁班组做登记、筛选与状态流转。状态按 {{ flowText }} 单向推进。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记清洁任务</button>
        <button class="btn" type="button" @click="exportRows">导出客舱清洁清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '清洁班组'">{{ crewText(row) }}</template>
            <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="isArchived(row)" class="tag tag-archived">已归档</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
            <button
              v-if="nextAction(row)"
              class="link"
              type="button"
              @click="runAction(String(nextAction(row)), row)"
            >
              {{ nextAction(row) }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无客舱清洁数据，可先登记清洁任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条客舱清洁记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  CABIN_STATUS_FLOW,
  cabinCrew,
  isArchived,
} from '@/data/cabin-clean'
import type { EntryRow } from '@/data/types'

const router = useRouter()
const meta = moduleMeta('cabin_clean')
const columns = ["清洁编号", "关联航班", "清洁类型", "清洁班组", "计划开始", "实际完成", "清洁用时"]
const statuses = [...CABIN_STATUS_FLOW]
const flowText = statuses.join(' → ')
// 每个状态在列表上只暴露「走到下一状态」的那一个动作；待清洁→开始清洁、清洁中→完成清洁、已完成→安排复查。
const NEXT_ACTION = ['开始清洁', '完成清洁', '安排复查']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["清洁编号", "关联航班", "清洁类型"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() =>
  statuses.map((status) => ({
    label: `${status}航班`,
    value: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function crewText(row: EntryRow): string {
  return cabinCrew(row)
}

function nextAction(row: EntryRow): string | null {
  // 归档记录没有后续动作；只给当前状态的下一格开口，从根上避免越级和倒退。
  if (isArchived(row)) {
    return null
  }
  const index = statuses.indexOf(String(row.status) as (typeof CABIN_STATUS_FLOW)[number])
  if (index < 0 || index >= NEXT_ACTION.length) {
    return null
  }
  return NEXT_ACTION[index]
}

function syncText(result: { synced?: { module: string; ids: number[] }[] }): string {
  const names: Record<string, string> = { flight_ops: '航班保障', turnaround: '过站台账' }
  const parts = (result.synced ?? [])
    .filter((item) => item.ids.length > 0)
    .map((item) => `${names[item.module] ?? item.module} ${item.ids.length} 条`)
  return parts.length > 0 ? `；已同步：${parts.join('、')}` : ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '清洁任务登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  router.push({ name: 'cabin_clean_detail', params: { id: String(row.id) } })
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  reload()
  // 联动结果提示放在成功消息里，保证一次动作只联动一次。
  window.alert(`${result.message}${syncText(result)}`)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '客舱清洁列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
}
.tag-archived {
  background: #e2e8f0;
  color: #475569;
}
</style>
