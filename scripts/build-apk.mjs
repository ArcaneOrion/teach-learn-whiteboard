#!/usr/bin/env node
/**
 * 一条命令出 APK：`pnpm apk`
 *
 * 做四件事：
 *   ① 版本号 +1（补丁位），刷到 build.gradle / main.ts / package.json
 *   ② 构建网页产物 → cap sync → gradle assembleDebug
 *   ③ 把 APK 复制到 `.artifacts/apk/`，文件名带版本号（所以永远不会重名）
 *   ④ **清掉旧版本的 APK**，那个目录里永远只有最新一个
 *
 * ## 为什么要带版本号命名 + 清旧的
 *
 * 覆盖安装时人要能一眼看出「手机里装的是哪一版、手上拿的是哪一版」。
 * 都叫 app-debug.apk 的话，传了三次到手机，自己都分不清哪个是新的 ——
 * 而这正是会出现「我明明装了新版怎么还是老样子」的原因。
 *
 * ## 为什么每次都要 bump
 *
 * 安卓靠 versionCode（整数）判断新旧，**不递增就会被当成降级、拒装**。
 * 而且文件名也得跟着变，否则和上一条的诉求冲突。
 *
 * ## 为什么要自己找 gradle / SDK
 *
 * 这台机器上 $HOME 不可写（见 docs/安卓构建环境.md），工具链都在工作区里，
 * 所以这里自己拼环境变量，不依赖外部先 source 过什么。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bumpPatch, readVersion, stamp, toVersionCode } from './version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = join(ROOT, 'android');
const APK_OUT = join(ANDROID, 'app/build/outputs/apk/debug/app-debug.apk');
const HANDOFF = join(ROOT, '.artifacts/apk');

const SDK = join(ROOT, '.android-sdk');
const GRADLE_HOME = join(ROOT, '.gradle-home');
const FAKE_HOME = join(ROOT, '.home');

/** 这台机器上工具链的实际位置（工具不在仓库里，所以不在就直说） */
function findJavaHome() {
  const configured = process.env.JAVA_HOME;
  if (configured !== undefined && existsSync(join(configured, 'bin/java'))) return configured;

  // nix 的 openjdk 落在 /nix/store 里，路径每次可能不同，扫一下
  const store = '/nix/store';
  if (existsSync(store)) {
    const hit = readdirSync(store).find((n) => /-openjdk-21/.test(n) && existsSync(join(store, n, 'lib/openjdk/bin/java')));
    if (hit !== undefined) return join(store, hit, 'lib/openjdk');
  }
  return null;
}

function findGradle() {
  // 优先用自己下的那份（官方 wrapper 在这台机器上会超时，见 docs/安卓构建环境.md）
  if (existsSync(GRADLE_HOME)) {
    const dist = readdirSync(GRADLE_HOME).find((n) => n.startsWith('gradle-') && !n.endsWith('.zip'));
    if (dist !== undefined) {
      const bin = join(GRADLE_HOME, dist, 'bin/gradle');
      if (existsSync(bin)) return { bin, via: `自带的 ${dist}` };
    }
  }
  // 退而求其次：系统的 gradle（别的机器上可能是这么装的）
  return { bin: 'gradle', via: 'PATH 里的 gradle' };
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function apkName(version) {
  return `whiteboard-${version}-debug.apk`;
}

/**
 * 清理：`.artifacts/apk/` 里只留最新那一个。
 *
 * 清理范围**严格限制在这个目录**，而且只删我们自己命名格式的文件 ——
 * 万一有人往里放了别的东西，不能顺手删掉。
 */
function cleanOld(current) {
  if (!existsSync(HANDOFF)) return [];
  const removed = [];
  for (const name of readdirSync(HANDOFF)) {
    if (!/^whiteboard-.*\.apk$/.test(name)) continue;
    if (name === current) continue;
    rmSync(join(HANDOFF, name));
    removed.push(name);
  }
  return removed;
}

function main() {
  // ── ① 版本 +1（三个文件一起刷，只留一个来源）──
  const version = bumpPatch(readVersion());
  stamp(version);
  console.log(`\n▸ 版本 ${version}（versionCode ${toVersionCode(version)}）\n`);

  // ── 环境 ──
  const javaHome = findJavaHome();
  if (javaHome === null) {
    console.error('找不到 JDK 21。装好之后重试（见 docs/安卓构建环境.md）。');
    process.exit(1);
  }
  if (!existsSync(SDK)) {
    console.error(`找不到 Android SDK：${SDK}\n见 docs/安卓构建环境.md。`);
    process.exit(1);
  }

  const env = {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: SDK,
    ANDROID_SDK_ROOT: SDK,
    GRADLE_USER_HOME: GRADLE_HOME,
    // 这台机器的 $HOME 不可写，而 gradle/AGP 都想往里写东西
    HOME: FAKE_HOME,
    XDG_CACHE_HOME: join(FAKE_HOME, '.cache'),
    XDG_CONFIG_HOME: join(FAKE_HOME, '.config'),
    // 改过 HOME 之后 git 找不到身份配置了，指回去
    GIT_CONFIG_GLOBAL: '/home/arcaneorion/.config/git/config',
    // pnpm 的包仓库。**故意用环境变量而不是仓库里的 .npmrc** ——
    // .npmrc 是项目级配置，会强加给每一个克隆这个公开仓库的人，
    // 而「store 放哪」纯属这台机器的事。
    npm_config_store_dir: join(ROOT, '.store'),
  };

  // ── ② 构建 ──
  // 顺序照着 package.json 里 `pnpm build` 的定义来：
  // prebuild（备好 pdfjs 静态资源）→ 类型检查 → 打包
  console.log('▸ 构建网页产物…');
  run(process.execPath, ['scripts/sync-pdfjs-assets.mjs'], { env });
  // 类型检查必须在 vite 之前：vite 只转译不检查，类型错了要到运行时才炸
  run(join(ROOT, 'node_modules/.bin/tsc'), ['--noEmit'], { env });
  run(join(ROOT, 'node_modules/.bin/vite'), ['build'], { env });

  console.log('▸ 同步进安卓工程…');
  // 直接用 node_modules 里的二进制，不走 npx —— npx 在包缺失时会去联网解析，
  // 而这里我们要的是「装好了就用装好的、没装就立刻报错」
  run(join(ROOT, 'node_modules/.bin/cap'), ['sync', 'android'], { env });

  const gradle = findGradle();
  console.log(`▸ 打 APK…（${gradle.via}）`);
  run(gradle.bin, ['assembleDebug', '--console=plain'], { cwd: ANDROID, env });

  if (!existsSync(APK_OUT)) {
    console.error(`构建结束了，但没找到 APK：${APK_OUT}`);
    process.exit(1);
  }

  // ── ③ 带版本号复制出来 ──
  mkdirSync(HANDOFF, { recursive: true });
  const name = apkName(version);
  const target = join(HANDOFF, name);
  copyFileSync(APK_OUT, target);

  // ── ④ 清旧的 ──
  const removed = cleanOld(name);

  const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ ${join('.artifacts/apk', name)}  (${mb} MB)`);
  for (const old of removed) console.log(`   🗑 清掉旧版本 ${old}`);
  console.log(`\n装到手机：\n  adb install -r ${join('.artifacts/apk', name)}\n`);
}

main();
