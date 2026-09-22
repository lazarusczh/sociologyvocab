#!/usr/bin/env node
/**
 * Android 打包（替代 `npx cap sync android && cd android && gradlew.bat assembleRelease`）
 *
 * 为什么需要它（2026-09-22）：
 *   `app/android` 是指向 `C:\vocab-build\android` 的 junction（用来绕开 OneDrive 占位）。
 *   CodeBuddy 的进程运行在受限完整性级别下，**无法穿越任何 mount point**
 *   （`WinError 448 ERROR_UNTRUSTED_MOUNT_POINT`，已实测确认与 OneDrive / 项目 / 路径位置均无关）。
 *   于是 `cap sync android` 与 `cd android` 都会失败，`npm run ship` 跟着挂掉。
 *
 *   但**真实路径 `C:\vocab-build\android` 是可以正常读写的** —— 所以这里：
 *     1) 把 web 产物 `dist` 复制到 android 工程的 assets（等价于 `cap copy android`）；
 *     2) 直接在真实路径下跑 gradle。
 *   **junction 因此可以原样保留，占位防护不受影响。**
 *
 * ⚠️ 与 `cap sync` 的差异（重要）：
 *   `cap sync` = `cap copy` + `cap update`。本脚本只做 `copy`。
 *   `cap update` 负责同步 **Capacitor 插件的原生依赖**（capacitor.settings.gradle / 插件 gradle 依赖）。
 *   —— **新增或升级 Capacitor 插件之后**，必须在**普通终端**里跑一次完整同步：
 *        cd app && npx cap sync android
 *   然后再用本脚本打包。平时（不改插件）无需。
 *
 * 用法：node scripts/android-release.mjs            # 复制 dist + gradle assembleRelease
 *       node scripts/android-release.mjs --copy-only # 只复制（不跑 gradle，用于快速自检）
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');                    // …/app
const SRC = path.join(APP, 'dist');                      // vite 产物（含 skill 子站）
const ANDROID_REAL = 'C:\\vocab-build\\android';         // **真实路径**，不是 junction
const ASSETS = path.join(ANDROID_REAL, 'app', 'src', 'main', 'assets');
const DEST = path.join(ASSETS, 'public');
const CAP_CONFIG = path.join(ASSETS, 'capacitor.config.json');

const copyOnly = process.argv.includes('--copy-only');
const step = (m) => console.log(`\n== ${m} ==`);
const info = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n[中止] ${m}\n`); process.exit(1); };

// ---- 护栏：目标路径必须确实是我们期望的那个，避免误删 ----
if (!DEST.includes(path.join('vocab-build', 'android', 'app', 'src', 'main', 'assets', 'public'))) {
  die(`目标路径异常，拒绝操作：${DEST}`);
}

step('1. 检查输入与目标');
if (!existsSync(SRC)) die(`未找到 web 产物：${SRC}\n     先运行 npm run build。`);
info(`web 产物：${SRC}`);
if (!existsSync(path.join(ANDROID_REAL, 'app', 'build.gradle'))) {
  die(`android 工程不完整：${ANDROID_REAL}\\app\\build.gradle 不存在`);
}
info(`android 工程（真实路径）：${ANDROID_REAL}`);
if (!existsSync(CAP_CONFIG)) {
  console.log('  [警告] 缺少 capacitor.config.json —— 原生壳将使用默认配置。');
  console.log('         若配置有变更，请在普通终端里跑一次 npx cap sync android。');
} else {
  info(`capacitor 配置：${CAP_CONFIG}`);
}

// ---- 复制 dist → assets/public（等价 cap copy）----
step('2. 复制 web 产物到 android assets');
try {
  rmSync(DEST, { recursive: true, force: true });        // 清掉旧产物，避免残留
  mkdirSync(DEST, { recursive: true });
  cpSync(SRC, DEST, { recursive: true });
} catch (e) {
  die(`复制失败：${e.message}`);
}
info(`已复制到：${DEST}`);

if (copyOnly) {
  console.log('\n--copy-only：跳过 gradle。\n');
  process.exit(0);
}

// ---- 关键修正：把 gradle 里对 node_modules 的【相对】引用改成【绝对】----
//
// 背景：`capacitor.settings.gradle` 由 `cap sync` 生成，内容是
//     project(':capacitor-android').projectDir = new File('../node_modules/@capacitor/android/capacitor')
// 这个 `..` 是相对 **gradle 的启动目录** 而言的：
//   · 过去从 `app/android`（junction 视角）启动 → `..` = `app/` → 能找到 `app/node_modules` ✓
//   · 现在从真实路径 `C:\vocab-build\android` 启动 → `..` = `C:\vocab-build` → **没有 node_modules** ✗
//     （表现为 `Could not resolve project :capacitor-android ... No variants exist`）
// 所以这里在打包前把相对引用改写为指向仓库里的 node_modules 的绝对路径。
// 幂等：已改过就不会重复处理；`cap sync` 覆盖后，下次打包会再改一遍。
step('2.5 修正 gradle 的 node_modules 引用（相对 → 绝对）');
const NM_ABS = path.join(APP, 'node_modules').replace(/\\/g, '/');   // gradle 字符串里用正斜杠，避免转义问题
const GRADLE_FILES = ['capacitor.settings.gradle', 'app/build.gradle', 'build.gradle', 'app/capacitor.build.gradle'];
let patched = 0;
for (const rel of GRADLE_FILES) {
  const f = path.join(ANDROID_REAL, rel);
  if (!existsSync(f)) continue;
  let t;
  try { t = readFileSync(f, 'utf8'); } catch { continue; }
  if (!t.includes('../node_modules')) continue;
  const next = t.replaceAll("new File('../node_modules/", `new File('${NM_ABS}/`);
  if (next !== t) {
    writeFileSync(f, next, 'utf8');
    info(`已改写 ${rel} → 绝对路径`);
    patched++;
  }
}
if (patched === 0) info('无需改写（已是绝对路径，或本工程未使用 node_modules 依赖）');

// ---- 在真实路径下跑 gradle ----
step('3. gradle assembleRelease（在真实路径下执行）');
try {
  execFileSync('gradlew.bat', ['assembleRelease'], {
    cwd: ANDROID_REAL,
    stdio: 'inherit',
    shell: true,
  });
} catch (e) {
  die(`gradle 失败：${e.message}\n     可手工重试：cd "${ANDROID_REAL}" && gradlew.bat assembleRelease`);
}

step('4. 完成');
info('APK 输出目录（见 package.json 的 feishu:send-apk 使用的是同一个路径）：');
info('  C:\\vocab-build\\app\\outputs\\apk\\release\\app-release.apk');
console.log('');
