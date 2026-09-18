# Linux 安装包（deb / rpm / AppImage）构建镜像。
#
# 为什么必须容器：deb/rpm/AppImage 只能在其宿主 OS 上产出 —— macOS 上的 tauri CLI 连
# 参数都不接受（`error: invalid value 'deb' for '--bundles [<BUNDLES>...]' [possible values: ios, app, dmg]`）。
# 同一个 Dockerfile 供两种架构使用：`--platform linux/amd64` 出 x86_64 包，
# `--platform linux/arm64` 出 aarch64 包（Apple Silicon 上是原生，amd64 走 Rosetta 仿真）。
#
# ── 两条铁律 ──
# 一、**构建阶段不做任何下载**：apt 的包体、node tarball、rust 工具链、npm 包、crate 源码
#     全部在构建前由宿主预取好，构建阶段只消费本地文件。判据是 `OFFLINE=1` —— 它给构建
#     断网（`--network=none`），只要有任何一处想联网就当场失败，而不是"看起来很快"。
# 二、**预取阶段只用国内源**（每个源都留成 ARG，换源不用改文件）。本机到镜像站的出口实测
#     ~1.5 MB/s，这是硬约束：能不下就不下，非下不可只下一次。
#
# ⚠️ 唯一入口是 build/linux/build.sh。宿主 ~/.docker/config.json 里若配了代理，docker 会把它
# 注入进每个 RUN，而那个值通常写的是 127.0.0.1 —— 容器里的 127.0.0.1 是容器自身，装了等于
# 全断（实测 apt 报 `Unable to connect to 127.0.0.1:7897`）。脚本会显式传空的代理参数清掉它，
# 下面的守卫再把漏网的情况拦成一条看得懂的报错。

# syntax=docker/dockerfile:1.7

# ───────────────────────── 全局参数 ─────────────────────────
# 工具链镜像的 tag（每条架构一个），由 build.sh 先造好再 --build-arg 传进来。
# 造它是独立一步的原因：apt 装 450 个包要 ~100s（amd64 仿真下）/ ~40s（原生），
# 而这一层只要输入不变就该一直被复用 —— 放在同一次构建里的话，Dockerfile 任何一处改动
# 都会让它重来。tag 之后它变成一份可以反复 FROM 的成品，源码改动与它完全无关。
ARG TOOLCHAIN_IMAGE=ccsa-linux-toolchain
# 预取阶段与构建阶段共用同一份，避免包清单/源地址在两边各写一遍。
ARG NODE_VERSION=20.18.0
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG RUST_DIST_SERVER=https://rsproxy.cn
# apt 镜像必须用 http：基础镜像里没有 CA 证书，https 会握手失败
# （实测报 `Certificate verification failed ... No system certificates available`，
# 而 ca-certificates 本身要靠 apt 装 —— 鸡生蛋）。包完整性由 apt 的 gpg 签名保证。
# 两个地址都要给：amd64 的基础镜像指向 archive.ubuntu.com，arm64 的指向 ports.ubuntu.com
# （arm64 在 Ubuntu 的 ports 归档里）。只改前者时 arm64 会直连 ports 站，实测被 502 挡下。
ARG APT_MIRROR=http://mirrors.aliyun.com/ubuntu
ARG APT_PORTS_MIRROR=http://mirrors.aliyun.com/ubuntu-ports
# 基础镜像可换：出「自带依赖的离线包」时要按**目标发行版**解依赖（24.04 的 libgtk-3-0t64
# 与 22.04 的 libgtk-3-0 不能混），那时用 --build-arg BASE_IMAGE=ubuntu:24.04 跑同一个
# apt-ready 阶段 —— 源配置与 mirror 改写因此不需要写第二份。
ARG BASE_IMAGE=ubuntu:22.04
# libwebkit2gtk-4.1-dev 与 librsvg2-dev 是 Tauri v2 的 Linux 官方前置；libayatana-appindicator3-dev
# 给托盘；libxdo-dev 给终端模拟；rpm / libfuse2 给两个打包器。
ARG APT_PACKAGES="build-essential ca-certificates curl wget file pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev patchelf rpm libfuse2"
# AppImage 不在默认里：它的 linuxdeploy 工具由 tauri 打包器**每次**从 GitHub 现下
# （解到 /tmp/appimage_extracted_*，二进制里只有 TAURI_BUNDLER_TOOLS_GITHUB_MIRROR 一个开关，
# 没有"用本地已有工具"的选项），而 deb 与 rpm 不需要任何下载。要用就显式打开。
ARG BUNDLES=deb,rpm

