#!/bin/sh
# 在容器里为指定 Linux 架构产出 deb / rpm，平铺落到 releases/。
#
#   用法：sh build/linux/build.sh linux/amd64
#         sh build/linux/build.sh linux/arm64
#
# 两个架构走同一个 Dockerfile，只是 --platform 不同。产物名里本来就带架构串（各格式按自己的
# 习惯：deb/appimage 用 amd64、rpm 用 x86_64），所以两个架构可以同放一个目录、不会互相覆盖。
#
# 分三步，只有前两步联网，且都幂等：
#   1. 宿主预取   —— npm 的 linux 原生包、两个三元组的 crate 源码与 rust 工具链、node tarball
#   2. apt 预取   —— 该架构的 .deb 包体与索引（依赖解析只有 apt 会做，故借一次性容器）
#   3. 构建       —— 零下载：apt 用本地包体装（--no-download），其余全部来自第 1、2 步
# 第 3 步可以 OFFLINE=1 断网跑，用来证明「构建不下载」—— 那是判据，不是省事开关。
#
# ⚠️ 中文紧跟变量时必须写 ${VAR}：非 UTF-8 locale 下 shell 会把全角字符的高位字节当成变量名的
# 一部分，`${VAR}（` 直接被解析成变量名 `VAR?`，set -u 下报 unbound variable（本项目已踩两次）。
set -eu

DOCKER_PLATFORM="${1:-}"
case "$DOCKER_PLATFORM" in
  linux/amd64) PACKAGE_ARCH=x86_64 ;;
  linux/arm64) PACKAGE_ARCH=aarch64 ;;
  *)
    echo "用法: $0 <linux/amd64|linux/arm64>" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/releases"
CACHE_DIR="$REPO_ROOT/build/linux/.cache"

echo "==> [$PACKAGE_ARCH] 1/3 宿主预取（幂等，只在清单变化时才下载）"
node "$REPO_ROOT/build/linux/prefetch.mjs"

# 宿主已有的包体仓库，作为命名上下文传给 Dockerfile 去灌构建缓存：
#   npm 的 cacache 与 cargo 的 .crate 都是平台无关的压缩包，本机这两份缓存里已经有本项目
#   lockfile 要的全部内容（npm 51 MB、cargo 包体 92 MB + sparse 索引 41 MB）。
# 源的身份必须与宿主一致才命中（cacache 按 URL 做键、cargo 按 registry 哈希分目录）：
# 故容器里沿用宿主的 npm 源，且 cargo 不配源替换。目录不存在就先建空的 —— 灌进去是空的，
# 就会在阶段 3 暴露成缺包，而不是让构建静默地联网取。
NPM_CACHE_DIR="$(npm config get cache)"
CARGO_REGISTRY_DIR="$HOME/.cargo/registry"
mkdir -p "$NPM_CACHE_DIR" "$CARGO_REGISTRY_DIR/cache" "$CARGO_REGISTRY_DIR/index"

# 清掉宿主注入的代理：~/.docker/config.json 里的 proxies 会被 docker 注入进每个 RUN，
# 而它写的是宿主 127.0.0.1:7897 —— 容器里的 127.0.0.1 指向容器自身，装了就全断
# （实测 apt 报 `Unable to connect to 127.0.0.1:7897`，而同一容器里直连是通的）。
# 镜像全程走国内源，不需要代理；空值即清空（实测有效），Dockerfile 里写 ENV 覆盖不掉注入。
PROXY_OFF_ARGS="--build-arg http_proxy= --build-arg https_proxy= --build-arg HTTP_PROXY= --build-arg HTTPS_PROXY="

# 不指定 --builder：用当前 builder（本机是 orbstack 的 docker 驱动，实测它同时支持
# cache mount 与 type=local）。换成 docker-container 驱动反而会挂 —— 那种 builder 自己
# 去 registry 拉基础镜像，实测连不上 auth.docker.io（connection reset）。
APT_CACHE_DIR="$CACHE_DIR/apt/$PACKAGE_ARCH"
if [ -f "$APT_CACHE_DIR/.prefetched" ]; then
  echo "==> [$PACKAGE_ARCH] 2/3 apt 包体已在本地，跳过"
else
  echo "==> [$PACKAGE_ARCH] 2/3 预取 apt 包体与索引"
  # shellcheck disable=SC2086
  docker buildx build $PROXY_OFF_ARGS \
    --platform "$DOCKER_PLATFORM" \
    --target export-apt \
    --output "type=local,dest=$APT_CACHE_DIR" \
    --file "$REPO_ROOT/build/linux/Dockerfile" \
    "$REPO_ROOT"
  # marker 在导出成功之后才写：导不出来就不会留下「已完成」的假象。
  touch "$APT_CACHE_DIR/.prefetched"
fi

