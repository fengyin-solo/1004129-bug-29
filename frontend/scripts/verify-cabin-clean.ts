// 临时验证脚本：在 Node 里模拟 localStorage，跑客舱清洁状态机的全部关键路径。
import { listRows, resetRows } from '../src/data/local-store'
import {
  CABIN_STATUS_FLOW,
  CABIN_CREW_FALLBACK,
  cabinCrew,
  confirmCabinReview,
  getCabinTask,
  isArchived,
  runCabinAction,
} from '../src/data/cabin-clean'

// --- localStorage stub ---
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  },
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

function cabinStatus(id: number) {
  return String(getCabinTask(id)!.status)
}

// 用全新种子数据
resetRows('cabin_clean')
resetRows('flight_ops')
resetRows('turnaround')

console.log('1) 正常单向推进（id=1: 待清洁 → 清洁中 → 已完成 → 需复查）')
check('初始待清洁', cabinStatus(1) === '待清洁', cabinStatus(1))
let r = runCabinAction(1, '开始清洁')
check('开始清洁 ok', r.ok, r.message)
check('当前清洁中', cabinStatus(1) === '清洁中', cabinStatus(1))
r = runCabinAction(1, '完成清洁')
check('完成清洁 ok', r.ok, r.message)
check('当前已完成', cabinStatus(1) === '已完成', cabinStatus(1))
check('实际完成被回填', String(getCabinTask(1)!['实际完成'] ?? '') !== '')
r = runCabinAction(1, '安排复查')
check('安排复查 ok', r.ok, r.message)
check('当前需复查', cabinStatus(1) === '需复查', cabinStatus(1))

console.log('2) 禁止越级（id=2: 清洁中 直接安排复查）')
r = runCabinAction(2, '安排复查')
check('越级被拒', !r.ok, r.message)
check('状态仍清洁中', cabinStatus(2) === '清洁中', cabinStatus(2))

console.log('3) 禁止倒退（id=3: 已完成 再点完成/开始）')
r = runCabinAction(3, '完成清洁')
check('重复/倒退被拒', !r.ok, r.message)
r = runCabinAction(3, '开始清洁')
check('倒退被拒', !r.ok, r.message)
check('状态仍已完成', cabinStatus(3) === '已完成', cabinStatus(3))

console.log('4) 详情页复查只登记结论，状态不退回')
const before = cabinStatus(1)
r = confirmCabinReview(1, '复查不通过')
check('复查确认 ok', r.ok, r.message)
check('状态保持需复查', cabinStatus(1) === '需复查', cabinStatus(1))
check('没有退回待清洁', cabinStatus(1) === before)
check('结论已记录', String(getCabinTask(1)!['复查结论']) === '复查不通过')
r = confirmCabinReview(1, '复查通过')
check('并发/重复确认只生效一次', !r.ok, r.message)
check('结论仍是复查不通过', String(getCabinTask(1)!['复查结论']) === '复查不通过')

console.log('5) 非需复查状态不能确认复查（id=2 清洁中）')
r = confirmCabinReview(2, '复查通过')
check('被拒', !r.ok, r.message)

console.log('6) 跨模块台账同步，且一次动作只写一次')
// id=2 清洁中→已完成，航班 CA1802；台账应出现一次「客舱清洁：已完成」
r = runCabinAction(2, '完成清洁')
check('动作 ok', r.ok, r.message)
const ops = listRows('flight_ops')
const turn = listRows('turnaround')
const opsCA1802 = ops.find((x) => String(x['航班号']) === 'CA1802')!
const turnCA1802 = turn.find((x) => String(x['关联航班']) === 'CA1802')!
check('航班保障节点同步', String(opsCA1802['保障节点']) === '客舱清洁：已完成', String(opsCA1802['保障节点']))
check('过站保障进度同步', String(turnCA1802['保障进度']) === '客舱清洁：已完成', String(turnCA1802['保障进度']))
// 再执行一次相同同步（安排复查），验证结论同步到 id=2 复查
runCabinAction(2, '安排复查')
confirmCabinReview(2, '复查通过')
check(
  '复查结论同步到航班保障',
  String(listRows('flight_ops').find((x) => String(x['航班号']) === 'CA1802')!['保障节点']) === '客舱清洁复查：复查通过',
)
check(
  '复查结论同步到过站台账',
  String(listRows('turnaround').find((x) => String(x['关联航班']) === 'CA1802')!['保障进度']) === '客舱清洁复查：复查通过',
)
// id=3 已完成，两次拒绝动作期间台账不应被写第二遍
check(
  'CA1803 台账保持一次性结果未被连改两次',
  String(listRows('turnaround').find((x) => String(x['关联航班']) === 'CA1803')!['保障进度']) === '客舱清洁：已完成',
)

console.log('7) 历史归档保持原状态（id=5 已完成 + archived）')
const archived = getCabinTask(5)!
check('识别为已归档', isArchived(archived))
r = runCabinAction(5, '完成清洁')
check('归档记录动作被拒', !r.ok, r.message)
r = runCabinAction(5, '安排复查')
check('归档记录不能越级复查', !r.ok, r.message)
r = confirmCabinReview(5, '复查通过')
check('归档记录不能复查', !r.ok, r.message)
check('归档状态仍是已完成', cabinStatus(5) === '已完成', cabinStatus(5))

console.log('8) 缺班组归属兼容为待补录（id=4）')
check('空班组兼容', cabinCrew(getCabinTask(4)!) === CABIN_CREW_FALLBACK)
check('正常班组保留', cabinCrew(getCabinTask(1)!) === '客舱清洁一班', cabinCrew(getCabinTask(1)!))

console.log('9) 状态机常量顺序')
check('顺序固定', CABIN_STATUS_FLOW.join(',') === '待清洁,清洁中,已完成,需复查', CABIN_STATUS_FLOW.join(','))

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
