# deps-conflict-resolver 开发经验总结

本文档总结了 deps-conflict-resolver 在开发过程中遇到的问题和解决方案，供后续维护和类似项目参考。

---

## 依赖分析与冲突检测

### 1. 别名复用只应考虑冲突范围，而非全部范围

**问题**：早期版本在查找可复用的已有别名时，会尝试满足所有 peer 依赖范围（包括已被主工程满足的范围）。例如主工程用 `vue@3.x`，某个库要求 `vue@^2.5.0`，另一个库要求 `vue@^3.0.0`（已被满足）。旧逻辑会把 `['^2.5.0', '^3.0.0']` 全部传入匹配，导致已有的 `aliased-vue2`（版本 2.7.16）无法满足 `^3.0.0`，返回 null，最终重复创建别名。

**方案**：将范围拆分为 `conflictingRanges` 和 `satisfiedRanges`，只用冲突范围去查找已有别名。

**教训**：复用已有资源时，约束条件应只包含真正需要解决的部分，而不是全部需求。

### 2. pnpm hoisting 导致的误判：resolve ≠ 已声明

**问题**：pnpm 的 peer/hoisting 机制会让某些包在 `node_modules` 中可被 resolve 到，但主工程的 `package.json` 中并未声明。旧逻辑只要能在 node_modules 中找到包就认为"主工程已安装"，导致本应报 missing 的 peer 依赖被错误地触发了别名安装。

**方案**：严格区分"可在 node_modules 中找到"和"在主工程 package.json 中声明"，只有后者才触发自动别名安装逻辑。

**教训**：包管理器的行为差异（npm/yarn/pnpm 的 hoisting 策略不同）会直接影响依赖解析结果，不能简单假设 node_modules 可见 = 已声明。

### 3. Monorepo 场景下"已声明"的定义需要合并 workspace 根

**问题**：在 pnpm workspace 中，依赖可以声明在 workspace 根的 `package.json` 中，子包通过 `workspace:` 协议引用。如果只检查子包自身的 `package.json`，会将根中已声明的依赖误判为 missing。

**方案**：检测到 workspace 环境时，将当前包和 workspace 根的 `package.json` 声明合并判断。

**教训**：monorepo 中依赖声明是分层的，任何关于"是否已安装/声明"的判断都需要考虑 workspace 拓扑。

### 4. 版本不匹配时不应覆盖已有别名

**问题**：早期版本在已有别名的版本不满足新需求时，会覆盖安装新版本。这是一个破坏性行为——其他使用者可能依赖旧版本。

**方案**：版本不匹配时返回 null，不修改已有依赖。由用户自行决定如何处理。

**教训**：工具应尽量避免对已有配置的破坏性修改，宁可保守（返回 null / 报错）也不要静默覆盖。

### 5. optional peerDependencies 应排除在 missing 报告之外

**问题**：`peerDependenciesMeta` 中标记为 `optional: true` 的 peer 依赖如果未安装，不应被报告为 missing，也不应触发别名安装。

**方案**：在收集 missing peers 时，检查 `peerDependenciesMeta` 并跳过 optional 的条目。

---

## 性能与稳定性

### 6. 大型依赖树必须用显式栈替代递归

**问题**：某些项目的依赖树极深（如大型 monorepo），递归遍历会直接导致 JavaScript 调用栈溢出。

**方案**：依赖树遍历改用 `while (stack.length > 0)` 迭代方式，彻底消除栈溢出风险。

**教训**：处理用户提供的树形/图结构数据时，默认使用迭代而非递归。

### 7. 缓存 null 结果，避免重复磁盘探测

**问题**：`package.json` 查找和模块路径解析涉及大量磁盘 I/O。如果某个路径不存在，每次查询都会重新触发磁盘探测，在大型项目中成为严重性能瓶颈。

**方案**：LRU 缓存同时缓存成功结果和 null 结果，设置合理的缓存上限（package.json 缓存 5000、路径缓存 20000）。

**教训**：缓存不仅应缓存命中结果，也应缓存未命中结果（negative cache），尤其在 I/O 密集场景。

### 8. 同步 I/O 在分析阶段优于异步 I/O

**问题**：分析阶段需要大量细粒度的文件读取（数百个 package.json），如果全部用异步 I/O，微任务调度的开销反而超过了 I/O 本身的收益。

**方案**：分析阶段使用同步 `readFileSync`，安装阶段使用异步 `spawn`（外部进程，天然异步）。

**教训**：异步不一定比同步快。大量小规模 I/O 操作中，同步方式因省去事件循环调度开销可能更优。应根据场景实测，而非教条地"一切异步"。

---

## 包管理器兼容性

### 9. npm install 需要 `--legacy-peer-deps` 避免卡死

**问题**：在安装别名依赖时，npm 的 peer 依赖检查可能因为版本冲突而无限等待或报错退出，导致安装流程卡死。

**方案**：始终传递 `--legacy-peer-deps` 跳过 peer 依赖检查。安装逻辑本身就是为了解决冲突，不需要 npm 再做一次检查。

### 10. 安装进程需要超时 + 信号升级机制

**问题**：网络问题或 registry 不可达时，`npm install` 可能无限挂起。

**方案**：
- 设置 120 秒超时
- 超时后先发 SIGTERM，等待 5 秒
- 若仍未退出则发 SIGKILL
- 用 `resolved` 标志防止 Promise 被 resolve 两次

**教训**：所有涉及外部进程的操作都必须有超时保护和优雅降级机制。

### 11. 包管理器自动检测需要多重降级策略

**问题**：不同项目使用不同的包管理器，硬编码会导致兼容性问题。

