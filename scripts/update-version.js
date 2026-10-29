const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');
try {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = pkg.version;

  // 视图名固定为产品名；版本号通过侧栏头部的 version-tag-pill 展示（对齐 BuddyRelay）
  if (pkg.contributes && pkg.contributes.views && pkg.contributes.views.antigravityKite) {
    const view = pkg.contributes.views.antigravityKite[0];
    if (view && view.name !== 'Antigravity Kite') {
      view.name = 'Antigravity Kite';
      fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      console.log('[Auto-Update] Normalized view name to "Antigravity Kite"');
    }
  }
  console.log(`[Kite] version: ${version}`);
} catch (e) {
  console.error('[Auto-Update] Failed to inspect version:', e);
}
