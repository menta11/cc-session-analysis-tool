#!/bin/sh
# 出「自带依赖」的 Linux 离线安装包：我们的 deb + 该目标发行版里运行所需的全部依赖 deb，
# 打成一个 tar.gz，附一键安装脚本。目标机全程不用联网。
#
#   用法：sh build/linux/offline-bundle.sh linux/amd64 [24.04]
#         sh build/linux/offline-bundle.sh linux/arm64 [22.04]
#
# 为什么按发行版分开：依赖名字随发行版变（24.04 做过 t64 改名，libgtk-3-0 → libgtk-3-0t64），
# 而闭包是**在目标发行版的容器里**解出来的 —— 把 jammy 的 libgtk-3-0 装进 noble 会与
# 系统里的 libgtk-3-0t64 打架。默认 24.04（当前 LTS）。
set -eu

DOCKER_PLATFORM="${1:-}"
UBUNTU_RELEASE="${2:-24.04}"
case "$DOCKER_PLATFORM" in
  linux/amd64) PACKAGE_ARCH=x86_64 ;;
  linux/arm64) PACKAGE_ARCH=aarch64 ;;
  *)
    echo "用法: $0 <linux/amd64|linux/arm64> [ubuntu 版本，如 24.04]" >&2
    exit 2
    ;;
esac

case "$UBUNTU_RELEASE" in
  24.04 | 24.10 | 25.04 | 25.10) GTK_PACKAGE=libgtk-3-0t64 ;;
  *) GTK_PACKAGE=libgtk-3-0 ;;
esac
# 与 tauri.conf.json 里那三个依赖同源（候选见 build/fix-deb-depends.mjs）：
# webkit 与 ayatana 两个包名各版本一致，只有 gtk 需要按发行版挑。
RUNTIME_PACKAGES="libwebkit2gtk-4.1-0 $GTK_PACKAGE libayatana-appindicator3-1"

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
CACHE_DIR="$REPO_ROOT/build/linux/.cache/deb-runtime/$UBUNTU_RELEASE/$PACKAGE_ARCH"

echo "==> 解析 $UBUNTU_RELEASE 的运行时闭包（${PACKAGE_ARCH}）：$RUNTIME_PACKAGES"
if [ -f "$CACHE_DIR/.prefetched" ]; then
  echo "    已在本地，跳过（要重解就删 ${CACHE_DIR}）"
else
  # 清掉宿主注入的代理：容器里的 127.0.0.1 指向它自己（同 build.sh 的说明）。
  # shellcheck disable=SC2086
  docker buildx build \
    --platform "$DOCKER_PLATFORM" \
    --target export-deb-runtime \
    --output "type=local,dest=$CACHE_DIR" \
    --file "$REPO_ROOT/build/linux/Dockerfile" \
    --build-arg "BASE_IMAGE=ubuntu:$UBUNTU_RELEASE" \
    --build-arg "DEB_RUNTIME_PACKAGES=$RUNTIME_PACKAGES" \
    --build-arg http_proxy= \
    --build-arg https_proxy= \
    --build-arg HTTP_PROXY= \
    --build-arg HTTPS_PROXY= \
    "$REPO_ROOT"
  touch "$CACHE_DIR/.prefetched"
fi

echo "==> 组装离线包"
node "$REPO_ROOT/build/offline-deb-bundle.mjs" "$PACKAGE_ARCH" "$UBUNTU_RELEASE" "$CACHE_DIR/debs"

echo "==> 完成"
