#!/bin/bash
set -e

# ── OhMyPetBook Daemon Installer ──
# curl -fsSL https://openclaw.ai/install.sh | bash

REPO="bdhwan/ohmypetbook-daemon"
BRANCH="master"
INSTALL_DIR="$HOME/.ohmypetbook"
BIN_LINK="/usr/local/bin/ohmypetbook"

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

info()  { echo -e "${GREEN}▸${RESET} $1"; }
warn()  { echo -e "${YELLOW}▸${RESET} $1"; }
error() { echo -e "${RED}✗${RESET} $1"; exit 1; }

echo -e "\n${BOLD}🐾 OhMyPetBook Daemon Installer${RESET}\n"

# ── 1. Node.js 확인 ──
if ! command -v node &>/dev/null; then
  error "Node.js가 필요합니다. https://nodejs.org 에서 설치하세요."
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js 18+ 필요 (현재: $(node -v))"
fi
info "Node.js $(node -v) ✓"

# ── 2. 기존 설치 정리 ──
if [ -d "$INSTALL_DIR" ]; then
  warn "기존 설치 발견 — 업데이트합니다."
  # 서비스 중지 (에러 무시)
  if [ "$(uname)" = "Darwin" ]; then
    launchctl unload "$HOME/Library/LaunchAgents/com.openclaw.ohmyohmypetbook-daemon.plist" 2>/dev/null || true
  else
    systemctl --user stop ohmypetbook-daemon 2>/dev/null || true
  fi
fi

# ── 3. 다운로드 ──
info "다운로드 중..."

if command -v git &>/dev/null; then
  # git이 있으면 clone (sparse checkout으로 daemon만)
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" \
    "https://github.com/$REPO.git" "$INSTALL_DIR" 2>/dev/null
else
  # git 없으면 tarball
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "https://github.com/$REPO/archive/$BRANCH.tar.gz" | \
    tar xz --strip-components=1 -C "$INSTALL_DIR"
fi

info "다운로드 완료 → $INSTALL_DIR"

# ── 4. 의존성 설치 ──
info "의존성 설치 중..."
cd "$INSTALL_DIR"
npm install --production --silent 2>&1 | tail -1
info "의존성 설치 완료 ✓"

# ── 5. CLI 심볼릭 링크 ──
# ohmypetbook wrapper script 생성
WRAPPER="$INSTALL_DIR/ohmypetbook"
cat > "$WRAPPER" << 'WRAPPER_EOF'
#!/bin/bash
NODE=$(command -v node 2>/dev/null)
# nvm 환경이면 nvm의 node 사용
if [ -z "$NODE" ] && [ -f "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh" --no-use
  NODE=$(nvm which current 2>/dev/null)
fi
if [ -z "$NODE" ]; then
  echo "Error: Node.js not found" >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$NODE" "$SCRIPT_DIR/daemon.js" "$@"
WRAPPER_EOF
chmod +x "$WRAPPER"

# /usr/local/bin에 링크 (sudo 필요할 수 있음)
if [ -w "/usr/local/bin" ] || [ -w "$(dirname "$BIN_LINK")" ]; then
  ln -sf "$WRAPPER" "$BIN_LINK"
  info "CLI 설치: ohmypetbook ✓"
else
  sudo ln -sf "$WRAPPER" "$BIN_LINK" 2>/dev/null && \
    info "CLI 설치: ohmypetbook ✓" || \
    warn "PATH에 직접 추가하세요: export PATH=\"$INSTALL_DIR:\$PATH\""
fi

# ── 6. 설정 디렉토리 확인 ──
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

# ── 7. --login 옵션 처리 ──
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
