<template>
  <section class="page" data-module="cabin_clean-detail">
    <header class="page-head">
      <div>
        <h2>客舱清洁任务详情</h2>
        <p class="page-desc">按 {{ flowText }} 单向流转；复查确认只登记结论，清洁状态保持「需复查」，不会退回待清洁。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="goBack">返回列表</button>
      </div>
    </header>

    <article v-if="task" class="detail-card">
      <div class="detail-head">
        <div>
          <span class="detail-id">{{ task['清洁编号'] }}</span>
          <span class="status-badge">{{ task.status }}</span>
          <span v-if="archived" class="tag tag-archived">已归档</span>
        </div>
        <div class="review-conclusion" v-if="reviewConclusion">
          复查结论：<strong>{{ reviewConclusion }}</strong>（{{ task['复查时间'] }} 确认）
        </div>
      </div>

      <ol class="flow-bar">
        <li
          v-for="(status, index) in statuses"
          :key="status"
          class="flow-step"
          :class="{ active: index <= currentIndex, current: index === currentIndex }"
        >
          <span class="flow-index">{{ index + 1 }}</span>
          <span class="flow-label">{{ status }}</span>
        </li>
      </ol>

      <dl class="detail-grid">
        <template v-for="field in fields" :key="field">
          <dt>{{ field }}</dt>
          <dd>{{ field === '清洁班组' ? crew : valueOf(field) }}</dd>
        </template>
        <dt>复查结论</dt>
        <dd>{{ reviewConclusion || '尚未复查' }}</dd>
      </dl>

      <div class="detail-actions">
        <button
          v-if="nextAction && !archived"
          class="btn primary"
          type="button"
          :disabled="submitting"
          @click="runNext"
        >
          {{ nextAction }}
        </button>
        <template v-if="task.status === '需复查' && !archived">
          <button
            class="btn"
            type="button"
            :disabled="submitting || Boolean(reviewConclusion)"
            @click="confirmReview('复查通过')"
          >
            确认复查通过
          </button>
          <button
            class="btn"
            type="button"
            :disabled="submitting || Boolean(reviewConclusion)"
            @click="confirmReview('复查不通过')"
          >
            确认复查不通过
          </button>
        </template>
        <p v-if="archived" class="hint">历史归档保持原状态，不可再执行清洁或复查动作。</p>
        <p v-else-if="reviewConclusion" class="hint">复查已确认，并发确认只生效一次，不能重复提交。</p>
      </div>

      <footer class="page-foot">
        <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
      </footer>
    </article>

    <article v-else class="detail-card">
      <p class="empty-state">没有找到这条清洁任务。</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { runAction } from '@/api/local-service'
import {
  CABIN_STATUS_FLOW,
  cabinCrew,
  confirmCabinReview,
  getCabinTask,
  isArchived,
} from '@/data/cabin-clean'
import type { CabinReviewConclusion } from '@/data/types'

const route = useRoute()
const router = useRouter()

const statuses = [...CABIN_STATUS_FLOW]
const flowText = statuses.join(' → ')
const NEXT_ACTION = ['开始清洁', '完成清洁', '安排复查']
const fields = ["清洁编号", "关联航班", "清洁类型", "清洁班组", "计划开始", "实际完成", "清洁用时"]

const taskId = Number(route.params.id)
// 从本地数据层读取最新一条：动作成功后重新取，避免详情页拿着旧状态再改一次。
const task = ref(getCabinTask(taskId))
const submitting = ref(false)
const message = ref('')
const messageOk = ref(true)

const currentIndex = computed(() =>
  task.value ? statuses.indexOf(String(task.value.status) as (typeof CABIN_STATUS_FLOW)[number]) : -1,
)
const archived = computed(() => (task.value ? isArchived(task.value) : false))
const crew = computed(() => (task.value ? cabinCrew(task.value) : '待补录'))
const reviewConclusion = computed(() =>
  task.value ? String(task.value['复查结论'] ?? '').trim() : '',
)
const nextAction = computed(() => {
  if (!task.value || archived.value) {
    return null
  }
  const index = currentIndex.value
  if (index < 0 || index >= NEXT_ACTION.length) {
    return null
  }
  return NEXT_ACTION[index]
})

function valueOf(field: string): string {
  if (!task.value) {
    return '—'
  }
  const value = task.value[field]
  return value === '' || value == null ? '—' : String(value)
}

function syncText(result: { synced?: { module: string; ids: number[] }[] }): string {
  const names: Record<string, string> = { flight_ops: '航班保障台账', turnaround: '过站台账' }
  const parts = (result.synced ?? [])
    .filter((item) => item.ids.length > 0)
    .map((item) => `${names[item.module] ?? item.module} ${item.ids.length} 条`)
  return parts.length > 0 ? `；已同步复查/清洁结论到：${parts.join('、')}` : ''
}

function refresh() {
  task.value = getCabinTask(taskId)
}

function runNext() {
  if (!nextAction.value || submitting.value) {
    return
  }
  submitting.value = true
  message.value = ''
  const result = runAction('cabin_clean', taskId, nextAction.value)
  submitting.value = false
  if (!result.ok) {
    messageOk.value = false
    message.value = result.message
    return
  }
  messageOk.value = true
  message.value = `${result.message}${syncText(result)}`
  refresh()
}

function confirmReview(conclusion: CabinReviewConclusion) {
  if (submitting.value) {
    return
  }
  submitting.value = true
  message.value = ''
  const result = confirmCabinReview(taskId, conclusion)
  submitting.value = false
  if (!result.ok) {
    messageOk.value = false
    message.value = result.message
    return
  }
  messageOk.value = true
  message.value = `${result.message}${syncText(result)}`
  refresh()
}

function goBack() {
  router.push({ name: 'cabin_clean' })
}
</script>

<style scoped>
.detail-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 18px;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.detail-id { font-size: 16px; font-weight: 600; margin-right: 8px; }
.status-badge {
  display: inline-block;
  background: #e8f0fe;
  color: var(--brand);
  border-radius: 999px;
  padding: 2px 12px;
  font-size: 12px;
}
.tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
}
.tag-archived { background: #e2e8f0; color: #475569; }
.review-conclusion { font-size: 13px; color: #475569; }
.flow-bar {
  list-style: none;
  display: flex;
  margin: 18px 0;
  padding: 0;
}
.flow-step {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #94a3b8;
  position: relative;
}
.flow-step:not(:last-child)::after {
  content: '';
  flex: 1;
  height: 2px;
  background: #e2e8f0;
  margin: 0 8px;
}
.flow-step.active { color: var(--brand); }
.flow-step.active:not(:last-child)::after { background: var(--brand); }
.flow-step.current .flow-index { box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.2); }
.flow-index {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #e2e8f0;
  color: #475569;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.flow-step.active .flow-index { background: var(--brand); color: #fff; }
.flow-label { font-size: 13px; white-space: nowrap; }
.detail-grid {
  display: grid;
  grid-template-columns: 120px 1fr 120px 1fr;
  gap: 8px 14px;
  margin: 8px 0 18px;
}
.detail-grid dt { color: var(--muted); font-size: 13px; }
.detail-grid dd { margin: 0; font-size: 13px; }
.detail-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.detail-actions .btn:disabled { opacity: 0.55; cursor: not-allowed; }
.hint { color: var(--muted); font-size: 12px; margin: 0; }
.ok-text { color: #15803d; }
</style>
