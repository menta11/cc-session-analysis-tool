import type { SessionRef } from '../discovery/scan'

/**
 * 把扫描的进度推送并入已有列表：按 `path` 覆盖，同批新条目追加，结果按 mtime 倒序。
 *
 * 为什么放在 core：`scanProjects` 的两阶段推送（骨架 → 补齐）会反复送来**同一个会话的两种版本**，
 * 「后到的覆盖先到的」是该契约的一部分，值得被独立测到 —— 放在 React 组件里就只能靠手点验证。
 */
export function mergeSessionRefs(prev: readonly SessionRef[], incoming: readonly SessionRef[]): SessionRef[] {
  const merged = new Map(prev.map((s) => [s.path, s]))
  for (const ref of incoming) merged.set(ref.path, ref)
  return [...merged.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 左栏要显示的会话：已知「没有记录」的不显示（打开就是空表，占一行没有意义）。
 *
 * 只过滤 `false`：`undefined` 是「还没判定」（文件还没被读过），没判定就照常显示 ——
 * 因为判不出来而藏掉一行，比多显示一行糟得多。
 */
export function visibleSessions(refs: readonly SessionRef[]): SessionRef[] {
  return refs.filter((r) => r.hasRecords !== false)
}

/**
 * 左栏某个分组（项目 / 时间桶）是否展开：用户点过就按点过的，没点过按 `defaultOpen`。
 *
 * 默认值由调用方给而不是在这里定死：视图的规矩是「只默认展开第一组」，而哪一组是第一组取决于
 * 当前排序与筛选（项目视图＝首个项目，时间线＝最近那段），core 不该知道这些。
 *
 * 导出给视图层用，是因为箭头图标与列表内容**必须读同一个判据**。这里踩过一次：图标写
 * `!!open[key]`、列表写 `open[key] !== false` —— 默认态下两式的结果相反，于是箭头画成收起、
 * 列表却摊开着。
 */
export function isBucketOpen(
  open: Readonly<Record<string, boolean>>,
  key: string,
  defaultOpen: boolean,
): boolean {
  return open[key] ?? defaultOpen
}
