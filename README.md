# deps-conflict-resolver

[![npm version](https://img.shields.io/npm/v/deps-conflict-resolver.svg)](https://www.npmjs.com/package/deps-conflict-resolver)
[![CI](https://github.com/ben-lau/deps-conflict-resolver/actions/workflows/ci.yml/badge.svg)](https://github.com/ben-lau/deps-conflict-resolver/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/ben-lau/deps-conflict-resolver/branch/main/graph/badge.svg)](https://codecov.io/gh/ben-lau/deps-conflict-resolver)

> [English Documentation](./README.en.md)

一个支持 Webpack 和 Vite 的插件，自动解析 peer 依赖冲突，通过创建别名来支持不同版本的依赖共存。

## 功能特性

- 🔍 **递归依赖分析**：深度遍历依赖树中的所有子依赖、孙依赖，并按实际安装路径区分嵌套实例
- 🎯 **智能冲突检测**：自动识别 peer 依赖与主工程的版本冲突
- 📦 **自动别名安装**：为冲突的依赖创建别名并自动安装合适的版本
- 🔄 **模块解析重定向**：在运行时自动将模块引用重定向到正确的别名版本
- 🌐 **远程版本查询**：从 npm 注册表获取版本列表，智能选择最佳版本
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

| 选项               | 类型                                  | 默认值                            | 说明                                                                                                                                                                                  |
| ------------------ | ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependencies`     | `string[]`                            | -                                 | **必填**，需要分析的依赖包名列表                                                                                                                                                      |
| `projectRoot`      | `string`                              | Vite root / Webpack context / cwd | 项目根目录路径                                                                                                                                                                        |
| `autoInstall`      | `boolean`                             | `true`                            | 是否自动安装缺失的别名依赖                                                                                                                                                            |
| `packageManager`   | `'auto' \| 'npm' \| 'yarn' \| 'pnpm'` | `'auto'`                          | 包管理器类型，`'auto'` 自动检测                                                                                                                                                       |
| `registry`         | `string`                              | 自动检测                          | NPM 注册表地址；显式指定时同时用于版本查询和别名安装                                                                                                                                  |
| `debug`            | `boolean`                             | `false`                           | 是否启用调试日志                                                                                                                                                                      |
| `offline`          | `boolean`                             | `false`                           | 仅复用已验证的本地 alias；禁止网络查询及安装                                                                                                                                          |
| `strict`           | `boolean`                             | `false`                           | 未解决的必要依赖、安装失败或实际解析歧义会报错                                                                                                                                        |
| `aliasPrefix`      | `string`                              | `'aliased-'`                      | 别名前缀                                                                                                                                                                              |
| `excludeRedirects` | `Record<string, string[]>`            | `{}`                              | 从重定向列表中排除特定包。键为原始包名，值为要排除的 importer 包名列表。示例：`{ vue: ['vue-demi', 'pinia'] }`                                                                        |
| `includeRedirects` | `Record<string, string[]>`            | `{}`                              | 强制将指定包加入重定向列表，优先于 `excludeRedirects` 执行。适用于 semver 范围写得过宽（如 `>=2.5.0`）但运行时仍依赖旧版本的包。示例：`{ vue: ['@rili/ui', '@kmt/meeting-setting'] }` |

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

1. 项目级 `.npmrc` 文件
2. 用户级 `~/.npmrc` 文件
3. pnpm 的用户级 `.pnpmrc` 或 yarn 项目的 `.yarnrc.yml` 文件
4. 默认使用 `https://registry.npmjs.org`

显式设置 `registry` 时会覆盖上述自动检测结果：解析器从该地址查询可用版本，包管理器安装别名时也使用同一地址。

## 诊断、准备与离线构建

可以先查看问题，再显式准备 alias，最后让 CI 使用已安装的版本：

```bash
pnpm exec deps-conflict-resolver doctor legacy-lib --json
pnpm exec deps-conflict-resolver prepare legacy-lib
pnpm exec deps-conflict-resolver doctor legacy-lib --offline --strict --json
```

doctor 不执行安装；没有提供包名时检查当前工程的 dependencies 和已安装的 optionalDependencies，跳过 npm alias 声明。因平台差异未安装的可选包不会报缺失；显式指定的包仍会检查是否存在。prepare 必须显式提供包名，会通过工程的包管理器更新依赖清单和锁文件。--json 输出版本为 1 的报告，包含候选 alias、有效 alias、诊断和安装结果。

建议把 prepare 产生的清单及锁文件提交到版本控制，CI 先执行包管理器的冻结安装，再使用以下配置：

```typescript
depsConflictResolverVitePlugin({
  dependencies: ['legacy-lib'],
  offline: true,
  strict: true,
  ssr: 'auto',
});
```

offline=true 禁止 registry 查询及包管理器安装，即使同时设置 autoInstall=true 也不会安装。缺少已验证 alias 时会产生 OFFLINE_ALIAS_MISSING；strict=true 会使未解决的必要依赖、安装失败或实际请求中的上下文歧义报错。默认仍保留自动安装和宽松处理方式。autoInstall=false 只关闭安装，本身不会禁止版本查询。

Vite 的 ssr='auto' 会把受影响的包和有效 alias 加入 ssr.noExternal，开发时也将它们加入 SSR 预构建并使用相同的 alias 解析规则，使 CommonJS 的 require 和 ESM 的 import 都能重定向。默认 ssr='manual'，由使用者配置。已有 noExternal=true 和 SSR 预构建配置会合并保留。显式 ssr.external 仍遵循 Vite 自身的优先级；需要自动重定向时，应避免同时外置这些包或禁用 SSR 预构建。

开发预构建只将有效 alias、直接消费方和 includeRedirects 作为入口，再跟随实际的 import / require，不会提前加载整个依赖清单。显式 ssr.external 和 SSR optimizeDeps.exclude（包括 environments.ssr 的配置）优先于自动生成的配置；外置的依赖也会传给 SSR 优化器。显式排除需要重定向的消费方时，需要手动配置其解析方式。

ssr.external=true（Vite 5+）也作用于预构建入口内部的依赖；noExternal 中包名或正则匹配的依赖继续内联。外置入口从原消费方解析，保留嵌套版本及 import/require 条件导出，避免优化器缓存目录改变其解析结果。 外置模块通过 Node 原生加载，保留其 namespace 身份、模块缓存及 live bindings，不依赖默认导出探测。

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

同一实际安装工程或共享 workspace 的准备会串行执行，等待者重新读取输入后规划名称；同一系统用户的进程通过共享 OS 临时目录中的本地锁协调，参与进程需使用相同临时目录。新生成的 alias 精确保存版本，已有有效 alias 继续复用。包管理器结束后会重建消费方范围、peer 关联和 watch 输入，并重新验证所有 alias；必要时最多进行一次修正安装，输入持续变化则报告 PROJECT_STATE_CHANGED。

已初始化实例若因另一轮准备而改变实际规则或 provider，会明确失效；strict 模式拒绝继续解析，应调用 invalidate() 后重新 initialize()，或重启对应构建。并发初始化会等待工程准备队列完成。用户钩子在准备锁外执行，内部重新规划不会重复触发分析通知；onAnalysisComplete 观察的是候选分析，最终结果在 initialize() 完成后通过 getAnalysisResult() 查询。

Vite 的隐式 projectRoot 使用最终配置的 root，支持其他 config 钩子调整目录；显式 projectRoot 优先。准备锁协调本库的准备过程；正在构建时应避免其他进程或包管理器改写安装树。并行 CI 建议先 prepare、冻结安装，再使用 offline + strict 构建。

运行 `pnpm bench:scale` 可检查重复版本范围、多 importer、多请求包名以及 5,000 项缓存容量边界的耗时、realpath 次数和堆变化。解析缓存保持有界；零 realpath 热路径适用于工作集能驻留缓存的情况，不代表任意工程规模都无需文件系统查询。

### 兼容性与验证

- Vite 4–7 使用 esbuild 预构建适配，Vite 8 使用原生 Rolldown 适配。兼容脚本验证真实 Vue 2 / Vue 3 在客户端冷启动预构建、SSR 构建和 SSR 开发模式（ESM / CommonJS）中的版本及实例身份，CI 覆盖 Vite 4.0.0、5、6、7、8。
- Vite 4.0 的原生 SSR 预构建在混用 Vue 2 的 ESM / CommonJS 入口时会产生独立实例，插件也受此限制；此场景建议使用 Vite 5 或更新版本。包的条件导出由 Vite 解析，插件不强制合并本来就不同的导出入口。
- Webpack 5 继续使用 beforeResolve；默认初始化失败会记录错误并继续编译，strict=true 时错误会交给编译器。
- 已安装的 optionalDependencies 会参与运行时依赖图。optional peer 的既有忽略策略保持不变。
- workspace 根目录通过 dependencies、devDependencies 或 optionalDependencies 声明的 alias 均可离线复用，前提是从宿主实际可见的安装包名正确、版本满足目标 peer。本地同名目录遮蔽根 alias 时，按本地实际身份与版本判断，不直接复用被遮蔽的根安装。
- workspace 的真实路径与 node_modules 链接均参与匹配。相同物理 importer 匹配多个不同 alias 时报告 AMBIGUOUS_IMPORTER，不按名称随意选择；strict=true 时中止该请求。
- 同一个 alias 被多个消费方共享时，会检查各方的有效 peer provider，包含使用宿主版本的消费方及 include/exclude 覆盖。provider 不一致会报告 AMBIGUOUS_IMPORTER，strict=true 时拒绝初始化；不声明该 peer 的消费方不会被误判为冲突。
- 普通共享包若声明了相关 peer，且配置入口为同一物理实例带来不同的有效 provider，会产生 SHARED_PEER_CONTEXT 告警。它只检查已配置入口可达的安装图，尊重显式 include/exclude；不扫描图外消费者，也不自动复制包。宽泛的 peer 范围不能证明业务一定出错，因此该告警不会使 strict=true 初始化失败；需要跨运行时共享的包应明确配置解析范围，或隔离安装实例。
- linked/workspace 包的重定向请求从宿主工程解析，根请求与子路径均保留打包器的 exports 和 import/require 条件。Webpack watch 会监听分析涉及的包清单，重定向改变时重新解析相关模块，并保留无关模块缓存。
- 当前未提供 Yarn PnP 的完整适配，也未实现私有 registry 的 scope 路由与认证配置继承。
- 多版本运行时共存仍需要合适的挂载/更新/卸载桥接；本插件不承担 SFC 编译器转换、跨版本组件协议或 CSS 隔离。

## 工作原理

### 1. 依赖分析

插件会递归构建指定依赖的运行时关系图，用于确定重定向范围。新 alias 只由指定依赖自身的第一层 peer 冲突触发；如果 peer 仅声明在子依赖中，需要显式选择相应包作为分析入口，并确保该包可从 projectRoot 解析：

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

- **冲突检测范围**：只检测用户指定的 `dependencies` 的第一层 `peerDependencies` 与主工程的版本冲突。子依赖的 `peerDependencies` 会参与依赖图构建和运行时重定向判断，但不会单独触发别名安装。标记为 `optional: true` 的第一层 peer 会完全跳过，不产生冲突、missing 警告或 alias。
- **重定向范围**：冲突 peer 的声明包及其 `dependencies`/`peerDependencies` 会递归加入重定向候选列表；冲突目标包自身（如 `vue`、`vue-router`）会被排除，避免主工程引用被误重定向。
- **嵌套版本**：依赖图以规范化的实际安装目录为节点，并从所属包目录解析子依赖。同名但不同版本的嵌套实例会保留为不同节点，生成的重定向规则优先按 importer 路径匹配；因此 `excludeRedirects` 也会作用于具体实例及其子树，而不是简单按包名全局去重。
- **`excludeRedirects`**：从重定向候选列表中剔除指定包，适用于运行时实际使用宿主 Vue 3 版本的共享包（如 `vue-demi`、`pinia`）。
- **`includeRedirects`**：将指定包强制加入重定向列表，适用于 semver 范围写得过宽（如 `vue: ">=2.5.0"` 同时满足 Vue 2/3），但运行时仍需要使用旧版本的包。`includeRedirects` 在 `excludeRedirects` 之前应用。
- **别名安装与复用**：只为“主工程已声明且版本冲突”的依赖自动安装别名；未声明的 peer 依赖只输出警告，不自动安装。已安装且身份/版本匹配的 local 或 workspace alias 会复用（无需 registry 和安装）；声明但尚未安装的 workspace alias 不算可复用。已有目录身份或版本不匹配时会报告 alias collision，并保持原目录不变，不原地覆盖。
- **Registry**：`registry` 显式配置同时约束远程版本查询和包管理器安装；未配置时才按项目/用户配置自动检测。
- **初始化失败策略**：核心 `createResolver()` 与 Vite 插件会把初始化错误交给调用方；Webpack 插件保持 fail-open，初始化或模块解析失败只记录错误并继续编译（该轮不会应用 alias）。Webpack watch 每次 `watchRun` 会先失效旧 generation，再等待新分析；新一轮失败时仍可在后续 watch 周期重试。

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
      // 返回新的模块名或 null 跳过
      if (source === 'special-module') {
        return 'custom-alias';
      }
      return null;
    },
  },
});
```

`onInstallComplete` 在安装尝试结束后触发，参数只包含确认成功安装或复用的映射；完整安装结果通过 `getInstallResult()` 获取，未解决条件通过 `getDiagnostics()` 获取。

### 精细控制重定向范围（includeRedirects + excludeRedirects）

当项目同时包含 Vue 2 依赖和 Vue 3 依赖时，自动检测可能无法准确区分。可以用这两个选项手动调节：

```typescript
new DepsConflictResolverWebpackPlugin({
  dependencies: ['@uikit/vue-finder', '@rili/ui'],

  // 强制将这些包（semver 范围过宽，但实际需要 Vue 2）加入重定向列表
  includeRedirects: {
    vue: ['@rili/ui', '@kmt/meeting-setting'],
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

1. 遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范提交代码到 `main` 分支
2. release-please 自动创建/更新 Release PR，包含版本号和 CHANGELOG
3. 审核并合并 Release PR
4. 自动创建 GitHub Release + tag
5. 自动通过 OIDC 发布到 npm

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

MIT
