#!/bin/bash
set -e

# ── OhMyPetBook Installer ──
# curl -fsSL https://raw.githubusercontent.com/bdhwan/ohmypetbook-daemon/master/install.sh | bash -s -- --login

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

# ── 2. 기존 install.sh 방식 정리 ──
OLD_INSTALL="$HOME/.ohmypetbook"
if [ -f "$OLD_INSTALL/daemon.js" ] && [ -d "$OLD_INSTALL/lib" ]; then
  warn "기존 git 설치 발견 — npm 방식으로 전환합니다."
  # 설정 파일은 보존, 소스만 삭제
  rm -rf "$OLD_INSTALL/daemon.js" "$OLD_INSTALL/lib" "$OLD_INSTALL/node_modules" \
         "$OLD_INSTALL/package.json" "$OLD_INSTALL/package-lock.json" \
         "$OLD_INSTALL/.git" "$OLD_INSTALL/ohmypetbook" "$OLD_INSTALL/install.sh" \
         "$OLD_INSTALL/openclaw.json" "$OLD_INSTALL/LICENSE" "$OLD_INSTALL/.gitignore"
  info "기존 소스 정리 완료 (설정 파일 보존)"
fi

# 기존 wrapper symlink 제거
if [ -L "/usr/local/bin/ohmypetbook" ]; then
  sudo rm -f /usr/local/bin/ohmypetbook 2>/dev/null || rm -f /usr/local/bin/ohmypetbook 2>/dev/null
fi

# ── 3. npm global 설치 ──
info "npm install -g ohmypetbook@latest..."
npm install -g ohmypetbook@latest 2>&1 | tail -3
info "설치 완료 ✓"

# ohmypetbook 명령어 경로 확인
NPM_BIN=$(npm prefix -g)/bin
if command -v ohmypetbook &>/dev/null; then
  info "CLI: $(which ohmypetbook) (v$(ohmypetbook --version 2>/dev/null || echo '?'))"
elif [ -f "$NPM_BIN/ohmypetbook" ]; then
  warn "ohmypetbook이 PATH에 없습니다. 아래를 .bashrc에 추가하세요:"
  echo -e "  export PATH=\"$NPM_BIN:\$PATH\""
  export PATH="$NPM_BIN:$PATH"
fi

# bash 해시 캐시 초기화
hash -r 2>/dev/null || true

# ── 4. 설정 디렉토리 확인 ──
mkdir -p "$HOME/.ohmypetbook"
if [ ! -f "$HOME/.ohmypetbook/ohmypetbook.json" ]; then
  echo '{"openclawPath":"'"$HOME/.openclaw"'"}' > "$HOME/.ohmypetbook/ohmypetbook.json"
  chmod 600 "$HOME/.ohmypetbook/ohmypetbook.json"
  info "기본 설정 생성: ~/.ohmypetbook/ohmypetbook.json ✓"
fi
mkdir -p "$HOME/.openclaw"
if [ ! -f "$HOME/.openclaw/openclaw.json" ]; then
  echo '{}' > "$HOME/.openclaw/openclaw.json"
fi

# ── 5. 로그인 + 서비스 등록 ──
CONFIG_FILE="$HOME/.ohmypetbook/ohmypetbook.json"
ALREADY_LOGGED_IN=false
if [ -f "$CONFIG_FILE" ] && command -v node &>/dev/null; then
  HAS_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));console.log(c.token?'yes':'no')}catch{console.log('no')}" 2>/dev/null)
  [ "$HAS_TOKEN" = "yes" ] && ALREADY_LOGGED_IN=true
fi

echo -e "\n${BOLD}${GREEN}✓ OhMyPetBook 설치 완료!${RESET}\n"

if [ "$ALREADY_LOGGED_IN" = true ]; then
  info "이미 로그인되어 있습니다."
  info "서비스 등록 중..."
  ohmypetbook install
else
  DO_LOGIN=false
  for arg in "$@"; do
    [ "$arg" = "--login" ] && DO_LOGIN=true
  done
  if [ "$DO_LOGIN" = false ] && [ -t 0 ]; then
    echo -ne "지금 바로 로그인하시겠습니까? [Y/n] "
    read -r REPLY
    [ -z "$REPLY" ] || [ "$REPLY" = "y" ] || [ "$REPLY" = "Y" ] && DO_LOGIN=true
  fi

  if [ "$DO_LOGIN" = true ]; then
    echo -e "${BOLD}로그인을 시작합니다...${RESET}\n"
    ohmypetbook login
    echo ""
    info "서비스 등록 중..."
    ohmypetbook install
  else
    echo -e "다음 단계:"
    echo -e "  ${BOLD}1.${RESET} ohmypetbook login      — 로그인"
    echo -e "  ${BOLD}2.${RESET} ohmypetbook install    — 서비스 등록 (자동 시작)"
  fi
fi

echo ""
echo -e "기타 명령:"
echo -e "  ohmypetbook status     — 상태 확인"
echo -e "  ohmypetbook run        — 포그라운드 실행"
echo -e "  ohmypetbook logout     — 인증 + 서비스 제거"
echo -e "  ohmypetbook uninstall  — 서비스만 제거"
echo ""
