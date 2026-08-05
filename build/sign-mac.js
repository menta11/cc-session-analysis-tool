// electron-builder afterPack 钩子：mac 平台对 .app 做 ad-hoc 自签
// 时机：app 打包后、dmg 生成前 → dmg 内装的 .app 已是签名态
// 非 mac 平台直接跳过（不影响 win/linux）
// 入口：electron-builder.yml 的 afterPack 字段
const { execSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const productName = context.packager.appInfo.productName;
  const appPath = path.join(context.appOutDir, `${productName}.app`);

  console.log(`[sign-mac] → ad-hoc 自签 ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  console.log('[sign-mac] ✅ 签名完成');
};