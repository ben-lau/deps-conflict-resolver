# Changelog

## [1.3.0](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.2.0...v1.3.0) (2026-11-17)


### Features

* **core:** add doctor and prepare CLI commands ([44db2d3](https://github.com/ben-lau/deps-conflict-resolver/commit/44db2d329514e044ad9e45ec652c2224b7732898))

## [1.2.0](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.1.2...v1.2.0) (2026-11-17)


### Features

* **core:** add indexed resolution and deterministic preparation ([27ced0c](https://github.com/ben-lau/deps-conflict-resolver/commit/27ced0cbfa22ac8470463d69355ca8297930f4d4))

## [1.1.2](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.1.1...v1.1.2) (2026-11-17)


### Bug Fixes

* **core:** resolve dependency conflicts using package paths and importer-specific dependency graphs ([a29b629](https://github.com/ben-lau/deps-conflict-resolver/commit/a29b629))
* **core:** preserve root-visible dependencies and scoped include rules ([70c3721](https://github.com/ben-lau/deps-conflict-resolver/commit/70c3721))

## [1.1.1](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.1.0...v1.1.1) (2026-11-17)


### Bug Fixes

* **ci:** 修复 release-please 仍自动提取 component 的问题 ([4c9171b](https://github.com/ben-lau/deps-conflict-resolver/commit/4c9171b46d067a50eb939f7d72d914eeb5603118))
* **ci:** 收紧 release-please publish 条件并清理无效 extra-files ([885f0fb](https://github.com/ben-lau/deps-conflict-resolver/commit/885f0fbd0779e6dc3789664873d5f76c4dd702a9))
* harden alias installation and resolver safety ([a9c9f6e](https://github.com/ben-lau/deps-conflict-resolver/commit/a9c9f6eb82d424e65727f0324674c8cf69cc5a15))
* harden alias installation process ([6dc68d5](https://github.com/ben-lau/deps-conflict-resolver/commit/6dc68d59d831e227a7e86e4645c1358e3b67cbd0))
* harden package-manager process lifecycle ([d833266](https://github.com/ben-lau/deps-conflict-resolver/commit/d833266a80a6af65fb093e999f7d5f2d06e75800))
* invoke package managers without shims ([85d76bf](https://github.com/ben-lau/deps-conflict-resolver/commit/85d76bfbbbbc469c58a594e69a9b73cf15d31c56))
* parse package-manager shim variables ([1c7b6ea](https://github.com/ben-lau/deps-conflict-resolver/commit/1c7b6ea54b784207bce5f4663a33790bc6912dd1))
* preflight ambiguous alias identities ([011a580](https://github.com/ben-lau/deps-conflict-resolver/commit/011a58027e06bedd82f62ff3f00bd5a077d269b2))
* reject ambiguous alias reuse ([985d848](https://github.com/ben-lau/deps-conflict-resolver/commit/985d8486fe2e0f82bb0872e4457916b7e4cd2010))
* restrict package-manager shim entrypoints ([b1bd084](https://github.com/ben-lau/deps-conflict-resolver/commit/b1bd08468219e756eea5f6d065d087129e9d56e3))
* reuse installed aliases offline ([946f9cd](https://github.com/ben-lau/deps-conflict-resolver/commit/946f9cdb2adf8edd2f00e81fef4598529253b56c))
* separate shadowed alias scopes ([aec11a3](https://github.com/ben-lau/deps-conflict-resolver/commit/aec11a334cc60760696c5cf279773af92073180a))
* skip optional peers and preserve aliases ([bc476d3](https://github.com/ben-lau/deps-conflict-resolver/commit/bc476d3fbe011bb25785152a4b5c6b0954ca71ea))
* validate reused alias identities ([eec15fe](https://github.com/ben-lau/deps-conflict-resolver/commit/eec15fe8caf42e19db0a5183bc5ee74508864959))
* 修复 CI 构建失败，指定 pnpm 版本并升级 GitHub Actions ([228d6f4](https://github.com/ben-lau/deps-conflict-resolver/commit/228d6f45cbc8bf58f3e86d9de2eaba5d53ff3329))
* 回退 GitHub Actions 至 v4，保持 Node.js 20 兼容 ([6d151eb](https://github.com/ben-lau/deps-conflict-resolver/commit/6d151ebef3411a13bfc36e6298a110da2dbc413a))

## 1.1.0 (2026-04-21)

### Features

- 1.0.0 ([50be793](https://github.com/ben-lau/deps-conflict-resolver/commit/50be79309cb55e0688d2f6d608656e52c698aaa5))
- 增加includeRedirects，修复遍历排除逻辑 bug，优化内存管理，提升性能减少微任务 ([21fe9cc](https://github.com/ben-lau/deps-conflict-resolver/commit/21fe9cc8bcf926dbd1e210bf8b026158ba7ba7e3))
