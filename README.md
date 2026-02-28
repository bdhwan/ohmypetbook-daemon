# 🐾 OhMyPetBook

OpenClaw 디바이스 동기화 데몬. 각 디바이스를 하나의 "pet"으로 등록하고, Firestore를 통해 설정/환경변수/워크스페이스를 실시간 동기화합니다.

## 설치

### npm (권장)

```bash
npm install -g ohmypetbook
```

### 원라인 설치

```bash
# 설치 + 로그인
curl -fsSL https://ohmypetbook.com/install.sh | bash -s -- --login

# 설치만
curl -fsSL https://ohmypetbook.com/install.sh | bash
```

## 사용법

```bash
# 로그인 (브라우저 인증)
ohmypetbook login

# 서비스 등록 (자동 시작)
ohmypetbook install

# 포그라운드 실행
ohmypetbook run

# 상태 확인
ohmypetbook status

# 설정 확인/변경
ohmypetbook config
ohmypetbook config set openclawPath /path/to/.openclaw

# 서비스 제거
ohmypetbook uninstall

# 로그아웃 (인증 + 서비스 제거)
ohmypetbook logout
```

## 동작 방식

1. `ohmypetbook login` → 브라우저가 열리고 로그인/승인
2. 디바이스가 `users/{uid}/pets/{petId}`에 등록됨
3. `~/.openclaw/openclaw.json`, `~/.openclaw/workspace/` 파일을 Firestore와 실시간 동기화
4. 브라우저([ohmypetbook.com](https://ohmypetbook.com))에서 설정 편집 가능
5. 환경변수/시크릿 변경 시 `~/.openclaw/.env`에 반영 후 게이트웨이 자동 재시작

## 보안

- `openclaw.json`은 **암호화**되어 Firestore에 저장 (AES-256-GCM)
- 시크릿은 서버사이드 암호화, `.env`에만 평문 저장 (chmod 600)
- 암호화 키는 90일마다 자동 로테이션
- Firebase Auth로 본인 인증, Firestore Rules로 접근 제어

## 요구사항

- Node.js 18+
- [OpenClaw](https://openclaw.ai) 설치됨

## 라이선스

MIT