# ───────────────────────── apt 源配置 ─────────────────────────
# 预取与构建共用这一份源配置，避免两边各写一遍。
FROM ${BASE_IMAGE} AS apt-ready
ARG APT_MIRROR
ARG APT_PORTS_MIRROR
ARG DEBIAN_FRONTEND=noninteractive
# 不删 /etc/apt/apt.conf.d/docker-clean 的话，apt 装完就把 /var/cache/apt/archives/*.deb 删掉
# （DPkg::Post-Invoke 钩子，失败也跑）——用缓存挂载做包体复用会因此完全失效。
# 这里连同 Keep-Downloaded-Packages 一起显式声明，避免基础镜像以后又改回去。
# Acquire::Retries：镜像站会偶发 502（实测 libatk-bridge2.0-dev 中过一次）。
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
 && printf 'Binary::apt::APT::Keep-Downloaded-Packages "true";\nAcquire::Retries "5";\n' \
      > /etc/apt/apt.conf.d/99-keep-debs \
 && for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \
      [ -f "$f" ] || continue; \
      sed -i \
        -e "s|http://archive.ubuntu.com/ubuntu|$APT_MIRROR|g" \
        -e "s|http://security.ubuntu.com/ubuntu|$APT_MIRROR|g" \
        -e "s|http://ports.ubuntu.com/ubuntu-ports|$APT_PORTS_MIRROR|g" \
        "$f"; \
    done

# ───────────────────────── 预取：apt 包体 + 索引 ─────────────────────────
# 一次性阶段，由 build.sh 只在缓存缺失时跑，产物导出到 build/linux/.cache/apt/<arch>/。
# 构建阶段拿它当本地仓库用（--no-download），因此不需要网络。
# 两个缓存挂载是为了「中途被打断也不白下」：包体先落在 /var/cache/apt/archives（挂载里），
# 成功后才拷进 /out 导出。整段 248 MB / 8 分钟，中断一次就从零重来是不可接受的。
FROM apt-ready AS prefetch-apt
ARG APT_PACKAGES
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --download-only --no-install-recommends $APT_PACKAGES \
 && mkdir -p /out/debs \
 && cp -a /var/cache/apt/archives/. /out/debs/ \
 && cp -a /var/lib/apt/lists /out/lists

FROM scratch AS export-apt
COPY --from=prefetch-apt /out /

# ───────────────────────── 预取：运行时依赖闭包（离线包用） ─────────────────────────
# 与上面的构建闭包分开：构建闭包含 build-essential / 各种 -dev 头文件，装到用户桌面机上
# 不合适（那是 450 个包）。这里只解**运行**要的那几个库及其依赖。
# 只用目标发行版自己的名字：24.04 是 libgtk-3-0t64，22.04 是 libgtk-3-0，由调用方按
# --build-arg DEB_RUNTIME_PACKAGES 传进来（见 build/linux/offline-bundle.sh）。
FROM apt-ready AS prefetch-deb-runtime
ARG DEB_RUNTIME_PACKAGES
# 刻意不给这一阶段挂 apt 缓存：BuildKit 的缓存挂载是按**路径**认的，挂 /var/cache/apt 会与
# 构建预取共用同一个目录 —— 于是构建闭包那 450 个编译器/头文件包会混进运行时闭包，
# 实测导出成 1063 个包 / 576 MB（真正的运行时闭包约 125 MB）。索引缓存同理不挂：
# 这一阶段可能跑在另一个发行版上（noble），与构建用的 jammy 索引混在一个目录里没有好处。
# 于是直接把下载目录指到导出目录，/out/debs 里就**恰好**是这次解析出来的闭包。
RUN mkdir -p /out/debs/partial \
 && apt-get update \
 && apt-get install -y --download-only --no-install-recommends \
      -o Dir::Cache::archives=/out/debs $DEB_RUNTIME_PACKAGES

FROM scratch AS export-deb-runtime
COPY --from=prefetch-deb-runtime /out /

# ───────────────────────── 构建 ─────────────────────────
FROM apt-ready AS toolchain
ARG http_proxy
ARG https_proxy
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NODE_VERSION
ARG NPM_REGISTRY
ARG APT_PACKAGES

# 代理守卫：预取与构建都用国内源，容器里不需要代理；宿主注入的 loopback 代理必须被挡在门外，
# 否则失败会表现成「apt 拉不到索引」这种看不出根因的样子。
RUN for v in "$http_proxy" "$https_proxy" "$HTTP_PROXY" "$HTTPS_PROXY"; do \
      case "$v" in \
        *127.0.0.1*|*localhost*) \
          echo "代理指向 loopback，容器内不可达（$v）。本镜像全程走国内源、不用代理；" >&2; \
          echo "请用 sh build/linux/build.sh <platform> 构建，它会清掉宿主注入的代理。" >&2; \
          exit 1 ;; \
      esac; \
    done

# CARGO_HOME 只是 registry 缓存与 config.toml 的落点（cargo/rustc 二进制由组件包铺进
# /usr/local/bin，与它无关）；固定成这个路径是为了让灌种子的目标位置稳定。
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/bin:/usr/bin:/bin

# apt：只从本地包体装。--no-download 是关键 —— 缺哪个包当场失败，
# 不会退化成「悄悄联网补一个」，那样「构建不下载」就无从验证了。
RUN --mount=type=bind,from=apt-cache,source=.,target=/seed/apt \
    mkdir -p /var/cache/apt/archives /var/lib/apt/lists \
 && cp -a /seed/apt/debs/. /var/cache/apt/archives/ \
 && cp -a /seed/apt/lists/. /var/lib/apt/lists/ \
 && apt-get install -y --no-download --no-install-recommends $APT_PACKAGES

