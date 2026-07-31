/**
 * 反编码 sanitized-cwd 目录名 → 可读路径（会话列表文件夹标题用）。纯函数，无 fs 依赖。
 *  Windows 盘符：D--workspace-process-docs → D:/workspace-process-docs（保留内部 -）。
 *  Unix：-Users-foo → /Users/foo（- → /，有损，无法区分原始 -）。
 */
export function decodeProjectDir(name: string): string {
  const win = name.match(/^([A-Za-z])--(.+)$/)
  if (win) return `${win[1]}:/${win[2]}`
  return name.replace(/-/g, '/')
}
