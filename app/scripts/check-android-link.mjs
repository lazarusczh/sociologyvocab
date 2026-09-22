#!/usr/bin/env node
/**
 * Android 工程链接体检（preflight）
 *
 * 背景（2026-09-22 查清，纠正了两次错误归因）：
 *   `app/android` 是指向 `C:\vocab-build\android` 的 junction，用来绕开 OneDrive 占位。
 *   某次之后，本地 `git status` 把 **80 个 android 文件全显示成 `D`（已删除）**，
 *   并报 `warning: could not open directory 'app/android/'`。
 *
 *   ⚠️ **不是文件丢失，也不是 OneDrive，更不是别的会话**：
 *   在 OneDrive 之外新建同样指向 `C:\vocab-build\android` 的 junction，**同样无法遍历**，
 *   报 `[WinError 448] 无法遍历该路径，因为它包含不受信任的装入点`
 *   （ERROR_UNTRUSTED_MOUNT_POINT）。即：**是调用 git 的那个受限进程无法遍历 mount point**，
 *   于是既看不到内容、又把 80 个文件误判为删除。
 *
 * 因此本脚本的定位是「**体检 + 提醒**」，不是「修复器」：
 *   - 「目标工程（真实路径）」是**唯一权威判据**：它正常 = 数据完好，无需修任何东西；
 *   - 「junction 穿透性」失败只算 WARN —— 那可能只是当前环境的访问限制，不代表磁盘有问题；
 *   - **不要在 CodeBuddy 内对 app/android 做 git add，也不要为此重建 junction**（详见 project-memory.md）。
 *
 * 用法：node scripts/check-android-link.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..');
const LINK = path.join(APP, 'android');
const TARGET = 'C:\\vocab-build\\android';
const PROBE_REAL = path.join(TARGET, 'app', 'build.gradle');
const PROBE_LINK = path.join(LINK, 'app', 'build.gradle');

const ok = (m) => console.log(`  [ OK ] ${m}`);
const warn = (m) => console.log(`  [WARN] ${m}`);
const bad = (m) => console.log(`  [FAIL] ${m}`);

let fatal = 0;
let warns = 0;

console.log('== Android 工程体检 ==\n');

// ---- 1) 权威判据：真实路径下的工程是否完好 ----
console.log('1. 目标工程（真实路径，唯一权威判据）');
if (existsSync(PROBE_REAL)) {
  ok(`${PROBE_REAL} 存在`);
  try {
    const g = readFileSync(PROBE_REAL, 'utf8');
    const code = /versionCode\s+(\d+)/.exec(g)?.[1] ?? '?';
    const name = /versionName\s+"([^"]+)"/.exec(g)?.[1] ?? '?';
    ok(`当前版本 versionCode ${code} / versionName ${name}`);
  } catch {
    warn('build.gradle 存在但读取失败（权限？）');
    warns++;
  }
} else {
  bad(`不存在：${PROBE_REAL}`);
  bad('目标工程本身不完整 —— 这才是需要人工处理的真问题，且绝不要用 android.od-bak 覆盖（它可能是旧版本）');
  fatal++;
}

// ---- 2) junction 存在性（用 lstat，不做路径解析）----
console.log('\n2. junction 结构');
let isLink = false;
try {
  const st = lstatSync(LINK);
  isLink = st.isSymbolicLink();
  if (isLink) ok('app/android 是链接（junction）');
  else { warn('app/android 存在但不是链接（像是普通目录）'); warns++; }
} catch {
  bad('app/android 不存在');
  warns++;                       // 不致命：数据在真实路径那边
}

// ---- 3) 穿透性（可能受当前环境限制，只算 WARN）----
console.log('\n3. junction 穿透性（仅供参考）');
if (existsSync(PROBE_LINK)) {
  ok('穿过 junction 可读到 app/build.gradle');
} else {
  warn('穿过 junction 读不到 app/build.gradle');
  warn('这**不代表磁盘有问题**：在 CodeBuddy 等受限进程中，mount point 会报');
  warn('WinError 448 ERROR_UNTRUSTED_MOUNT_POINT。请在**普通终端**里核对：');
  warn(`  Test-Path "${LINK}\\app\\build.gradle"`);
  warns++;
}

// ---- 4) 仓库索引 ----
console.log('\n4. 仓库索引');
let tracked = 0;
try {
  const out = execFileSync('git', ['ls-files', 'app/android'], { cwd: REPO, encoding: 'utf8' });
  tracked = out.split('\n').filter(Boolean).length;
  if (tracked > 0) ok(`索引中有 ${tracked} 个 android 文件`);
  else { bad('索引中没有 android 文件'); fatal++; }
} catch (e) {
  warn(`git ls-files 失败：${e.message}`);
  warns++;
}

// ---- 5) 工作区是否被标记为删除（同上，只算 WARN）----
console.log('\n5. 工作区状态（仅供提醒）');
try {
  const out = execFileSync('git', ['status', '--short', '--', 'app/android'], { cwd: REPO, encoding: 'utf8' });
  const dels = out.split('\n').filter((l) => /^\s*D\s/.test(l)).length;
  if (dels === 0) ok('没有 android 文件被标记为删除');
  else {
    warn(`${dels} 个 android 文件被标记为删除`);
    warn('若第 1 项为 OK（目标工程完好），则这是**当前环境的误报**，无需修复；');
    warn('但务必遵守：**绝不要在 CodeBuddy 内 git add app/android**，也不要重建 junction。');
    warns++;
  }
} catch (e) {
  warn(`git status 失败：${e.message}`);
  warns++;
}

// ---- 结论 ----
console.log('\n== 结论 ==');
if (fatal > 0) {
  console.log(' 目标工程缺失 —— 需要人工处理（以真实路径为准，切勿用 od-bak 覆盖）。');
  process.exit(1);
}
if (warns > 0) {
  console.log(' 目标工程完好：**数据安全，无需修复任何东西**。');
  console.log(' 其余 WARN 多半来自当前环境的 mount point 访问限制。');
  console.log(' 需要核对时，请在普通终端里跑 Test-Path / git status，并以真实路径为准。');
  process.exit(0);
}
console.log(' 全部正常。');
