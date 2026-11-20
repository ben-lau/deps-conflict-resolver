# Changelog

## [1.5.0](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.4.2...v1.5.0) (2026-11-20)


### Features

* **core:** support peerOverrides for inaccurate upstream peer ranges ([a094516](https://github.com/ben-lau/deps-conflict-resolver/commit/a094516e55ca9307ae4e69bdd2e7cc12ea3575ea))


### Bug Fixes

* **core:** discover configured dependency instances through workspace links ([4e020fb](https://github.com/ben-lau/deps-conflict-resolver/commit/4e020fb3512e5b5e3f10a23b8e98097a9a2429a2))
* **core:** skip descendants whose declared peers only match the host ([7da25ac](https://github.com/ben-lau/deps-conflict-resolver/commit/7da25ac41d7765f2ee37b08176388ea253cbeb1a))

## [1.4.2](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.4.1...v1.4.2) (2026-12-31)


### Performance

* **core:** reuse version candidates for repeated ranges ([b658955](https://github.com/ben-lau/deps-conflict-resolver/commit/b658955e40bc1794bd9b4b94b070166d870b2c30))

## [1.4.1](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.4.0...v1.4.1) (2026-12-27)


### Bug Fixes

* **webpack:** invalidate affected watch modules and resolve linked aliases ([23ed4d5](https://github.com/ben-lau/deps-conflict-resolver/commit/23ed4d52cb8e96e749edcb518f2698bac9622e0f))

## [1.4.0](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.3.0...v1.4.0) (2026-12-26)


### Features

* **vite:** support SSR optimization and native Rolldown ([20b7cce](https://github.com/ben-lau/deps-conflict-resolver/commit/20b7cce93b4ac4f0a665cb8928cafc468aed93b5))

## [1.3.0](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.2.0...v1.3.0) (2026-12-16)


### Features

* **core:** add doctor and prepare CLI commands ([153a78f](https://github.com/ben-lau/deps-conflict-resolver/commit/153a78ffc9f8d5d48565f4f25a65672807ff3b0c))

## [1.2.0](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.1.2...v1.2.0) (2026-12-14)


### Features

* **core:** add indexed resolution and deterministic preparation ([bc499c6](https://github.com/ben-lau/deps-conflict-resolver/commit/bc499c6a5f086874ac6e3ef68e45ab9e4e43267b))

## [1.1.2](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.1.1...v1.1.2) (2026-12-04)


### Bug Fixes

* **core:** resolve dependency conflicts using package paths and importer-specific dependency graphs ([67f1afe](https://github.com/ben-lau/deps-conflict-resolver/commit/67f1afe67bfa428ee2066da95b87624d52191ce4))
* **core:** preserve root-visible dependencies and scoped include rules ([c2cd33c](https://github.com/ben-lau/deps-conflict-resolver/commit/c2cd33c4293a6dcc4a600c55f7b2024f37065c23))

## [1.1.1](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.1.0...v1.1.1) (2026-12-01)


### Bug Fixes

* **ci:** 修复 release-please 仍自动提取 component 的问题 ([4c9171b](https://github.com/ben-lau/deps-conflict-resolver/commit/4c9171b46d067a50eb939f7d72d914eeb5603118))
* **ci:** 收紧 release-please publish 条件并清理无效 extra-files ([885f0fb](https://github.com/ben-lau/deps-conflict-resolver/commit/885f0fbd0779e6dc3789664873d5f76c4dd702a9))
* **core:** revalidate reused aliases after package-manager attempts ([f10780e](https://github.com/ben-lau/deps-conflict-resolver/commit/f10780eaaa9899c2c473a1be6b32031a6218a3fb))
* **core:** verify installed aliases before accepting success ([4dcd0e5](https://github.com/ben-lau/deps-conflict-resolver/commit/4dcd0e58584b5d8e47b49030217e8ba0360890cf))
* **deps:** save exact aliases and forward Yarn registries ([7585ef8](https://github.com/ben-lau/deps-conflict-resolver/commit/7585ef88480bcb15c3285bcb856955384e998a44))
* **utils:** verify current visible package directories after relinking ([dbc3e3a](https://github.com/ben-lau/deps-conflict-resolver/commit/dbc3e3acd769beefff34834585fc0c329917d785))
* harden alias installation process ([6dc68d5](https://github.com/ben-lau/deps-conflict-resolver/commit/6dc68d59d831e227a7e86e4645c1358e3b67cbd0))
* harden cross-module alias publication ([44abcc0](https://github.com/ben-lau/deps-conflict-resolver/commit/44abcc08f9e330e95c84fb6861ae54466175c978))
* harden package-manager process lifecycle ([d833266](https://github.com/ben-lau/deps-conflict-resolver/commit/d833266a80a6af65fb093e999f7d5f2d06e75800))
* invoke package managers without shims ([85d76bf](https://github.com/ben-lau/deps-conflict-resolver/commit/85d76bfbbbbc469c58a594e69a9b73cf15d31c56))
* make resolver initialization idempotent ([4bab3ce](https://github.com/ben-lau/deps-conflict-resolver/commit/4bab3ce4c43758f7a6210de7165c205c07957a22))
* parse package-manager shim variables ([1c7b6ea](https://github.com/ben-lau/deps-conflict-resolver/commit/1c7b6ea54b784207bce5f4663a33790bc6912dd1))
* partition semver ranges by common versions ([644b50a](https://github.com/ben-lau/deps-conflict-resolver/commit/644b50a757aba28c25f0e1dd1dd248cdcac5b55f))
* preflight ambiguous alias identities ([011a580](https://github.com/ben-lau/deps-conflict-resolver/commit/011a58027e06bedd82f62ff3f00bd5a077d269b2))
* preserve alias ownership and install outcomes ([f97d875](https://github.com/ben-lau/deps-conflict-resolver/commit/f97d8756810fee7ddedcbaa665521a1b4078ba28))
* preserve registry body timeout and package exports ([fa800da](https://github.com/ben-lau/deps-conflict-resolver/commit/fa800da5186289bb0326a13af7bd05368e38956c))
* preserve resolver install outcome compatibility ([b59abe6](https://github.com/ben-lau/deps-conflict-resolver/commit/b59abe679d1d689ecc1407faff39f5afa2ccf4ff))
* prune inactive alias importer scopes ([5c0fe22](https://github.com/ben-lau/deps-conflict-resolver/commit/5c0fe2210dfa33b7270d43694b142fbdedd95bbc))
* refresh webpack resolver safely ([99078a6](https://github.com/ben-lau/deps-conflict-resolver/commit/99078a6ba5e2f18eb9b63c53df9e3dbe5244450a))
* reject ambiguous alias reuse ([985d848](https://github.com/ben-lau/deps-conflict-resolver/commit/985d8486fe2e0f82bb0872e4457916b7e4cd2010))
* restrict package-manager shim entrypoints ([b1bd084](https://github.com/ben-lau/deps-conflict-resolver/commit/b1bd08468219e756eea5f6d065d087129e9d56e3))
* reuse installed aliases offline ([946f9cd](https://github.com/ben-lau/deps-conflict-resolver/commit/946f9cdb2adf8edd2f00e81fef4598529253b56c))
* roll back failed resolver generations ([2b52219](https://github.com/ben-lau/deps-conflict-resolver/commit/2b522194a05767303de0b88104f872340be8f891))
* separate shadowed alias scopes ([aec11a3](https://github.com/ben-lau/deps-conflict-resolver/commit/aec11a334cc60760696c5cf279773af92073180a))
* skip optional peers and preserve aliases ([bc476d3](https://github.com/ben-lau/deps-conflict-resolver/commit/bc476d3fbe011bb25785152a4b5c6b0954ca71ea))
* skip unsatisfiable semver singleton groups ([a94372a](https://github.com/ben-lau/deps-conflict-resolver/commit/a94372ab0f171347469fd5586c61dc8ba7d3dbfe))
* validate reused alias identities ([eec15fe](https://github.com/ben-lau/deps-conflict-resolver/commit/eec15fe8caf42e19db0a5183bc5ee74508864959))
* 修复 CI 构建失败，指定 pnpm 版本并升级 GitHub Actions ([228d6f4](https://github.com/ben-lau/deps-conflict-resolver/commit/228d6f45cbc8bf58f3e86d9de2eaba5d53ff3329))
* 回退 GitHub Actions 至 v4，保持 Node.js 20 兼容 ([6d151eb](https://github.com/ben-lau/deps-conflict-resolver/commit/6d151ebef3411a13bfc36e6298a110da2dbc413a))

## 1.1.0 (2026-04-21)

### Features

* 1.0.0 ([50be793](https://github.com/ben-lau/deps-conflict-resolver/commit/50be79309cb55e0688d2f6d608656e52c698aaa5))
* 增加includeRedirects，修复遍历排除逻辑 bug，优化内存管理，提升性能减少微任务 ([21fe9cc](https://github.com/ben-lau/deps-conflict-resolver/commit/21fe9cc8bcf926dbd1e210bf8b026158ba7ba7e3))
