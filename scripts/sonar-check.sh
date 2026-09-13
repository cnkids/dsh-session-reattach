#!/usr/bin/env bash
# SonarQube 扫描入口
#
# 用法：
#   ./scripts/sonar-check.sh            # 分支自动取当前 git 分支
#   ./scripts/sonar-check.sh main       # 显式指定分支
#
# 为什么要有这个脚本（而不是裸跑 sonar-scanner）：
#   - token：优先用本项目专用变量 SONAR_TOKEN_DSH_SESSION_REATTACH，未设置时回退通用
#     SONAR_TOKEN。机器上并存多个项目的 token，写死通用的那个会拿错项目的权限。
#   - 分支：不带 sonar.branch.name 时，SonarQube 会把结果写进项目的**主分支**；
#     在别的分支上开发时这样会覆盖主分支数据。
#   - 版本：从 package.json 取，保证每次扫描都上报版本号。
#
# 前置：先跑 `npm run coverage` 生成 coverage/lcov.info，否则覆盖率是空的。
set -euo pipefail

cd "$(dirname "$0")/.."

BRANCH="${1:-${SONAR_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}}"
# 仓库还没有首个提交时 git 解析不出分支名，按主分支处理
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  BRANCH="main"
fi

APP_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
if [ -z "$APP_VERSION" ]; then
  echo "无法从 package.json 解析版本号" >&2
  exit 1
fi

if [ -n "${SONAR_TOKEN_DSH_SESSION_REATTACH:-}" ]; then
  export SONAR_TOKEN="$SONAR_TOKEN_DSH_SESSION_REATTACH"
fi
if [ -z "${SONAR_TOKEN:-}" ]; then
  echo "提示：未设置 SONAR_TOKEN_DSH_SESSION_REATTACH / SONAR_TOKEN，若服务端要求鉴权会扫描失败" >&2
fi

if [ ! -f coverage/lcov.info ]; then
  echo "提示：coverage/lcov.info 不存在，覆盖率会是空的 —— 先跑 npm run coverage" >&2
fi

ARGS=("-Dsonar.projectVersion=${APP_VERSION}")
if [ "$BRANCH" = "main" ]; then
  echo "SonarQube 扫描：分支=${BRANCH}（主分支） 版本=${APP_VERSION}"
else
  ARGS+=("-Dsonar.branch.name=${BRANCH}")
  echo "SonarQube 扫描：分支=${BRANCH} 版本=${APP_VERSION}"
fi

exec sonar-scanner "${ARGS[@]}"
