import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { getAppDataDir } from './platformPaths';

export { getAppDataDir } from './platformPaths';

export function getSharedStorageDir(): string {
  const dir = path.join(getAppDataDir(), '.antigravity-kite');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

/**
 * 如果共享存储目录中不存在指定文件，或者旧的 globalStorage 中存在未合并的数据，则将其合并拷贝过来，并备份本地旧数据以防数据丢失或覆盖
 */
export function migrateDataIfNeeded(context: vscode.ExtensionContext, filename: string): string {
  const sharedDir = getSharedStorageDir();
  const targetPath = path.join(sharedDir, filename);
  const legacyPath = path.join(context.globalStorageUri.fsPath, filename);
  
  if (fs.existsSync(legacyPath)) {
    try {
      if (!fs.existsSync(targetPath)) {
        // 共享文件不存在，直接复制
        fs.copyFileSync(legacyPath, targetPath);
        console.log(`[storage] Initial migrated ${filename} from globalStorage to shared storage`);
      } else {
        // 共享文件存在，读取双方并执行去重合并
        const legacyData = fs.readFileSync(legacyPath, 'utf8');
        const sharedData = fs.readFileSync(targetPath, 'utf8');
        
        if (filename === 'accounts.json') {
          const legacyList = JSON.parse(legacyData) as any[];
          const sharedList = JSON.parse(sharedData) as any[];
          const mergedList = [...sharedList];
          
          for (const item of legacyList) {
            if (item && item.email && !mergedList.some(x => x.email && x.email.toLowerCase() === item.email.toLowerCase())) {
              mergedList.push(item);
            }
          }
          fs.writeFileSync(targetPath, JSON.stringify(mergedList, null, 2), 'utf8');
          console.log(`[storage] Merged accounts from legacy globalStorage to shared storage`);
        } else {
          // 其他未知文件不进行合并，防覆盖
          console.log(`[storage] Shared ${filename} already exists, skipping copy`);
        }
      }
      
      // 合并或迁移成功后，将本地的 legacy 文件重命名备份，防止每次启动重复处理
      const backupPath = legacyPath + '.migrated';
      fs.renameSync(legacyPath, backupPath);
      console.log(`[storage] Backed up legacy data to ${backupPath}`);
      
    } catch (e) {
      console.error(`[storage] Failed to migrate/merge ${filename}:`, e);
    }
  }
  return sharedDir;
}
