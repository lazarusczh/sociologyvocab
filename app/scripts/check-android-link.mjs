#!/usr/bin/env node
/**
 * Android 工程链接体检（preflight）
 *
 * 为什么需要它（2026-09-22 实际踩到）：
 *   `app/android` 是指向 `C:\vocab-build\android` 的 junction，用来绕开 OneDrive 占位。
 *   但 OneDrive 周期扫描会**把这个 junction 也纳管**（给它打上 PINNED 云文件属性）——
 *   重解析点还在（`Test-Path` 返回 True），可穿过它读内容却全部失败，
 *   于是 `git status` 把 **80 个 android 文件全显示成 `D`（已删除）**。
 *   此时若有人 `git add -A` 提交，就会把整个 Android 工程从版本库里抹掉。
 *
 * 本脚本只做**只读检查**，不修改任何东西；发现问题时打印修复命令由人来执行。
 * 建议：封包（npm run ship）前、以及每次会话开始处理 Android 相关任务前跑一次。
 *
 * 用法：node scripts/check-android-link.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');            // …/app
const REPO = path.resolve(APP, '..');            // 仓库根
const LINK = path.join(APP, 'android');          // junction
const TARGET = 'C:\\vocab-build\\android';       // 期望目标
const PROBE = path.join(LINK, 'app', 'build.gradle'); // 穿透性探针
const PROBE_REAL = path.join(TARGET, 'app', 'build.gradle');

const ok = (m) => console.log(`  [ OK ] ${m}`);
const bad = (m) => console.log(`  [FAIL] ${m}`);
const warn = (m) => console.log(`  [WARN] ${m}`);

let failures = 0;

console.log('== Android 工程链接体检 ==\n');

// 1) 目标工程是否完好（真实路径）
console.log('1. 目标工程（真实路径）');
if (existsSync(PROBE_REAL)) {
  ok(`${TARGET}\\app\\build.gradle 存在`);
  try {
    const g = readFileSync(PROBE_REAL, 'utf8');
    const code = /versionCode\s+(\d+)/.exec(g)?.[1] ?? '?';
    const name = /versionName\s+"([^"]+)"/.exec(g)?.[1] ?? '?';
    ok(`当前版本 versionCode ${code} / versionName ${name}`);
  } catch { warn('读 build.gradle 失败（权限？）'); }
} else {
  bad(`${TARGET}\\app\\build.gradle 不存在 —— 目标工程本身不完整`);
  failures++;
}

// 2) junction 能否穿透
console.log('\n2. junction 穿透性');
if (existsSync(LINK)) {
  ok(`${LINK} 存在`);
} else {
  bad(`${LINK} 不存在（junction 丢失）`);
  failures++;
}
if (existsSync(PROBE)) {
  ok('穿过 junction 可读到 app/build.gradle');
} else {
  bad('穿过 junction 读不到 app/build.gradle —— junction 失效');
  failures++;
}

// 3) 仓库索引是否完好（工作区缺失不影响这里）
console.log('\n3. 仓库索引');
let tracked = 0;
try {
  const out = execFileSync('git', ['ls-files', 'app/android'], { cwd: REPO, encoding: 'utf8' });
  tracked = out.split('\n').filter(Boolean).length;
  if (tracked > 0) ok(`索引中有 ${tracked} 个 android 文件`);
  else { bad('索引中没有 android 文件'); failures++; }
} catch (e) {
  warn(`git ls-files 失败：${e.message}`);
}

// 4) 工作区是否有被误标记为删除
console.log('\n4. 工作区状态（是否有 android 被标记删除）');
try {
  const out = execFileSync('git', ['status', '--short', '--', 'app/android'], { cwd: REPO, encoding: 'utf8' });
  const dels = out.split('\n').filter((l) => /^\s*D\s/.test(l)).length;
  if (dels === 0) ok('没有 android 文件被标记为删除');
  else { bad(`${dels} 个 android 文件被标记为删除（工作区读不到）`); failures++; }
} catch (e) {
  warn(`git status 失败：${e.message}`);
}

// 结论
console.log('\n== 结论 ==');
if (failures === 0) {
  console.log('通过：可以正常提交与封包。');
  process.exit(0);
}

console.log(`发现 ${failures} 项问题。`);
if (existsSync(PROBE_REAL) && !existsSync(PROBE)) {
  console.log(`
情况判断：**目标工程完好、只是 junction 失效** —— 数据没丢，不需要恢复任何文件。

修复（三条铁律：rmdir 不带 /s；不要动 od-bak；先确认索引完好）：

  cd "${REPO}"
  git ls-files app/android | find /c /v ""      :: 应输出 ${tracked}（索引完好）
  rmdir "app\\android"                          :: 只删链接，不带 /s
  mklink /J "app\\android" "${TARGET}"
  node scripts/check-android-link.mjs           :: 复查

⚠️ 绝不要用 C:\\vocab-build\\android.od-bak 覆盖当前工程：
   那是更早版本的备份（曾出现 1.7.22 vs 1.8.11 的版本落差），覆盖会造成版本回退。
`);
} else {
  console.log(`
目标工程本身可能不完整（${TARGET}）。
先确认其内容，再考虑从 od-bak 或 git 恢复；**不要盲目覆盖**。
`);
}
process.exit(1);
