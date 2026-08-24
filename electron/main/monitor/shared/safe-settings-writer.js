// safe-settings-writer.js — 通用"安全改写 JSON 文件"模块
// 强制 4 道闸: 差异保护 / 写前备份 / 原子写 / 写后校验回滚.
// 业务方只关心 "把 currentText 改成 newText", 文件 I/O 与失败兜底全部下沉到这里.
//
// 用法 (闭包捕获 newValue, transform 保持纯函数):
//   const { withSafeSettingsWrite } = require('./safe-settings-writer');
//   const newValue = 'http://localhost:8090';
//   const safe = String(newValue).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
//   withSafeSettingsWrite(SETTINGS_PATH, (text) => text.replace(REGEX, `$1${safe}$3`));
//
// 设计约束:
// - 业务方拿不到 fs, 物理上无法绕过模块直接写
// - 失败一律抛错 (不静默吞), 上层 try/catch 兜底
// - .bak 永不覆盖: 首次创建后保留, 永远是"用户上次能跑的版本"
// - 回滚用与主路径相同的原子操作 (.tmp + rename), 失败时也只可能留 .tmp 垃圾

const fs = require('fs');

const DEFAULT_MAX_DELTA_RATIO = 0.5;

function withSafeSettingsWrite(filePath, transform, opts = {}) {
  const maxDeltaRatio = opts.maxDeltaRatio ?? DEFAULT_MAX_DELTA_RATIO;
  const backupPath = filePath + '.bak';
  const tmpPath = filePath + '.tmp';

  // 闸2: 写前备份 (首次创建, 永不覆盖)
  function ensureBackup() {
    if (fs.existsSync(backupPath)) return;
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch (e) {
      throw new Error(`backup failed: ${e.message}`);
    }
  }

  // 回滚: 从 .bak 恢复 (同样用原子写)
  function restoreFromBackup() {
    const backup = fs.readFileSync(backupPath, 'utf8');
    fs.writeFileSync(tmpPath, backup, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  // 闸3: 原子写
  function atomicWrite(text) {
    try {
      fs.writeFileSync(tmpPath, text, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      throw new Error(`write failed: ${e.message}`);
    }
  }

  // 主流程
  const text = fs.readFileSync(filePath, 'utf8');
  const newText = transform(text);
  if (newText === text) return;  // 无变化, 跳过 I/O

  // 闸1: 差异保护
  const delta = Math.abs(newText.length - text.length) / Math.max(1, text.length);
  if (delta > maxDeltaRatio) {
    throw new Error(
      `aborted: size delta ${(delta * 100).toFixed(1)}% exceeds ${(maxDeltaRatio * 100)}% threshold`
    );
  }

  ensureBackup();        // 闸2
  atomicWrite(newText);  // 闸3

  // 闸4: 写后校验
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('[safe-settings-writer] post-write validation failed, rolling back:', e.message);
    try { restoreFromBackup(); }
    catch (re) {
      console.error('[safe-settings-writer] CRITICAL: rollback failed:', re.message);
      throw new Error(`validation failed AND rollback failed: ${e.message} / ${re.message}`);
    }
    throw new Error(`post-write validation failed, restored from backup: ${e.message}`);
  }
}

module.exports = { withSafeSettingsWrite };

