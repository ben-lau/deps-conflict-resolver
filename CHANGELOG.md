# Changelog

## [1.1.1](https://github.com/ben-lau/deps-conflict-resolver/compare/v1.1.0...v1.1.1) (2026-10-14)


### Bug Fixes

* **ci:** 修复 release-please 仍自动提取 component 的问题 ([4c9171b](https://github.com/ben-lau/deps-conflict-resolver/commit/4c9171b46d067a50eb939f7d72d914eeb5603118))
* **ci:** 收紧 release-please publish 条件并清理无效 extra-files ([885f0fb](https://github.com/ben-lau/deps-conflict-resolver/commit/885f0fbd0779e6dc3789664873d5f76c4dd702a9))
* harden alias installation process ([6dc68d5](https://github.com/ben-lau/deps-conflict-resolver/commit/6dc68d59d831e227a7e86e4645c1358e3b67cbd0))
* harden cross-module alias publication ([4a87a71](https://github.com/ben-lau/deps-conflict-resolver/commit/4a87a71ea618a066749318418943a00756a714e7))
* harden package-manager process lifecycle ([d833266](https://github.com/ben-lau/deps-conflict-resolver/commit/d833266a80a6af65fb093e999f7d5f2d06e75800))
* invoke package managers without shims ([85d76bf](https://github.com/ben-lau/deps-conflict-resolver/commit/85d76bfbbbbc469c58a594e69a9b73cf15d31c56))
* make resolver initialization idempotent ([4bab3ce](https://github.com/ben-lau/deps-conflict-resolver/commit/4bab3ce4c43758f7a6210de7165c205c07957a22))
* parse package-manager shim variables ([1c7b6ea](https://github.com/ben-lau/deps-conflict-resolver/commit/1c7b6ea54b784207bce5f4663a33790bc6912dd1))
* partition semver ranges by common versions ([644b50a](https://github.com/ben-lau/deps-conflict-resolver/commit/644b50a757aba28c25f0e1dd1dd248cdcac5b55f))
* preflight ambiguous alias identities ([011a580](https://github.com/ben-lau/deps-conflict-resolver/commit/011a58027e06bedd82f62ff3f00bd5a077d269b2))
* preserve alias ownership and install outcomes ([20d722c](https://github.com/ben-lau/deps-conflict-resolver/commit/20d722c171fa8848ac888336e0b7e6f9ae6f9613))
* preserve registry body timeout and package exports ([13b9073](https://github.com/ben-lau/deps-conflict-resolver/commit/13b90738252d055419fb3d92dbb68b060fa5f6b0))
* preserve resolver install outcome compatibility ([1dd07d6](https://github.com/ben-lau/deps-conflict-resolver/commit/1dd07d6411abb40c80870e7d4377dd576d7801bf))
* preserve root-visible dependency and scoped include rules ([70c3721](https://github.com/ben-lau/deps-conflict-resolver/commit/70c372131df85b5be76fd66022dbfbf32b85bb49))
* prune inactive alias importer scopes ([a03159a](https://github.com/ben-lau/deps-conflict-resolver/commit/a03159a77ee1a9e03d8f3290b7d608f662f51816))
* refresh webpack resolver safely ([99078a6](https://github.com/ben-lau/deps-conflict-resolver/commit/99078a6ba5e2f18eb9b63c53df9e3dbe5244450a))
* reject ambiguous alias reuse ([985d848](https://github.com/ben-lau/deps-conflict-resolver/commit/985d8486fe2e0f82bb0872e4457916b7e4cd2010))
* resolve dependency graphs by package path ([a29b629](https://github.com/ben-lau/deps-conflict-resolver/commit/a29b629019e2836fd1aa2a1c64deb31af0728b20))
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

- 1.0.0 ([50be793](https://github.com/ben-lau/deps-conflict-resolver/commit/50be79309cb55e0688d2f6d608656e52c698aaa5))
- 增加includeRedirects，修复遍历排除逻辑 bug，优化内存管理，提升性能减少微任务 ([21fe9cc](https://github.com/ben-lau/deps-conflict-resolver/commit/21fe9cc8bcf926dbd1e210bf8b026158ba7ba7e3))
