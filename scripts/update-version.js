const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');
try {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = pkg.version;
  
  if (pkg.contributes && pkg.contributes.views && pkg.contributes.views.antigravityKite) {
    const view = pkg.contributes.views.antigravityKite[0];
    if (view && view.name !== version) {
      view.name = version;
      fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      console.log(`[Auto-Update] Synced view name to version ${version}`);
    }
  }
} catch (e) {
  console.error('[Auto-Update] Failed to sync version:', e);
}
