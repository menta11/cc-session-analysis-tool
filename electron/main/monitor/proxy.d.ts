// proxy.js 原样搬运自 cc-monitor-app (CommonJS, 逻辑不改), 此处只声明主进程消费的导出面.
// 资产 (dashboard.html / mini.html / config.json) 由 viteStaticCopy 拷到 out/main/monitor/.
declare const monitorProxy: {
  startProxy: () => Promise<void>
  stopProxy: () => Promise<void>
  /** 善后恢复: settings.json 指向 localhost proxy 且记录过原值时写回原值. 启动自愈 + 退出钩子共用. */
  restoreBaseUrlIfStale: () => { restored: boolean; previous?: string }
  /** 启动偏好: 未被用户显式关闭过监控 → 自动开启 (改写 ANTHROPIC_BASE_URL 指向本代理). */
  applyStartupPreference: () => { enabled: boolean; reason?: string; status?: unknown }
  /** 代理端口 (config.json / CC_MONITOR_PORT 解析后的单一来源). */
  getPort: () => number
}

export default monitorProxy
