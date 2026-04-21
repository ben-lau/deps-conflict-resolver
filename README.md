# deps-conflict-resolver

一个支持 Webpack 和 Vite 的插件，自动解析 peer 依赖冲突，通过创建别名来支持不同版本的依赖共存。

## 功能特性

- 🔍 **递归依赖分析**：深度分析依赖树中的所有子依赖、孙依赖
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

| 选项                | 类型                                  | 默认值          | 说明                                                                     |
| ------------------- | ------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `dependencies`      | `string[]`                            | -               | **必填**，需要分析的依赖包名列表                                         |
| `projectRoot`       | `string`                              | `process.cwd()` | 项目根目录路径                                                           |
| `autoInstall`       | `boolean`                             | `true`          | 是否自动安装缺失的别名依赖                                               |
| `packageManager`    | `'auto' \| 'npm' \| 'yarn' \| 'pnpm'` | `'auto'`        | 包管理器类型，`'auto'` 自动检测                                          |
| `registry`          | `string`                              | 自动检测        | NPM 注册表地址，不指定则自动从 .npmrc 读取                               |
| `debug`             | `boolean`                             | `false`         | 是否启用调试日志                                                         |
| `aliasPrefix`       | `string`                              | `'aliased-'`    | 别名前缀                                                                 |
| `excludeRedirects`  | `Record<string, string[]>`            | `{}`            | 从重定向列表中排除特定包。键为原始包名，值为要排除的 importer 包名列表。示例：`{ vue: ['vue-demi', 'pinia'] }` |
| `includeRedirects`  | `Record<string, string[]>`            | `{}`            | 强制将指定包加入重定向列表，优先于 `excludeRedirects` 执行。适用于 semver 范围写得过宽（如 `>=2.5.0`）但运行时仍依赖旧版本的包。示例：`{ vue: ['@rili/ui', '@kmt/meeting-setting'] }` |

### Vite 插件专属选项

| 选项            | 类型      | 默认值  | 说明                       |
| --------------- | --------- | ------- | -------------------------- |
| `enableInDev`   | `boolean` | `true`  | 是否在开发模式（dev）下启用 |
| `enableInBuild` | `boolean` | `true`  | 是否在构建模式（build）下启用 |

### 自动检测

插件支持自动检测包管理器和 registry：

**包管理器检测优先级：**

1. `package.json` 中的 `packageManager` 字段（如 `"pnpm@8.0.0"`）
2. lock 文件存在性（`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm）
3. 默认使用 npm

**Registry 检测优先级：**

1. 项目级 `.npmrc` 文件
2. 用户级 `~/.npmrc` 文件
3. yarn 项目的 `.yarnrc.yml` 文件
4. 默认使用 `https://registry.npmjs.org`

## 工作原理

### 1. 依赖分析

插件会递归分析指定依赖的整个依赖树：

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

从 npm 注册表获取可用版本列表，找到满足所有 peer 依赖范围的最佳版本：

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

- **冲突检测范围**：只检测用户指定的 `dependencies` 的第一层 `peerDependencies` 与主工程的版本冲突。子依赖的 `peerDependencies` 不触发别名安装。
- **重定向范围**：声明冲突 peer 的包及其所有子依赖（`dependencies` + `peerDependencies` 递归）都会被收入重定向候选列表。冲突包自身（如 `vue`、`vue-router`）在收集时会被自动排除，避免主工程的同名引用被错误重定向。
- **`excludeRedirects`**：从重定向候选列表中剔除指定包，适用于运行时实际使用宿主 Vue 3 版本的共享包（如 `vue-demi`、`pinia`）。
- **`includeRedirects`**：将指定包强制加入重定向列表，适用于 semver 范围写得过宽（如 `vue: ">=2.5.0"` 同时满足 Vue 2/3），但运行时仍需要使用旧版本的包。`includeRedirects` 在 `excludeRedirects` 之前应用。
- **别名安装**：只为"主工程已声明且版本冲突"的依赖自动安装别名。未声明的 peer 依赖只会输出警告，不自动安装。
- **依赖图去重**：依赖树遍历按包名去重（同名包只分析一次）。在极少数情况下，如同一包名存在多个不同版本的嵌套安装，只有第一个被解析到的版本会被分析。这对重定向结果的影响极小，因为重定向判断只基于包名匹配，不涉及版本。

## 高级用法

### 钩子函数

```typescript
depsConflictResolverVitePlugin({
  dependencies: ['legacy-lib'],
  hooks: {
    // 分析完成后
    onAnalysisComplete: result => {
      console.log('Found conflicts:', result.peerConflicts);
    },

    // 安装完成后
    onInstallComplete: installed => {
      console.log('Installed aliases:', installed);
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

如果项目中已经安装了合适版本的别名（如 `vue2@npm:vue@2.6.14`），插件会自动检测并复用，不会重复安装。

## API 参考

### `createResolver(options): Promise<DepsConflictResolver>`

创建并初始化依赖解析器。

### `DepsConflictResolver`

主解析器类：

- `initialize(): Promise<void>` - 初始化解析器
- `resolveModule(request, importer): string | null` - 解析模块
- `getAnalysisResult(): AnalysisResult` - 获取分析结果
- `getAliasPathMappings(): AliasPathMapping[]` - 获取通用的别名路径映射

> 核心模块返回通用的 `AliasPathMapping[]` 格式，由各构建工具插件（Webpack/Vite）自行转换为各自需要的别名配置格式。

### 工具函数

为减少对外 API 面并提升 treeshake 效果，本包不再从主入口导出内部工具函数（如 semver/fs/npm registry 等）。如需版本判断等能力，请直接使用 `semver`。

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 运行测试
npm test

# 类型检查
npm run typecheck
```

## 许可证

MIT