# 工具链镜像：apt 装 450 个包 + node + rust 都在这一步，装好打 tag 长期复用。
# 它只认 Dockerfile 的 toolchain 阶段与三个预取目录为输入，所以改源码、改出包阶段都不碰它。
#
# OFFLINE=1 时这一步是**强制重建**（--no-cache-filter 让它真的重跑，而不是命中缓存）：
# 否则断网判据只盖住了出包阶段，装包那一步就溜出判据之外了。
TOOLCHAIN_IMAGE="${TOOLCHAIN_IMAGE:-ccsa-linux-toolchain}:$PACKAGE_ARCH"
if [ "${OFFLINE:-0}" = "1" ]; then
  echo "==> [$PACKAGE_ARCH] 2/3 断网重建工具链镜像 ${TOOLCHAIN_IMAGE}（判据要盖住装包这一步）"
  set -- --network=none --no-cache-filter=toolchain
elif docker image inspect "$TOOLCHAIN_IMAGE" >/dev/null 2>&1; then
  echo "==> [$PACKAGE_ARCH] 2/3 工具链镜像已存在，跳过（要重建就 docker rmi ${TOOLCHAIN_IMAGE}）"
  set --
else
  echo "==> [$PACKAGE_ARCH] 2/3 造工具链镜像 $TOOLCHAIN_IMAGE"
  set --
fi

# shellcheck disable=SC2086
docker buildx build $PROXY_OFF_ARGS \
  --platform "$DOCKER_PLATFORM" \
  --target toolchain \
  "$@" \
  --load \
  --tag "$TOOLCHAIN_IMAGE" \
  --file "$REPO_ROOT/build/linux/Dockerfile" \
  --build-context "apt-cache=$APT_CACHE_DIR" \
  --build-context "rust-tarballs=$CACHE_DIR/rust/$PACKAGE_ARCH" \
  --build-context "node-tarballs=$CACHE_DIR/node" \
  "$REPO_ROOT"

echo "==> [$PACKAGE_ARCH] 3/3 构建（容器内零下载）"
if [ "${OFFLINE:-0}" = "1" ]; then
  echo "    已开启 OFFLINE：给容器断网，任何联网尝试都会当场失败"
  set -- --network=none
else
  set --
fi

# type=local 只导出 Dockerfile 里 export 阶段的 /out，即安装包本身。
# 不加 --load：这里不需要镜像，落盘的是文件。
# BUNDLES 默认 deb,rpm：AppImage 的 linuxdeploy 工具由 tauri 打包器每次从 GitHub 现下
# （解到 /tmp，无缓存能力），要出它就得放弃「构建零下载」，故不放进默认值。
# 工具链现在来自镜像，所以 apt/node/rust 三个预取目录不必再挂进来。
# shellcheck disable=SC2086
docker buildx build $PROXY_OFF_ARGS \
  --platform "$DOCKER_PLATFORM" \
  --target export \
  "$@" \
  --output "type=local,dest=$OUT_DIR" \
  --file "$REPO_ROOT/build/linux/Dockerfile" \
  --build-arg "BUNDLES=${BUNDLES:-deb,rpm}" \
  --build-arg "TOOLCHAIN_IMAGE=$TOOLCHAIN_IMAGE" \
  --build-context "npm-cache=$NPM_CACHE_DIR" \
  --build-context "cargo-cache=$CARGO_REGISTRY_DIR/cache" \
  --build-context "cargo-index=$CARGO_REGISTRY_DIR/index" \
  "$REPO_ROOT"

# type=local 导出的是整棵 bundle 树（deb/ rpm/ appimage/ 各一层 + Tauri 自带的 share/），
# 而 releases/ 只放平铺的交付物 —— 把包拎到根上，剩下的目录树（含 share/ 这类制作素材）删掉。
# 只删这几个**已知的 bundle 目录名**，不用「删掉所有子目录」那种写法：releases/ 里可能还躺着
# mac 的 `X.app`（它本身是个目录），一刀切会把它连根删掉。
echo "==> 展平到 releases/"
find "$OUT_DIR" -mindepth 2 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) \
  -exec mv {} "$OUT_DIR/" \;
rm -rf "$OUT_DIR/deb" "$OUT_DIR/rpm" "$OUT_DIR/appimage" "$OUT_DIR/share"

echo "==> 产物"
find "$OUT_DIR" -maxdepth 1 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) \
  -exec ls -lh {} \;

# 校验一次包的 Architecture 字段：bundler 按目标三元组推这个值，推错不会报错、只会静默
# 出一个装不上的包（历史上就出过「包里装的是 proxy-standalone」这类静默错包）。
# dpkg-deb 只解析 ar/tar，不执行包内代码，所以容器架构与包架构无关。
echo "==> 校验 Architecture"
docker run --rm -v "$OUT_DIR:/out:ro" --platform "$DOCKER_PLATFORM" ubuntu:22.04 \
  sh -c 'for f in /out/*.deb; do printf "%s: " "$(basename "$f")"; dpkg-deb -f "$f" Architecture; done'

echo "==> 完成"
