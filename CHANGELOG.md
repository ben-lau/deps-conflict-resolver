# Changelog

## [1.7.0](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.6.3...v1.7.0) (2026-11-27)


### Features

* **core:** guide offline resolver setup and diagnosis ([d95adca](https://github.com/ben-lau/deps-conflict-resolver/commit/d95adcab20d66f7210988d96a80a48f20ecc4937))
* **core:** honor scoped npm registries for metadata ([1fec9d1](https://github.com/ben-lau/deps-conflict-resolver/commit/1fec9d19ba2d3ea59cf33c96f94400cb50cf1031))
* **core:** measure dependency preparation phases ([152240b](https://github.com/ben-lau/deps-conflict-resolver/commit/152240b0d95fd68542bb7a8708635eb7b07e960f))
* **core:** reuse verified persisted dependency plans ([0250ae2](https://github.com/ben-lau/deps-conflict-resolver/commit/0250ae268f8b5b0286a45502d11801bc35d6718a))


### Bug Fixes

* **core:** explain unchecked peer version candidates ([ecd3972](https://github.com/ben-lau/deps-conflict-resolver/commit/ecd3972195672cfb8a503047868243ae9a9e8888))
* **core:** guard against offline redirects changing mid-build ([184182e](https://github.com/ben-lau/deps-conflict-resolver/commit/184182ea959bac37d91864850e28a995981a3e6b))
* **core:** honor explicit registry for scoped aliases ([36e8a4a](https://github.com/ben-lau/deps-conflict-resolver/commit/36e8a4a06604fb9b9f960602d7ff64a1d9809a56))
* **core:** keep failed preparation reports scoped to the attempt ([8e62995](https://github.com/ben-lau/deps-conflict-resolver/commit/8e6299574e62e79c7fd05aee4b21c4d33c5e8d3e))
* **core:** make setup and optional peer diagnostics actionable ([28edc38](https://github.com/ben-lau/deps-conflict-resolver/commit/28edc388d711ca8b510d3a583de04ff8b1a264e3))
* **core:** preserve exact registry scopes during installation ([00d573d](https://github.com/ben-lau/deps-conflict-resolver/commit/00d573d2647514fce410076de9deb699c712f9cc))
* **core:** publish dependency preparation failures atomically ([307473a](https://github.com/ben-lau/deps-conflict-resolver/commit/307473a61091f899646ae70e55a8ea526de4c82f))
* **core:** respect offline plan lookup policy ([968db25](https://github.com/ben-lau/deps-conflict-resolver/commit/968db253a040bf35dceff8b24e2d967d1be21750))
* **core:** revisit peer providers across entry scopes ([b19c71f](https://github.com/ben-lau/deps-conflict-resolver/commit/b19c71fc7f355bc3cb15fc4079722058eca0e131))
* **core:** verify exact scoped registries on Yarn Classic ([78066f1](https://github.com/ben-lau/deps-conflict-resolver/commit/78066f11d1b88290af7bbfaa32074a1206e611a4))
* **vite:** fall back to directory polling when native watches fail ([d7b1c96](https://github.com/ben-lau/deps-conflict-resolver/commit/d7b1c96bb9b4f47262cc67870b6c272a0bc6f111))
* **vite:** guard native watch against stale alias paths ([ae1c88e](https://github.com/ben-lau/deps-conflict-resolver/commit/ae1c88ed9ae8109271711ff103eec1f3842e859a))
* **vite:** observe installed links through parent directories ([5d7375e](https://github.com/ben-lau/deps-conflict-resolver/commit/5d7375e44a4a44a6676cae62a62162f7af4be891))
* **vite:** recheck missing package lookups before first build ([0a91c8a](https://github.com/ben-lau/deps-conflict-resolver/commit/0a91c8a06c825b09e889f2999d45e2141722cbe7))
* **vite:** refresh production watch resolutions ([e06f287](https://github.com/ben-lau/deps-conflict-resolver/commit/e06f28773a34291065d5b123ea27cb7631e3dcff))
* **vite:** track installed package paths across watch builds ([da377a9](https://github.com/ben-lau/deps-conflict-resolver/commit/da377a9d76244406293754ef084820ae29fb9307))
* **vite:** track watch rebuilds by environment ([3b18168](https://github.com/ben-lau/deps-conflict-resolver/commit/3b181689a9c3e1d5b339419283d283eeefd8e34e))
* **vite:** verify installed paths before publishing builds ([5db700b](https://github.com/ben-lau/deps-conflict-resolver/commit/5db700bdfa2c2791679d7c807267bbbfde33903f))
* **vite:** watch installed providers and nearer slots ([2ac7637](https://github.com/ben-lau/deps-conflict-resolver/commit/2ac7637d5b440f2cf4628c9733ff5fdefb8f112e))
* **webpack:** isolate strict guards for child compilations ([8208862](https://github.com/ben-lau/deps-conflict-resolver/commit/82088625c62cb4f52041d6ecc5dced3d1cd5e4f4))


### Performance

* **core:** capture offline plans in one analysis pass ([72f7575](https://github.com/ben-lau/deps-conflict-resolver/commit/72f7575ad9e2cc632bd2d65808de7f6ca52dea1a))
* **core:** reuse physical lookups in analysis projection ([6b6dbbb](https://github.com/ben-lau/deps-conflict-resolver/commit/6b6dbbb68da3c615add4f3b945c87e99505f8926))
* **vite:** filter guarded build and optimizer requests ([9513e7f](https://github.com/ben-lau/deps-conflict-resolver/commit/9513e7f178a0495f8af7d999bdd0ab8b50746456))
* **vite:** omit unused resolution hook for empty plans ([79fd368](https://github.com/ben-lau/deps-conflict-resolver/commit/79fd3681f0d29588ec31961d19e44413203d1789))
* **webpack:** avoid allocations for unrelated requests ([6789780](https://github.com/ben-lau/deps-conflict-resolver/commit/6789780078807ef909f9c097a3d59f89856a65c0))
* **webpack:** fast-path unrelated module requests ([f7efc8c](https://github.com/ben-lau/deps-conflict-resolver/commit/f7efc8ca8f0aa168c3c7f5d7d18cfa5d27466fe7))


### Code Refactoring

* **core:** own watch inputs in one module ([d3d8362](https://github.com/ben-lau/deps-conflict-resolver/commit/d3d8362727113c8cb3e69bb87eccc15109599db2))
* **core:** publish dependency generations atomically ([955cd6c](https://github.com/ben-lau/deps-conflict-resolver/commit/955cd6c784eb8873629e65a049e697f390513fdb))
* **core:** remove name-based graph traversal ([5352ee4](https://github.com/ben-lau/deps-conflict-resolver/commit/5352ee40335bf677d0354b87d1be211dae1bb2e9))
* **core:** share physical scope matching ([013c47a](https://github.com/ben-lau/deps-conflict-resolver/commit/013c47ac1aa46fc4b940d9cba9e900ad1bfdf32a))

## [1.6.3](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.6.2...v1.6.3) (2026-11-27)


### Bug Fixes

* **core:** preserve custom redirect origins ([0258b7f](https://github.com/ben-lau/deps-conflict-resolver/commit/0258b7fc4234563972782f65a2e075d76ab0244a))
* **core:** reconsider conflicting peer providers ([c1a52a6](https://github.com/ben-lau/deps-conflict-resolver/commit/c1a52a6a0a427072eae4265db9d65bfe86f7e011))

## [1.6.2](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.6.1...v1.6.2) (2026-11-27)


### Bug Fixes

* **core:** isolate published analysis results ([e6dd896](https://github.com/ben-lau/deps-conflict-resolver/commit/e6dd8961fc590c74fa23bc8219ef9df8c8b2aeb3))
* **core:** verify installed alias peer identity ([90adf06](https://github.com/ben-lau/deps-conflict-resolver/commit/90adf063a2b93ea10558f69db98d41071676b839))
* **webpack:** retry preparation on the next build ([542bf43](https://github.com/ben-lau/deps-conflict-resolver/commit/542bf4349aaa9776c1038a6c39e715a5f5ced21d))

## [1.6.1](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.6.0...v1.6.1) (2026-11-25)


### Bug Fixes

* **core:** publish verified dependency preparation snapshots ([243dc19](https://github.com/ben-lau/deps-conflict-resolver/commit/243dc1956da0b3cfe9c7200faaa82a9351decbf8))
* **core:** resolve manifests from current package lookup paths ([fc1bac1](https://github.com/ben-lau/deps-conflict-resolver/commit/fc1bac1b9331122daeaaf32839b280875a4ee8b2))
* **vite:** align resolution hooks across pre-bundlers ([fa39455](https://github.com/ben-lau/deps-conflict-resolver/commit/fa394555e4a4f102bcf4ad7540214c47fb20cc1f))
* **vite:** route resolver logs through the host logger ([b2829ac](https://github.com/ben-lau/deps-conflict-resolver/commit/b2829ac9e466e4f0ed910d68cd89dc8b668248e6))


### Performance

* **webpack:** reuse verified analysis during watch builds ([eb2bf3b](https://github.com/ben-lau/deps-conflict-resolver/commit/eb2bf3b90304b2b024e6fea065dcbb316c2fc721))

## [1.6.0](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.5.2...v1.6.0) (2026-11-24)


### Features

* **core:** share resolver options through CLI config modules ([b51ea47](https://github.com/ben-lau/deps-conflict-resolver/commit/b51ea47983c9bdfa617225b5a1896c449b5e9ea5))


### Bug Fixes

* **core:** honor workspace roots and registry settings ([be954b9](https://github.com/ben-lau/deps-conflict-resolver/commit/be954b977768e5b5874550908c4c807d7b6a2078))
* **core:** keep dependency preparation ordered ([656afe2](https://github.com/ben-lau/deps-conflict-resolver/commit/656afe290d5e682922522f196a83caf4b12a7bd3))
* **core:** select aliases against effective peer providers ([2e8e88d](https://github.com/ben-lau/deps-conflict-resolver/commit/2e8e88dce306480550473ebd8908c667bcc10f71))
* **core:** validate peers against installed package contexts ([e102d0f](https://github.com/ben-lau/deps-conflict-resolver/commit/e102d0f4361739c962fb69f2244be6954680e3ed))
* **vite:** preserve scoped resolution across build and optimization ([e14c131](https://github.com/ben-lau/deps-conflict-resolver/commit/e14c131c2a1810423bcb8041ec4e3913d4e82aad))
* **webpack:** tolerate compilers without cache hooks ([04d29d1](https://github.com/ben-lau/deps-conflict-resolver/commit/04d29d199369b40adb34db5c61630183c76766f5))


### Performance

* **core:** share resolution for verified sibling importers ([4cbc430](https://github.com/ben-lau/deps-conflict-resolver/commit/4cbc43053f69518e2d81637836fdba3e88c813fc))
* **vite:** filter unrelated resolver requests ([2eaf562](https://github.com/ben-lau/deps-conflict-resolver/commit/2eaf562221918118b15f34218dcec047ca5f8733))

## [1.5.2](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.5.1...v1.5.2) (2026-11-23)


### Bug Fixes

* **core:** allow owning workspace packages to satisfy host-undeclared peers ([07f94c6](https://github.com/ben-lau/deps-conflict-resolver/commit/07f94c6afd73800412c661ae051c8973c6129031))
* **core:** catch configured importer ambiguity during initialization ([207edba](https://github.com/ben-lau/deps-conflict-resolver/commit/207edba6a3cdab7cc64d18a226000592ed1d663e))
* **core:** harden shared-peer protocol resolution and nested pruning boundaries ([7a4a023](https://github.com/ben-lau/deps-conflict-resolver/commit/7a4a0231cd21ca1a7da01ada352172fd27105ba0))
* **core:** keep descendant redirects without a compatible provider ([45d702c](https://github.com/ben-lau/deps-conflict-resolver/commit/45d702c47b98c6ddd399f358ee823c3d7f22dcb3))
* **core:** normalize installed peer requests across alias names ([f2999c2](https://github.com/ben-lau/deps-conflict-resolver/commit/f2999c2839f66748160e7f148e42deb6dd1c2ab3))
* **core:** prune incompatible aliases from descendant ties ([1877e04](https://github.com/ben-lau/deps-conflict-resolver/commit/1877e046228e91c77538a93c67ea33c5e1abc3bf))
* **core:** validate peer contexts against active alias rules ([96a1cd0](https://github.com/ben-lau/deps-conflict-resolver/commit/96a1cd05febf744af3c29f2696bd2706e134b43f))
* **core:** verify workspace peer identity and avoid redundant snapshot realpaths ([8ed8f1c](https://github.com/ben-lau/deps-conflict-resolver/commit/8ed8f1c6b0b1905609531705417b9b5c2bf6c9d9))
* **vite:** preserve all reachable workspace routes in SSR builds ([3148043](https://github.com/ben-lau/deps-conflict-resolver/commit/3148043cea71c378a2ac76244e3870a6b70c8ed6))


### Performance

* **core:** retain canonical path cache across init and precompile peerOverrides ([1a1a501](https://github.com/ben-lau/deps-conflict-resolver/commit/1a1a5018cdb7feb5149b0afe0de0ebe4913b792b))

## [1.5.1](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.5.0...v1.5.1) (2026-11-20)


### Bug Fixes

* **core:** close peerOverrides pipeline across dependency graph and shared contexts ([addfde1](https://github.com/ben-lau/deps-conflict-resolver/commit/addfde181a48384143bc5f66910984d0beac1ce4))
* **core:** isolate pruned descendants across nested node_modules and sibling aliases ([f48bfd3](https://github.com/ben-lau/deps-conflict-resolver/commit/f48bfd3a89d0fbc367b02f0d8c6456f0646bfd4e))
* **core:** preserve all workspace entry paths for shared physical roots ([543f082](https://github.com/ben-lau/deps-conflict-resolver/commit/543f0822c9950cbe655de2e4857009910c6c301d))


### Performance

* **core:** cache canonical package paths and skip redundant shared-peer checks ([0a969b9](https://github.com/ben-lau/deps-conflict-resolver/commit/0a969b970f233012d0baa40eecc05fe76e870a73))

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