**方案**：三级降级检测：
1. `package.json` 的 `packageManager` 字段
2. lock 文件存在性（`pnpm-lock.yaml` / `yarn.lock` / `package-lock.json`）
3. 默认 npm

Registry 同理：项目 `.npmrc` → 用户 `~/.npmrc` → `.yarnrc.yml` → 默认 `registry.npmjs.org`。

---

## 构建工具插件

### 12. Webpack 插件应在 normalModuleFactory 阶段拦截

**问题**：Webpack 有多个阶段可以拦截模块解析（resolve hook、normalModuleFactory、compilation）。选择不当的阶段会导致拦截时机过晚或需要复杂的 resolve 链处理。

**方案**：使用 `normalModuleFactory` 的 `resolve` hook，在模块工厂创建阶段就拦截请求，直接修改 request 字段。

**额外处理**：
- watch 模式通过 `watchRun` hook 重新初始化
- 初始化失败不应阻塞编译（继续构建，只是别名不生效）
- `done` hook 中的错误不应抛出

### 13. Vite 插件需要处理 esbuild 版本差异

**问题**：esbuild 0.17+ 提供了 `build.resolve` API，但更早版本没有。直接调用会在旧版 esbuild 上崩溃。

**方案**：运行时检测 `typeof build.resolve === 'function'`，旧版使用 fallback 路径返回 `{ path, resolveDir }`。

### 14. Vite 插件在 dev/build 模式下应可独立开关

**问题**：某些场景只需要在生产构建时启用别名（dev 模式下冲突库不参与开发），但插件默认在所有模式下都生效。

**方案**：提供 `enableInDev` 和 `enableInBuild` 选项，禁用时返回 `undefined` 配置让 Vite 跳过。

---

## 模块解析与路径处理

### 15. 必须排除冲突目标包本身，避免主工程引用被重定向

**问题**：分析结果中的"相关包列表"会包含 peer 依赖声明中的目标包名（如 `vue`）。如果不排除，主工程代码中 `import Vue from 'vue'` 也会被重定向到别名版本。

**方案**：在收集完所有相关包后，显式移除冲突目标包名。

### 16. Windows 绝对路径需要特殊处理

**问题**：Windows 路径如 `C:\project\node_modules\foo` 会被错误地解析为包名 `C`。

**方案**：在提取 importer 包名时，用 `/^[a-zA-Z]:[\\/]/` 检测 Windows 绝对路径并跳过。

### 17. pnpm 的 `.pnpm` 目录必须跳过

**问题**：pnpm 的 node_modules 结构包含 `.pnpm` 虚拟存储目录，路径中包含大量中间目录。如果不过滤，会从路径中提取出 `.pnpm` 等无效包名。

**方案**：遍历 node_modules 路径时，跳过以 `.` 开头的目录段。

### 18. scoped 包的正则转义

**问题**：`@scope/pkg` 生成的正则表达式中，`/` 需要转义，否则会匹配到 `@scopeXpkg` 等错误路径。

**方案**：使用 `escapeRegex` 工具函数处理所有动态生成的正则片段。

### 19. 相对路径、绝对路径、虚拟模块不应被重定向

**问题**：构建工具的 resolve hook 会收到各种非包名请求（`./utils`、`/abs/path`、`webpack/runtime`、`virtual:module`），这些不应该进入别名解析。

**方案**：在插件层使用 `isPathLikeRequest` 和 `isWebpackInternalRequest` 过滤，只处理裸模块名（bare module specifiers）。

---

## 工程实践

### 20. Logger 使用全局级别避免子模块日志丢失

**问题**：入口开启 debug 模式后，子模块各自创建的 logger 实例仍然使用默认 INFO 级别，导致关键调试信息不输出。

**方案**：logger 使用模块级可变的全局级别变量，所有 logger 实例共享。支持位运算组合选择性输出。

### 21. semver 操作必须 try/catch

**问题**：用户项目中可能包含非标准的版本号（如 git URL、file: 协议、自定义 tag），直接传入 `semver.satisfies` 会抛异常。

**方案**：所有 semver 包装函数都用 try/catch 包裹，返回安全的默认值（`false` / `0`）。非标准版本号在生成别名名时取首段数字，兜底为 0。

### 22. 别名命名需要冲突解决策略

**问题**：同一包的不同版本可能生成相同的别名（如 `vue@2.6.14` 和 `vue@2.7.0` 都生成 `aliased-vue2`），导致安装冲突。

**方案**：三级命名策略：
1. 简单名：`aliased-vue2`
2. 完整版本后缀：`aliased-vue-2-6-14`
3. 数字计数器：`aliased-vue2-2`

### 23. 双重初始化应为 no-op

**问题**：在复杂构建配置中（如 Webpack 多配置 + watch 模式），`initialize()` 可能被多次调用。

**方案**：`initialize()` 内部检查状态，已初始化则直接返回。同时用 promise 缓存初始化过程，避免并发初始化。

---

## 总结

| 类别 | 核心教训 |
|------|---------|
| 依赖分析 | 约束条件只取需要解决的部分；resolve ≠ 声明；monorepo 声明需合并根 |
| 性能 | 迭代替代递归；负缓存同样重要；大量小 I/O 用同步可能更快 |
| 包管理器兼容 | 永远不要假设单一包管理器行为；安装进程必须有超时 |
| 构建工具插件 | 选择最早的拦截时机；处理版本差异；初始化失败不能阻塞构建 |
| 路径处理 | 区分裸模块名和路径；处理 Windows 路径；跳过虚拟存储目录 |
| 工程实践 | 外部输入全部容错；命名需要防冲突策略；重复调用必须幂等 |