# Node：用预取好的官方 tarball（发行版自带的太老；在容器里下则每次都要联网）。
# 包名里的架构串与 dpkg 的名字不同，必须映射。
RUN --mount=type=bind,from=node-tarballs,source=.,target=/seed/node \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported debian architecture: $arch" >&2; exit 1 ;; \
    esac; \
    tar -xJf "/seed/node/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -C /usr/local --strip-components=1 \
 && node --version

# Rust：直接解预取好的组件包，不走 rustup —— rustup 每次都从 dist 站拉工具链，
# 而这三个包（rustc / rust-std / cargo）就是它要拉的东西，直接铺更短、也才谈得上离线。
# 剥两层：组件包的路径是 `<tarball名>/<组件>/bin|lib|share/...`，剥两层才落到 /usr/local，
# 与 rustup 装出来的布局一致（rustc 的 sysroot 就是它自己的上级目录）。
RUN --mount=type=bind,from=rust-tarballs,source=.,target=/seed/rust \
    for component in /seed/rust/*.tar.xz; do \
      tar -xJf "$component" -C /usr/local --strip-components=2; \
    done \
 && cargo --version && rustc --version

# cargo 不配源替换，用默认的 crates.io：本机 ~/.cargo 也没有源替换，两边 registry 目录的
# 身份串（index.crates.io-<hash>）因此一致 —— 换过源就对不上，宿主里那 92 MB .crate 包体
# 与 41 MB sparse 索引会全部作废、只能重下。npm 侧同理沿用宿主同一份 registry 配置。
RUN mkdir -p "$CARGO_HOME" \
 && printf '%s\n' '[net]' 'git-fetch-with-cli = true' > "$CARGO_HOME/config.toml"

# ───────────────────────── 出包 ─────────────────────────
# 起手就是那份造好的工具链镜像（apt + node + rust 都在里面），不再依赖上面的 toolchain 阶段：
# 于是「改源码」与「改 Dockerfile」都不会碰到装包那 100s。
ARG TOOLCHAIN_IMAGE
FROM ${TOOLCHAIN_IMAGE} AS build
ARG BUNDLES
WORKDIR /src

# 把宿主已有的包体灌进构建缓存，依赖这一步就不走网络：npm 的 cacache 与 cargo 的 .crate
# 都是平台无关的压缩包，宿主那两份缓存里已有本项目 lockfile 要的全部内容。
# marker 守卫是必须的：只在第一次灌，之后跳过，否则每轮都要白搬 130 MB+。
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=bind,from=npm-cache,source=.,target=/seed/npm \
    [ -f /root/.npm/.seeded ] \
      || { cp -a /seed/npm/. /root/.npm/; touch /root/.npm/.seeded; }

RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=bind,from=cargo-cache,source=.,target=/seed/cargo-cache \
    --mount=type=bind,from=cargo-index,source=.,target=/seed/cargo-index \
    [ -f /usr/local/cargo/registry/.seeded ] || { \
      mkdir -p /usr/local/cargo/registry/cache /usr/local/cargo/registry/index; \
      cp -a /seed/cargo-cache/. /usr/local/cargo/registry/cache/; \
      cp -a /seed/cargo-index/. /usr/local/cargo/registry/index/; \
      touch /usr/local/cargo/registry/.seeded; }

# 先只拷依赖清单，让 npm ci 这层在源码改动时仍然命中缓存（依赖很少变）。
COPY package.json package-lock.json ./
# prefer-offline：缓存里有就用缓存。缓存已在上面灌好，缺的会在 OFFLINE=1 下暴露出来。
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --prefer-offline

COPY . .

# target 挂成缓存：cargo 全量重编一次要几分钟，缓存让重跑只重编本 crate。
# 但缓存里同时留着**上一次**的 bundle/ 产物，而 tauri 只往里写本次要出的格式、不清理 ——
# 于是 BUNDLES 收窄时（例如从 appimage 收成 deb,rpm），上一次的 AppImage 会被当成本次产物
# 一起导出、平铺进 releases/（实测撞到过）。所以打包前先清掉 bundle/。
# cache 挂载不落进镜像层，所以产物必须在本 RUN 内拷到 /out。
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/src-tauri/target,sharing=locked \
    rm -rf src-tauri/target/release/bundle \
 && npx tauri build --bundles "$BUNDLES" \
 && node build/fix-deb-depends.mjs src-tauri/target/release/bundle/deb/*.deb \
 && mkdir -p /out \
 && cp -a src-tauri/target/release/bundle/. /out/

# 只导出产物：宿主侧 `--output type=local,dest=...` 拿到的就是这些文件，不会把源码树吐出来。
# 拷的是 bundle 的**内容**而不是 bundle 目录本身：导出根因此直接是 deb/ rpm/ appimage/ share/，
# 与 build.sh 结尾那段平铺逻辑（把交付物拎到 releases/ 根上、删掉剩下的目录树）对齐。
FROM scratch AS export
COPY --from=build /out /
