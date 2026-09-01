<p align="right">
  <strong>한국어</strong> · <a href="README.en.md">English</a>
</p>

# Antigravity for Home Assistant

HAOS 안에서 Google Antigravity Remote daemon을 실행하는 Home Assistant App입니다.
외부에서는 공식 Remote Control Dashboard로 작업하고, Ingress 터미널은 최초 인증과
복구에 사용합니다.

## 주요 기능

- `/config`, `/share`, `/media` 프로젝트에 접근하는 Antigravity
- Home Assistant 설정 검사와 제한된 Core·Supervisor helper
- dashboard의 desktop/mobile 화면과 console/network를 검사하는 관리형 browser
- 명시적 사실과 검증된 Home Assistant 문맥을 보존하는 로컬 memory
- `/ha-feedback`을 통한 읽기 전용 버그 조사와 기능 제안 작성
- 외부 포트를 공개하지 않는 loopback Remote daemon

> [!WARNING]
> 이 App은 Home Assistant 설정을 직접 변경할 수 있는 관리자 도구입니다. Remote
> 계정과 browser session을 Home Assistant 관리자 credential처럼 보호하고, 변경 전
> backup·계획·diff를 확인하세요.

<!-- separate admonitions -->

> [!CAUTION]
> 3.0.0의 첫 시작은 App 소유 2.x runtime data를 backup 없이 한 번 삭제합니다.
> `/config`, `/share`, `/media`는 보존되지만 인증, browser identity, memory와
> customization은 다시 만들어야 합니다. 자세한 대상은
> [3.0 전환 안내](DOCS.md#300-전환)를 확인하세요.

## 시작하기

1. App을 설치하고 시작합니다.
2. **OPEN WEB UI**에서 다음 helper를 실행합니다.

   ```bash
   ha-antigravity-remote-login
   ```

3. 표시된 URL과 code로 Google 인증을 완료하고 helper의 완료 메시지를 기다립니다.
   서비스가 인증용 프로세스를 완전히 종료한 뒤 Remote를 자동으로 시작하므로 App
   재시작은 필요하지 않습니다.
4. [Antigravity Remote Control Dashboard](https://antigravity.google.com/)에 같은
   계정으로 로그인하고 `home-assistant` instance와 `/config`의 새/default project를
   선택합니다.

인증이 없으면 Remote만 대기하고 Ingress는 계속 사용할 수 있습니다. 이름을 바꾸려면
`remote_control_name`을 설정한 뒤 App을 재시작하세요.

```yaml
remote_control_name: home-assistant
antigravity_sensitive_data_access: false
home_assistant_browser_auto_auth: true
log_level: info
```

설치, 설정, 보안과 문제 해결은 [한국어 사용 설명서](DOCS.md)를 확인하세요.
[English guide](DOCS.en.md)도 제공합니다.

이 프로젝트는 `experimental`입니다. 자동 test는 실제 HAOS 동작의 대체 증거가
아니며, 수행하지 않은 실기 검증은 `NOT RUN`입니다. 사용자가 제공한 3.0.0 실운영
읽기 전용 자기점검 7개 항목은 모두 `PASS`였지만 architecture와 image digest가 없어
3.0.2의 architecture별 승인 증거로 확대하지 않습니다.
