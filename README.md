# deps-conflict-resolver

[![npm version](https://img.shields.io/npm/v/deps-conflict-resolver.svg)](https://www.npmjs.com/package/deps-conflict-resolver)
[![CI](https://github.com/ben-lau/deps-conflict-resolver/actions/workflows/ci.yml/badge.svg)](https://github.com/ben-lau/deps-conflict-resolver/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/ben-lau/deps-conflict-resolver/branch/main/graph/badge.svg)](https://codecov.io/gh/ben-lau/deps-conflict-resolver)

> [English Documentation](./README.en.md)

一个支持 Webpack 和 Vite 的插件，自动解析 peer 依赖冲突，通过创建别名来支持不同版本的依赖共存。

## 功能特性

- 🔍 **递归依赖分析**：深度遍历依赖树中的所有子依赖、孙依赖，并按实际安装路径区分嵌套实例
- 🎯 **Peer 冲突检测**：检查入口及其实际使用的 peer 版本，识别需要隔离的依赖
- 📦 **自动别名安装**：为冲突的依赖创建别名并自动安装合适的版本
- 🔄 **模块解析重定向**：在运行时自动将模块引用重定向到正确的别名版本
- 🌐 **远程版本查询**：从 npm registry 获取版本与 peer 元数据，选择兼容的候选版本
- ⚡ **支持 Webpack 和 Vite**：提供两种构建工具的插件实现

## 使用场景

典型场景：你的 Vue 3 项目需要使用一个仅支持 Vue 2 的第三方库。该库的依赖链中可能包含 Vue 2、vue-router 3 等低版本依赖。本插件可以：

1. 自动检测这些版本冲突
2. 为冲突的依赖（如 vue@2.x）创建别名（如 `aliased-vue2`）
3. 自动安装别名依赖
4. 在模块解析时自动重定向：第三方库中的 `import Vue from 'vue'` 会被解析到 `vue@2.x`，而你的主工程代码中的 `import Vue from 'vue'` 仍然解析到 `vue@3.x`

## 安装

```bash
npm install deps-conflict-resolver --save-dev
# 或
yarn add deps-conflict-resolver -D
# 或
pnpm add deps-conflict-resolver -D
```

## 使用方法

### Vite

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { depsConflictResolverVitePlugin } from 'deps-conflict-resolver/vite';

export default defineConfig({
  plugins: [
    depsConflictResolverVitePlugin({
      // 需要分析的依赖包
      dependencies: ['legacy-vue2-library'],

      // 可选配置
      autoInstall: true, // 自动安装缺失的别名依赖
      packageManager: 'npm', // npm | yarn | pnpm
      debug: false, // 开启调试日志
    }),
  ],
});
```

Worker 构建需要处理相同冲突时，在 `worker.plugins` 中创建独立实例。以下为 Vite 5+ 配置；Vite 4 使用 `worker.plugins: [conflictResolver()]`：

```typescript
const conflictResolver = () =>
  depsConflictResolverVitePlugin({
    dependencies: ['legacy-vue2-library'],
    offline: true,
    strict: true,
  });

export default defineConfig({
  plugins: [conflictResolver()],
  worker: { plugins: () => [conflictResolver()] },
});
```

### Webpack

```typescript
// webpack.config.js
const { DepsConflictResolverWebpackPlugin } = require('deps-conflict-resolver/webpack');

module.exports = {
  plugins: [
    new DepsConflictResolverWebpackPlugin({
      dependencies: ['legacy-vue2-library'],
      autoInstall: true,
      packageManager: 'npm',
    }),
  ],
};
```

### 编程式使用

```typescript
import { createResolver } from 'deps-conflict-resolver';

const resolver = await createResolver({
  dependencies: ['legacy-vue2-library'],
  projectRoot: process.cwd(),
  autoInstall: true,
});

// 获取分析结果
const result = resolver.getAnalysisResult();
console.log('Peer conflicts:', result.peerConflicts);
console.log('Alias mappings:', result.aliasMappings);

// 手动解析模块
const resolved = resolver.resolveModule('vue', '/path/to/importer.js');
```

## 配置选项

| 选项               | 类型                                     | 默认值                            | 说明                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependencies`     | `string[]`                               | -                                 | 需要分析的依赖包名，构建插件和 `createResolver` 必填。CLI 的入口选择规则见下方「诊断、准备与离线构建」。                                                                                                                                                                                             |
| `projectRoot`      | `string`                                 | Vite root / Webpack context / cwd | 项目根目录路径                                                                                                                                                                                                                                                                                       |
| `autoInstall`      | `boolean`                                | `true`                            | 是否自动安装缺失的别名依赖                                                                                                                                                                                                                                                                           |
| `packageManager`   | `'auto' \| 'npm' \| 'yarn' \| 'pnpm'`    | `'auto'`                          | 包管理器类型，`'auto'` 自动检测                                                                                                                                                                                                                                                                      |
| `registry`         | `string`                                 | 自动检测                          | NPM 注册表地址；显式指定时同时用于版本查询和别名安装                                                                                                                                                                                                                                                 |
| `debug`            | `boolean`                                | `false`                           | 是否启用调试日志                                                                                                                                                                                                                                                                                     |
| `offline`          | `boolean`                                | `false`                           | 仅复用已验证的本地 alias；禁止网络查询及安装                                                                                                                                                                                                                                                         |
| `strict`           | `boolean`                                | `false`                           | 未解决的必要依赖、安装失败或实际解析歧义会报错                                                                                                                                                                                                                                                       |
| `aliasPrefix`      | `string`                                 | `'aliased-'`                      | 别名前缀                                                                                                                                                                                                                                                                                             |
| `excludeRedirects` | `Record<string, string[]>`               | `{}`                              | 从重定向列表中排除特定包。键为原始包名，值为要排除的 importer 包名列表。示例：`{ vue: ['vue-demi', 'pinia'] }`                                                                                                                                                                                       |
| `includeRedirects` | `Record<string, string[]>`               | `{}`                              | 强制将指定包加入重定向列表。与 `excludeRedirects` 同时匹配时以排除为准。仅作用于指定包名本身，不触发新冲突或遍历子树。示例：`{ vue: ['legacy-helper'] }`                                                                                                                                             |
| `peerOverrides`    | `Record<string, Record<string, string>>` | `{}`                              | 覆写指定依赖包声明的 `peerDependencies` 范围，键支持 `<包名>` 或 `<包名>@<semver范围>`（含 prerelease 匹配，优先级：纯包名 < 版本范围 < 精确版本）。适用于上游包 peer 范围写得过宽（如 `>=2.5.0`）或缺失、或同包多版本共存时精准接管目标版本子树。示例：`{ '@rili/ui@1.x': { vue: '>=2.5.17 <3' } }` |

### Vite 插件专属选项

| 选项            | 类型                 | 默认值     | 说明                           |
| --------------- | -------------------- | ---------- | ------------------------------ |
| `enableInDev`   | `boolean`            | `true`     | 是否在开发模式（dev）下启用    |
| `enableInBuild` | `boolean`            | `true`     | 是否在构建模式（build）下启用  |
| `ssr`           | `'manual' \| 'auto'` | `'manual'` | auto 将受影响依赖纳入 SSR 构建 |

### 自动检测

插件支持自动检测包管理器和 registry：

**包管理器检测优先级：**

1. `package.json` 中的 `packageManager` 字段（如 `"pnpm@8.0.0"`）
2. lock 文件存在性（`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm）
3. 默认使用 npm

**Registry 检测优先级：**

1. `npm_config_registry`、`NPM_CONFIG_REGISTRY` 环境变量（Yarn 优先读取 `YARN_NPM_REGISTRY_SERVER`）
2. 项目配置（Yarn 优先读取 `.yarnrc.yml`，其次读取 `.npmrc`）
3. 用户级 `.npmrc` 和 pnpm 的 `.pnpmrc`
4. 默认使用 `https://registry.npmjs.org`

版本查询使用自动检测的结果，别名安装继承包管理器自己的配置。显式设置 `registry` 时，版本查询和别名安装优先使用该设置。使用现代 Yarn 时，如目标 scope 的 `npmRegistryServer` 与显式地址冲突，安装前需先将两者对齐。Yarn Classic 无法通过环境变量覆盖含下划线或点号的 scope 键，遇到冲突时请在 `.npmrc` 中对齐该 scope 的源地址。

## 诊断、准备与离线构建

可以直接给 CLI 传包名。需要与构建插件共享 `peerOverrides`、别名前缀或重定向范围时，把选项提取到项目自己的模块中。以下示例使用 `tools/legacy-deps.cjs`。

```js
// tools/legacy-deps.cjs
module.exports = {
  dependencies: ['legacy-lib'],
  peerOverrides: { 'legacy-lib': { vue: '^2' } },
};
```

CLI 通过 `--config` 显式加载该对象，支持 JSON、ESM 的 `export default` 和 CommonJS 的 `module.exports`。模块中值为 `undefined` 的选项按省略处理，包名和命令行参数优先于文件中的对应选项。`--config`、`--root` 和选项中的相对 `projectRoot` 都以启动 CLI 的工作目录为基准。要以模块位置为基准，可在模块中用 `require('node:path').resolve(__dirname, '..')` 生成绝对路径。

```bash
pnpm exec deps-conflict-resolver doctor --config ./tools/legacy-deps.cjs --json
pnpm exec deps-conflict-resolver prepare --config ./tools/legacy-deps.cjs --strict
pnpm exec deps-conflict-resolver doctor --config ./tools/legacy-deps.cjs --offline --strict --json
```

`doctor` 只分析依赖。命令行和选项文件都省略入口包名时，扫描工程的 `dependencies` 和已安装的 `optionalDependencies`，跳过 npm alias 声明。`prepare` 需要通过其中一处指定入口包，在在线模式下由包管理器更新清单和锁文件。`prepare --strict` 遇到安装前已知的错误时会停止。`--json` 输出版本为 1 的报告，包含候选 alias、有效 alias、诊断和安装结果。

提交 `prepare` 生成的清单和锁文件。CI 先执行包管理器的冻结安装。如果用 npm 准备了 alias，冻结安装需要沿用 `--legacy-peer-deps`。然后开启离线严格构建。[npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci/#description)

Vite 和 Webpack 在自己的配置中导入同一个对象，再按构建需要加上选项。

```js
// vite.config.mjs
import { depsConflictResolverVitePlugin } from 'deps-conflict-resolver/vite';
import legacyDeps from './tools/legacy-deps.cjs';

export default {
  plugins: [
    depsConflictResolverVitePlugin({ ...legacyDeps, offline: true, strict: true, ssr: 'auto' }),
  ],
};
```

```js
// webpack.config.cjs
const { DepsConflictResolverWebpackPlugin } = require('deps-conflict-resolver/webpack');
const legacyDeps = require('./tools/legacy-deps.cjs');

module.exports = {
  plugins: [new DepsConflictResolverWebpackPlugin({ ...legacyDeps, offline: true, strict: true })],
};
```

offline=true 禁止 registry 查询及包管理器安装，即使同时设置 autoInstall=true 也不会安装。缺少已验证 alias 时会产生 OFFLINE_ALIAS_MISSING；strict=true 会使未解决的必要依赖、安装失败或实际请求中的上下文歧义报错。默认仍保留自动安装和宽松处理方式。autoInstall=false 只关闭安装，本身不会禁止版本查询。

### 生成与复用离线计划

`init` 根据已安装的入口 peer 冲突生成精简配置。默认输出预览，`--write-config` 可以写入一个新 JSON 文件。确认建议的入口后，使用同一份配置完成准备和构建。

```bash
pnpm exec deps-conflict-resolver init --write-config ./legacy-deps.json
pnpm exec deps-conflict-resolver prepare --config ./legacy-deps.json --strict --write-plan
pnpm exec deps-conflict-resolver doctor --config ./legacy-deps.json --offline --strict --json --timings
```

在 Vite、Webpack 或核心选项中设置 `preparedPlan: true, strict: true`。此模式始终离线。构建会校验包清单、锁文件、真实安装路径和此前未命中的查找输入。计划命中会跳过全图分析，计划缺失或失效会触发离线分析。计划记录当前安装的绝对路径，保存在 `node_modules/.cache/deps-conflict-resolver/` 中。依赖变更后可以重新运行 `prepare --write-plan`。已有有效安装时，可用 `prepare --offline --write-plan` 生成计划。

配置 `onAnalysisComplete` 时，每次准备都会重新分析，以便回调观察当次结果。

`doctor --timings`、`prepare --timings` 和核心 `getTimings()` 报告各阶段耗时。分析、依赖图和 Registry 阶段可能重叠。文件探针计数来自分析过程，计划校验和写入耗时另列。`prepare --offline --write-plan` 通常只分析一次，在线安装后的计划仍需离线复查。超出计划大小或输入上限时，可以继续使用普通离线分析。`prepare --json` 的 `planFailure` 字段会报告原因。Vite 的 `debug: true` 也会输出实际执行的预构建耗时与缓存键。

`doctor` 会给出诊断对应的下一步，并报告配置入口和直接依赖可见的版本不兼容的可选 peer。使用 `doctor --source-hints` 可以查看 Vue 2 编译特征提示和待确认的 `peerOverrides` 配置。`init` 也会输出这些提示。如果只有源码线索，`init` 会给出待确认的入口和配置示例，确认后再保存使用。在线元数据查询支持 `.npmrc` 中的 `@scope:registry` 及对应主机和路径下的 `_authToken`，支持环境变量插值。

Vite 的 ssr='auto' 会把受影响的包和有效 alias 加入 ssr.noExternal，开发时也将它们加入 SSR 预构建并使用相同的 alias 解析规则，使 CommonJS 的 require 和 ESM 的 import 都能重定向。默认 ssr='manual'，由使用者配置。已有 noExternal=true 和 SSR 预构建配置会合并保留。显式 ssr.external 仍遵循 Vite 自身的优先级；需要自动重定向时，应避免同时外置这些包或禁用 SSR 预构建。

开发预构建只将有效 alias、直接消费方和 includeRedirects 作为入口，再跟随实际的 import / require，不会提前加载整个依赖清单。显式 ssr.external 和 SSR optimizeDeps.exclude（包括 environments.ssr 的配置）优先于自动生成的配置；外置的依赖也会传给 SSR 优化器。显式排除需要重定向的消费方时，需要手动配置其解析方式。

ssr.external=true（Vite 5+）也作用于预构建入口内部的依赖；noExternal 中包名或正则匹配的依赖继续内联。外置入口从原消费方解析，保留嵌套版本及 import/require 条件导出，避免优化器缓存目录改变其解析结果。 外置模块通过 Node 原生加载，保留其 namespace 身份、模块缓存及 live bindings，不依赖默认导出探测。

Vite 优先对命中规则的 importer 应用重定向，其他请求仍由 Vite 自己解析，包括用户配置的 `resolve.alias`。预构建缓存随生效规则和已安装 provider 的变更失效。开发服务器会监听分析涉及的项目和 linked workspace 清单。

`vite build --watch` 会随依赖输入刷新规则，并在构建时检查已解析的安装位置，包括传递依赖和此前用过的别名。发现软链换了目标时，Vite 4–7 会刷新解析缓存。Vite 8 的原生解析器可能保留旧路径，此时会在写出前提示重启并保留上一份产物。Vite 4–7 若在 Watch 启动后才声明并安装新别名，请重启以监听该位置。普通严格构建在配置解析后发现安装路径变化时也会提示重启。生成的 `ssr: 'auto'` 外置策略变化时需要重启。自定义 `beforeResolve` 的返回值从原 importer 解析，插件生成的别名从宿主工程解析。

入口实际使用的嵌套 peer 与要求不符时，可能报告 `PEER_PROVIDER_MISMATCH`，即使宿主另有一个兼容版本。入口和相关 peer 请求已经共用兼容的本地实例时，可以直接使用原生解析。`TRANSITIVE_PEER_CONFLICT` 提示已配置入口漏写的 peer 在其直接子依赖处存在版本冲突，供补充入口或修正声明。

### 查看某次解析的原因

```typescript
const resolver = await createResolver({
  dependencies: ['legacy-lib'],
  offline: true,
});

console.log(resolver.getDiagnostics());
console.log(resolver.getInstallResult());
console.log(resolver.explainResolution('vue', '/absolute/path/to/legacy-lib/index.js'));
```

explainResolution 返回 resolved、reason、aliases 和 matchedPaths。reason 可以表示已重定向、被排除、没有匹配、未初始化或多版本歧义；它也会说明 beforeResolve 钩子是否接管请求。诊断使用稳定的 code，无需解析日志。严格初始化失败时可以捕获导出的 ResolutionError 并读取 diagnostics。

需要只检查静态重定向规则、避免执行用户回调时，可传入第三个参数 `{ skipHook: true }`。同一实例并发调用 installDependencies() 会共享一次准备；安装未结束时 invalidate() 会抛错，应先等待安装完成。

同一 workspace 中，`offline: true` 或 `autoInstall: false` 的初始化持共享读锁，可以跨进程并行分析和复用已安装的 alias。可能调用包管理器的准备从正式分析开始就持独占锁，直到发布结果。同一次准备及其修正安装会复用自己的 registry 元数据。参与进程应属于同一系统用户并使用同一 OS 临时目录。锁记录按进程退出状态回收。新生成的 alias 精确保存版本。包管理器结束后会重建消费方范围、peer 关联和 watch 输入，并验证所有 alias。必要时最多进行一次修正安装，输入持续变化则报告 PROJECT_STATE_CHANGED。

已初始化实例若因另一轮准备而改变实际规则或 provider，会明确失效；strict 模式拒绝继续解析，应调用 invalidate() 后重新 initialize()，或重启对应构建。并发初始化会等待工程准备队列完成。用户钩子在准备锁外执行，内部重新规划不会重复触发分析通知；onAnalysisComplete 观察的是候选分析，最终结果在 initialize() 完成后通过 getAnalysisResult() 查询。

Vite 的隐式 projectRoot 使用最终配置的 root，支持其他 config 钩子调整目录；显式 projectRoot 优先。准备锁协调本库的准备过程；正在构建时应避免其他进程或包管理器改写安装树。并行 CI 建议先 prepare、冻结安装，再使用 offline + strict 构建。

运行 `pnpm bench:scale` 可测量重复版本范围，以及密集、稀疏和分散导入的冷、热耗时、文件系统调用次数和内存用量。安装目录被多个不同 importer 访问后，已验证的普通文件可共享所属目录的解析决策。文件级链接仍单独解析，带查询参数的请求优先检查完整文件名。目录、文件和决策缓存均有容量上限，在新一代规则发布后重新建立。

### 兼容性与验证

- Vite 4–7 使用 esbuild 预构建适配，Vite 8 使用原生 Rolldown 适配。兼容脚本验证真实 Vue 2 / Vue 3 的客户端冷启动预构建（含全局 `resolve.alias`）、SSR 构建和 SSR 开发模式（ESM / CommonJS）。CI 在 Vite 4.0.0、5、6、7、8 上运行 strict 和默认过滤两种模式。
- Vite 4.0 的原生 SSR 预构建在混用 Vue 2 的 ESM / CommonJS 入口时会产生独立实例，插件也受此限制；此场景建议使用 Vite 5 或更新版本。包的条件导出由 Vite 解析，插件不强制合并本来就不同的导出入口。
- Webpack 5 继续使用 beforeResolve；默认初始化失败会记录错误并继续编译，strict=true 时错误会交给编译器。
- 已安装的 optionalDependencies 会参与运行时依赖图。可选 peer 的版本不兼容只会产生告警。
- workspace 根目录通过 dependencies、devDependencies 或 optionalDependencies 声明的 alias 均可离线复用，前提是从宿主实际可见的安装包名正确、版本满足目标 peer。本地同名目录遮蔽根 alias 时，按本地实际身份与版本判断，不直接复用被遮蔽的根安装。
- workspace 的真实路径与 node_modules 链接均参与匹配。相同物理 importer 匹配多个不同 alias 时报告 AMBIGUOUS_IMPORTER，不按名称随意选择；strict=true 时中止该请求。
- 消费方与 alias 都声明同一个 peer 时，已重定向的 provider 参与选版和最终校验。alias 与实际重定向的 provider 不兼容时报告 `ALIAS_PEER_UNSATISFIED`，严格模式下拒绝初始化。多个消费方需要不同的兼容 provider 时，会报告 `AMBIGUOUS_IMPORTER`。校验按实际导入路径应用 include/exclude 规则。
- 普通共享包若声明了相关 peer，且配置入口为同一物理实例带来不同的有效 provider，会产生 SHARED_PEER_CONTEXT 告警。它检查已配置入口可达的安装图，包括宿主直连依赖与重定向子树共用同一物理实例的情形。显式 include/exclude 仍然生效。宽泛的 peer 范围不能证明业务一定出错，因此该告警不会使 strict=true 初始化失败；需要跨运行时共享的包应明确配置解析范围，或隔离安装实例。
- linked/workspace 包的重定向请求从宿主工程解析，根请求与子路径均保留打包器的 exports 和 import/require 条件。Webpack watch 会监听分析涉及的包清单，重定向改变时重新解析相关模块，并保留无关模块缓存。
- 当前支持标准 node_modules 安装布局。Yarn PnP 仍缺少完整适配。
- 多版本运行时共存仍需要合适的挂载/更新/卸载桥接；本插件不承担 SFC 编译器转换、跨版本组件协议或 CSS 隔离。

## 工作原理

### 1. 依赖分析

插件从 `projectRoot` 解析配置中的包，并沿宿主已安装的 workspace 运行时依赖查找这些包的其他实例。可达的 workspace 包直接声明了某个配置包时，插件从该 workspace 包目录解析它。每份入口实例分别参与 peer 冲突检测，并沿自己的依赖图生成重定向范围。普通传递依赖自身的 peer 冲突不会单独触发 alias 安装。

```
package-a
├── package-b
│   └── package-c (peerDeps: vue@^2.0.0)
└── package-d (peerDeps: vue-router@^3.0.0)
```

### 2. 冲突检测

对比主工程中已安装的版本与 peer 依赖要求：

- 主工程：`vue@3.2.0`, `vue-router@4.1.0`
- Peer 依赖要求：`vue@^2.0.0`, `vue-router@^3.0.0`
- 检测到冲突 ✗

### 3. 版本解析

先检查项目或 workspace 中已经安装、且包名和版本都匹配的 npm alias。可复用的 alias 会直接离线使用，不访问 registry，也不会重复安装；只有未匹配的请求才从 registry 获取版本列表，并找到满足所有 peer 依赖范围的最佳版本：

- `vue@^2.0.0` → 选择 `vue@2.7.14`
- `vue-router@^3.0.0` → 选择 `vue-router@3.6.5`

### 4. 别名安装

创建并安装别名依赖：

```bash
npm install aliased-vue2@npm:vue@2.7.14
npm install aliased-vue-router3@npm:vue-router@3.6.5
```

### 5. 模块解析重定向

在构建时，自动重定向模块引用：

```javascript
// 在 package-c 中
import Vue from 'vue'; // → 解析到 aliased-vue2

// 在主工程中
import Vue from 'vue'; // → 解析到 vue (3.x)
```

### 行为边界

- **冲突检测范围**：只检测用户指定的 `dependencies` 所选入口实例的 `peerDependencies` 与主工程的版本冲突。子依赖的 `peerDependencies` 会参与依赖图构建和运行时重定向判断，但不会单独触发别名安装。标记为 `optional: true` 的入口 peer 会完全跳过，不产生冲突、missing 警告或 alias。
- **重定向范围**：冲突 peer 的声明包及其 `dependencies`/`peerDependencies` 会递归加入重定向候选列表；冲突目标包自身（如 `vue`、`vue-router`），以及明确声明仅兼容宿主版本而不兼容目标别名的子依赖（如 Vue 2 依赖树中触达的 `peerDependencies: { vue: "3.x" }` 包及其专有子树）会自动跳过，避免主工程或宿主生态包被误重定向。
- **嵌套版本**：依赖图以规范化的实际安装目录为节点，并从所属包目录解析子依赖。同名但不同版本的嵌套实例会保留为不同节点，生成的重定向规则优先按 importer 路径匹配；因此 `excludeRedirects` 也会作用于具体实例及其子树，而不是简单按包名全局去重。
- **`excludeRedirects`**：从重定向候选列表中剔除指定包，适用于运行时实际使用宿主 Vue 3 版本的共享包（如 `vue-demi`、`pinia`）。
- **`includeRedirects`**：按包名将指定包强制加入重定向列表。`includeRedirects` 在 `excludeRedirects` 之前应用，不会触发新的别名安装，也不会自动展开子依赖树。
- **`peerOverrides`**：覆写指定依赖包声明的 `peerDependencies` 范围（覆盖同名声明、取消其 `optional` 跳过，或补充缺失声明）。键支持 `<包名>` 或 `<包名>@<semver范围>`（如 `'@rili/ui@1.x'`，版本范围匹配包含 prerelease 标签，避免同包多版本共存时误伤已升级到宿主版本的新主版本；多个选择器命中时按 `纯包名 < 版本范围 < 精确版本` 逐 peer 合并）。被覆写的入口包会正常参与冲突检测、别名复用/安装，并按物理路径自动接管其整棵依赖子树（同时仍自动跳过仅兼容宿主版本的子包）。
- **别名安装与复用**：只为“主工程已声明且版本冲突”的依赖自动安装别名；未声明的 peer 依赖只输出警告，不自动安装。已安装且身份/版本匹配的 local 或 workspace alias 会复用（无需 registry 和安装）；声明但尚未安装的 workspace alias 不算可复用。已有目录身份或版本不匹配时会报告 alias collision，并保持原目录不变，不原地覆盖。
- **Registry**：`registry` 显式配置同时约束远程版本查询和包管理器安装；未配置时才按项目/用户配置自动检测。
- **初始化失败策略**：核心 `createResolver()` 与 Vite 插件会把初始化错误交给调用方。Webpack 默认记录错误并继续编译，开启 `strict` 时把错误交给编译器。Webpack watch 在准备锁内校验依赖输入，已确认的规则可以继续使用，输入变化时会重新分析。初始化失败后可在下次 watch 周期重试。

## 高级用法

### 钩子函数

```typescript
depsConflictResolverVitePlugin({
  dependencies: ['legacy-lib'],
  hooks: {
    // 分析完成后
    onAnalysisComplete: (result) => {
      console.log('Found conflicts:', result.peerConflicts);
    },

    // 安装尝试完成后
    onInstallComplete: (mappings) => {
      console.log('Alias mappings after install attempt:', mappings);
    },

    // 自定义模块解析
    beforeResolve: (source, importer) => {
      // 返回 undefined 时继续执行默认重定向规则
      if (source === 'special-module') {
        return 'custom-alias';
      }
      return undefined;
    },
  },
});
```

`beforeResolve` 返回字符串时使用其指定的请求，返回 `null` 时交回打包器正常解析，返回 `undefined` 时继续应用自动重定向。

Vite 在配置解析完成时确定 `beforeResolve`，包括在 `onAnalysisComplete` 或 `onInstallComplete` 中注册的回调。需要从 `buildStart` 更新行为时，请预先声明 `beforeResolve`，再通过闭包更新它使用的数据。esbuild 和 Rolldown 预构建都会对依赖内部的模块请求应用已配置的回调。要复用预构建缓存，请用 `beforeResolveCacheKey` 标识回调读取的外部状态，例如环境变量或重定向表。回调源码变化会自动使缓存失效。自定义回调没有缓存键时，Vite 会在每次解析配置后重新预构建。

`onInstallComplete` 在安装尝试结束后触发，参数只包含确认成功安装或复用的映射；完整安装结果通过 `getInstallResult()` 获取，未解决条件通过 `getDiagnostics()` 获取。

### 精细控制重定向范围（peerOverrides + includeRedirects + excludeRedirects）

当上游包把 `peerDependencies` 写得过宽（例如 `vue: ">=2.5.17"`，导致宿主 Vue 3 也满足）时，优先使用 `peerOverrides` 修正它的 peer 约束，这样它会自动参与冲突检测并接管整棵物理依赖子树，无需逐个枚举子包：

```typescript
new DepsConflictResolverWebpackPlugin({
  dependencies: ['@uikit/vue-finder', '@rili/ui'],

  // 修正上游包过宽的 peerDependencies 范围，自动接管 @rili/ui@1.x 及其物理依赖子树
  // 支持按 `<包名>` 或 `<包名>@<semver范围>` 精准匹配，避免影响同包已支持 Vue 3 的 2.x 版本
  peerOverrides: {
    '@rili/ui@1.x': { vue: '>=2.5.17 <3' },
  },

  // 必要时仍可按包名强制补充单个包
  includeRedirects: {
    vue: ['legacy-helper'],
  },

  // 从重定向列表中排除这些包（它们在运行时使用宿主提供的 Vue 3）
  excludeRedirects: {
    vue: ['vue-demi', 'pinia', '@ks-email/editor'],
  },

  aliasPrefix: 'never-ever-gonna-import-',
  autoInstall: true,
});
```

规则优先级：`includeRedirects` 先执行，`excludeRedirects` 后执行。若同一个包同时出现在两者中，`excludeRedirects` 优先（最终不重定向）。

### 复用已有别名

如果项目中已经安装了合适版本的别名（如 `vue2@npm:vue@2.6.14`），插件会在访问 registry 前自动检测并复用，不会重复安装；workspace alias 只有在实际安装且包名/版本验证通过时才会复用。若现有目录不匹配，插件会报告冲突并保留原目录。

## API 参考

### `createResolver(options): Promise<DepsConflictResolver>`

创建并初始化依赖解析器。

### `DepsConflictResolver`

主解析器类：

- `initialize(): Promise<void>` - 初始化解析器
- `resolveModule(request, importer): string | null` - 解析模块
- `getAnalysisResult(): AnalysisResult` - 获取分析结果
- `getDiagnostics(): ResolverDiagnostic[]` - 获取结构化诊断
- `getInstallResult(): InstallReport | null` - 获取已验证的安装/复用/失败结果
- `explainResolution(request, importer): ResolutionExplanation` - 解释某次解析选择
- `getAliasPathMappings(): AliasPathMapping[]` - 获取通用的别名路径映射

> 核心模块返回通用的 `AliasPathMapping[]` 格式，由各构建工具插件（Webpack/Vite）自行转换为各自需要的别名配置格式。

### 工具函数

为减少对外 API 面并提升 treeshake 效果，本包不再从主入口导出内部工具函数（如 semver/fs/npm registry 等）。如需版本判断等能力，请直接使用 `semver`。

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建
pnpm build

# 运行测试
pnpm test

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint

# 代码格式化
pnpm fmt
```

## 发布流程

本项目使用 [release-please](https://github.com/googleapis/release-please) 自动化发版：

1. 遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范将代码合并到 `main`
2. 有待发版本时，Release Please 自动创建或更新发布 PR
3. 审核并合并发布 PR，自动创建 GitHub Release 和 tag
4. 从发布提交打包并验收 `.tgz`，通过后将同一个文件通过 OIDC 发布到 npm

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

### 测试预览包

新建或更新 PR，以及 push 到 `main` 时会运行 CI。全部检查通过后，[pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new) 自动发布临时包。普通分支可以开 Draft PR 来触发 CI。PR 评论会显示固定提交的安装命令。待发版的发布 PR 评论还会显示 `@main` 链接。也可以在 CI 运行的摘要或[预览列表](https://pkg.pr.new/~/ben-lau/deps-conflict-resolver)查找安装命令。

```bash
pnpm add -D https://pkg.pr.new/ben-lau/deps-conflict-resolver/deps-conflict-resolver@main
```

`@main` 指向最近一次成功生成的预览。新提交后请先确认对应的预览发布成功。需要准确复现时，请使用固定 SHA 的链接，并在切换预览时更新锁文件。PR CI 检查与目标分支的模拟合并结果，预览包用 PR 源分支的提交构建，使内容与 SHA 链接对应。预览包会过期，测试结束后请恢复正式版本。

使用 npm 12 时，安装此类远程链接需要启用 `--allow-remote=root`；后续重新安装时也需保持相应设置。

## 许可证

MIT
