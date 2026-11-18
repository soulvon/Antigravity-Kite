/**
 * 共享存储目录与跨位置数据迁移（运行期零 vscode 依赖）
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { getAppDataDir } from './platformPaths';
import { atomicWriteJsonSync, readJsonFileSafe } from './atomicFile';

export { getAppDataDir } from './platformPaths';

interface LegacyAccountItem {
  email?: string;
  [key: string]: unknown;
}

export function getSharedStorageDir(): string {
  const override = process.env.KITE_SHARED_DIR?.trim();
  const dir = override || path.join(getAppDataDir(), '.antigravity-kite');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`[storage] Failed to create shared storage dir ${dir}:`, err instanceof Error ? err.message : String(err));
  }
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
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(legacyPath, targetPath);
        console.log(`[storage] Initial migrated ${filename} from globalStorage to shared storage`);
      } else if (filename === 'accounts.json') {
        // 共享文件存在，安全读取双方并去重合并（读失败绝不覆盖）
        const legacyRes = readJsonFileSafe<unknown>(legacyPath);
        const sharedRes = readJsonFileSafe<unknown>(targetPath);
        if (legacyRes.status !== 'ok' || sharedRes.status !== 'ok') {
          console.error('[storage] Aborting accounts migration merge due to read failure', {
            legacyStatus: legacyRes.status,
            sharedStatus: sharedRes.status,
          });
          return sharedDir;
        }
        if (!Array.isArray(legacyRes.data) || !Array.isArray(sharedRes.data)) {
          console.error('[storage] Aborting accounts migration merge: non-array payload');
          return sharedDir;
        }

        const legacyList = legacyRes.data as LegacyAccountItem[];
        const mergedList = [...(sharedRes.data as LegacyAccountItem[])];

        for (const item of legacyList) {
          if (
            item &&
            typeof item.email === 'string' &&
            item.email &&
            !mergedList.some(
              (x) => typeof x?.email === 'string' && x.email.toLowerCase() === item.email!.toLowerCase(),
            )
          ) {
            mergedList.push(item);
          }
        }
        atomicWriteJsonSync(targetPath, mergedList, 0o600);
        console.log('[storage] Merged accounts from legacy globalStorage to shared storage');
      } else {
        // 其他未知文件不进行合并，防覆盖
        console.log(`[storage] Shared ${filename} already exists, skipping copy`);
      }

      // 合并或迁移成功后，将本地的 legacy 文件重命名备份，防止每次启动重复处理
      const backupPath = `${legacyPath}.migrated`;
      fs.renameSync(legacyPath, backupPath);
      console.log(`[storage] Backed up legacy data to ${backupPath}`);
    } catch (e) {
      console.error(`[storage] Failed to migrate/merge ${filename}:`, e);
    }
  }
  return sharedDir;
}
