#!/bin/bash
set -e

# ── OhMyPetBook Daemon Installer ──
# curl -fsSL https://raw.githubusercontent.com/bdhwan/ohmypetbook-daemon/master/install.sh | bash

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

info()  { echo -e "${GREEN}▸${RESET} $1"; }
warn()  { echo -e "${YELLOW}▸${RESET} $1"; }
error() { echo -e "${RED}✗${RESET} $1"; exit 1; }

echo -e "\n${BOLD}🐾 OhMyPetBook Installer${RESET}\n"

# ── 1. Node.js 확인 ──
if ! command -v node &>/dev/null; then
  error "Node.js가 필요합니다. https://nodejs.org 에서 설치하세요."
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js 18+ 필요 (현재: $(node -v))"
fi
info "Node.js $(node -v) ✓"

# ── 2. 이전 설치 정리 ──
# /usr/local/bin에 이전 wrapper가 있으면 제거 (npm 설치 경로와 충돌)
if [ -f "/usr/local/bin/ohmypetbook" ]; then
  warn "이전 설치 발견 (/usr/local/bin/ohmypetbook) — 정리합니다."
  if [ -w "/usr/local/bin/ohmypetbook" ]; then
    rm -f "/usr/local/bin/ohmypetbook"
  else
    sudo rm -f "/usr/local/bin/ohmypetbook"
  fi
  info "이전 설치 제거 완료 ✓"
fi
# 소스 기반 설치 잔여물 정리
if [ -d "$HOME/.ohmypetbook/node_modules" ]; then
  rm -rf "$HOME/.ohmypetbook/node_modules" "$HOME/.ohmypetbook/daemon.js" "$HOME/.ohmypetbook/lib" "$HOME/.ohmypetbook/package.json" 2>/dev/null || true
fi

# ── 3. npm install -g ──
info "ohmypetbook 설치 중..."
npm install -g ohmypetbook 2>&1 | tail -3
info "설치 완료 ✓"

# ── 4. 설정 디렉토리 확인 ──
mkdir -p "$HOME/.ohmypetbook"
if [ ! -f "$HOME/.ohmypetbook/ohmypetbook.json" ]; then
  echo '{"openclawPath":"'"$HOME/.openclaw"'"}' > "$HOME/.ohmypetbook/ohmypetbook.json"
  chmod 600 "$HOME/.ohmypetbook/ohmypetbook.json"
  info "기본 설정 생성: ~/.ohmypetbook/ohmypetbook.json"
fi
mkdir -p "$HOME/.openclaw"
if [ ! -f "$HOME/.openclaw/openclaw.json" ]; then
  echo '{}' > "$HOME/.openclaw/openclaw.json"
fi

# ── 5. --login 옵션 처리 ──
DO_LOGIN=false
for arg in "$@"; do
  case "$arg" in
    --login) DO_LOGIN=true ;;
  esac
done

# ── 완료 ──
echo -e "\n${BOLD}${GREEN}✓ OhMyPetBook 설치 완료!${RESET}\n"

if [ "$DO_LOGIN" = true ]; then
  echo -e "${BOLD}로그인을 시작합니다...${RESET}\n"
  ohmypetbook login
  echo ""
  echo -e "서비스 등록 (자동 시작):"
  echo -e "  ${BOLD}ohmypetbook install${RESET}"
else
  echo -e "다음 단계:"
  echo -e "  ${BOLD}1.${RESET} ohmypetbook login      — 브라우저 로그인"
  echo -e "  ${BOLD}2.${RESET} ohmypetbook install    — 서비스 등록 (자동 시작)"
fi
echo ""
echo -e "기타 명령:"
echo -e "  ohmypetbook status     — 상태 확인"
echo -e "  ohmypetbook run        — 포그라운드 실행"
echo -e "  ohmypetbook logout     — 인증 + 서비스 제거"
echo -e "  ohmypetbook uninstall  — 서비스만 제거"
echo ""
