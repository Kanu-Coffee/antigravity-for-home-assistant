<p align="right">
  <strong>한국어</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="antigravity_home_assistant/logo.png" alt="Antigravity for Home Assistant 로고" width="180">
</p>

<h1 align="center">Antigravity for Home Assistant</h1>

<p align="center">
  HAOS 안에서 Google Antigravity Remote를 실행해<br>
  브라우저로 Home Assistant 프로젝트를 관리하는 실험 단계 App입니다.
</p>

<p align="center">
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Kanu-Coffee/antigravity-for-home-assistant?include_prereleases"></a>
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml"><img alt="CI" src="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml/badge.svg"></a>
  <img alt="Architecture: amd64 and aarch64" src="https://img.shields.io/badge/architecture-amd64%20%7C%20aarch64-blue">
  <img alt="Stage: experimental" src="https://img.shields.io/badge/stage-experimental-orange">
</p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fantigravity-for-home-assistant"><img alt="Home Assistant에 App 저장소 추가" src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg"></a>
</p>

> [!WARNING]
> 이 App은 `/config` 쓰기 권한과 Home Assistant Core·Supervisor 관리자급 API
> 권한을 사용합니다. 신뢰하는 관리자만 설치하고, 중요한 변경 전에는 Home
> Assistant backup과 Antigravity의 계획·diff를 직접 확인하세요.

<!-- separate admonitions -->

> [!CAUTION]
> **3.0.0으로 처음 시작하면 App이 소유한 모든 2.x 런타임 데이터를 backup 없이
> 한 번 초기화합니다.** `/config`, `/share`, `/media`는 삭제하지 않지만 Antigravity,
> Remote, GitHub, 브라우저 identity와 로컬 memory는 다시 설정해야 합니다.
> 업그레이드 전에 [3.0 전환 안내](antigravity_home_assistant/DOCS.md#300-전환)를
> 반드시 확인하세요.

## 핵심 기능

- 공식 [Antigravity Remote Control](https://antigravity.google/docs/remote-control/)을
  통한 작업 시작, 진행 확인, 입력·승인과 결과 검토
- `/config`, `/share`, `/media` 안의 프로젝트 작업과 Home Assistant 설정 검사
- credential을 모델에 전달하지 않는 제한된 Core·Supervisor 읽기 helper
- 데스크톱·모바일 dashboard를 검사하는 관리형 headless browser
- 사용자가 명시하거나 검증한 Home Assistant 문맥만 저장하는 로컬 memory
- 앱 문제와 기능 요청을 읽기 전용으로 조사하는 `/ha-feedback`
- HA 내부 복구와 최초 인증을 위한 Ingress 터미널

Remote daemon은 App 내부 loopback에서만 실행됩니다. 외부 포트를 열지 않으며,
브라우저에서는 같은 Google 계정으로
[Remote Control Dashboard](https://antigravity.google.com/)에 로그인합니다.

## 빠른 시작

1. Home Assistant에서 **설정 → Apps → App store → Repositories**를 열고 다음 URL을
   추가합니다.

   ```text
   https://github.com/Kanu-Coffee/antigravity-for-home-assistant
   ```

2. **Antigravity for Home Assistant**를 설치하고 시작합니다.
3. **OPEN WEB UI**를 열어 다음 일회성 인증 helper를 실행합니다.

   ```bash
   ha-antigravity-remote-login
   ```

4. 표시된 URL을 열고 인증 code를 붙여 넣은 뒤 같은 Google 계정으로 로그인을
   완료합니다. 인증 자료를 로그나 이슈에 복사하지 마세요.
5. 서비스가 인증을 감지하면 Remote daemon을 자동으로 시작합니다. App을 재시작할
   필요가 없으며, 이후 HAOS 재부팅 뒤에도 자동으로 다시 시작됩니다.
6. [Remote Control Dashboard](https://antigravity.google.com/)에서 기본 instance
   `home-assistant`를 선택하고 새 작업을 시작합니다.

인증 전에도 App은 실패하지 않고 Ingress를 제공합니다. instance가 보이지 않으면
Ingress에서 인증 상태와 App 로그를 확인한 뒤 helper를 다시 실행하세요.

## 설정

3.0의 공개 설정은 네 개뿐입니다.

```yaml
remote_control_name: home-assistant
antigravity_sensitive_data_access: false
home_assistant_browser_auto_auth: true
log_level: info
```

자세한 설치, 3.0 초기화, 보안 경계와 문제 해결은
[한국어 사용 설명서](antigravity_home_assistant/DOCS.md)를 확인하세요.
[English guide](antigravity_home_assistant/DOCS.en.md)도 제공합니다.

## 상태와 지원

이 프로젝트는 `experimental`입니다. source·container·emulated architecture 검증은
실제 HAOS 증거가 아니며, 수행하지 않은 실기 결과는 `NOT RUN`으로 유지합니다.
문제 보고 전 [지원 안내](SUPPORT.md)를 확인하세요.

비공식 커뮤니티 프로젝트이며 Google 또는 Home Assistant/Nabu Casa와 제휴하거나
보증받은 제품이 아닙니다.
