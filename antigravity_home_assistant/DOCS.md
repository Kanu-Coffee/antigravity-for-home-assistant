<p align="right">
  <strong>한국어</strong> · <a href="DOCS.en.md">English</a>
</p>

# Antigravity for Home Assistant 사용 설명서

이 App은 HAOS 안에서 Google Antigravity Remote daemon을 실행합니다. 평소 작업은
브라우저의 공식 Remote Control Dashboard에서 하고, Home Assistant Ingress 터미널은
최초 인증·진단·복구에 사용합니다.

> [!WARNING]
> Antigravity는 `/config`를 읽고 쓸 수 있으며 제한된 Home Assistant 관리자 API를
> 사용합니다. Remote에 로그인한 Google 계정과 browser session을 관리자
> credential처럼 보호하세요. 중요한 변경 전에는 Home Assistant backup을 만들고
> 계획과 diff를 검토하세요.

## 요구사항과 설치

- Supervisor가 있는 Home Assistant OS 또는 Supervised 설치
- `amd64` 또는 `aarch64`
- 인터넷 연결과 Antigravity를 사용할 Google 계정

1. **설정 → Apps → App store → Repositories**에서 다음 저장소를 추가합니다.

   ```text
   https://github.com/Kanu-Coffee/antigravity-for-home-assistant
   ```

2. **Antigravity for Home Assistant**를 설치하고 시작합니다.
3. **OPEN WEB UI**를 엽니다. 이 Ingress 터미널은 Home Assistant 인증 뒤에만
   접근할 수 있습니다.
4. 다음 helper를 실행합니다.

   ```bash
   ha-antigravity-remote-login
   ```

5. helper가 표시한 HTTPS URL을 신뢰하는 browser에서 열고, 같은 Google 계정으로
   로그인한 뒤 표시된 code를 터미널에 붙여 넣습니다. 인증 파일이나 code를 로그,
   screenshot 또는 issue에 남기지 마세요.
6. helper의 인증 완료 메시지까지 기다립니다. 실행 중인 service는 인증용 프로세스가
   완전히 종료된 뒤 Remote를 자동으로 시작하므로 App을 재시작할 필요가 없습니다.
7. [Remote Control Dashboard](https://antigravity.google.com/)에 같은 계정으로
   로그인하고 기본 instance `home-assistant`와 `/config`의 새/default project를
   선택합니다.

Remote는 작업 시작, 진행 확인, plan·artifact 검토, 사용자 입력과 승인을 지원합니다.
모바일 browser에서는 dashboard를 홈 화면에 설치하고 Antigravity가 제공하는 알림을
사용할 수도 있습니다. 자세한 upstream 동작은
[공식 Remote Control 문서](https://antigravity.google/docs/remote-control/)를
확인하세요.

인증이 없거나 만료되어도 App 전체가 실패하지 않습니다. Remote는 대기하고 Ingress는
계속 열리므로 helper를 다시 실행할 수 있습니다. HAOS 재부팅 뒤 App과 Remote daemon은
자동으로 다시 시작됩니다.

## 설정

3.0은 다음 네 개의 공개 option만 제공합니다.

| Option | 기본값 | 의미 |
| --- | --- | --- |
| `remote_control_name` | `home-assistant` | Remote Dashboard에 표시할 instance 이름 |
| `antigravity_sensitive_data_access` | `false` | Recorder DB를 읽기 전용 진단 profile에서만 읽도록 허용 |
| `home_assistant_browser_auto_auth` | `true` | App 전용 local read-only dashboard identity 관리 |
| `log_level` | `info` | App service 로그 수준 |

`remote_control_name`은 영문 소문자·숫자·`-`로 이루어진 1–63자 이름을 사용하고,
첫 글자와 마지막 글자는 영문 소문자 또는 숫자로 지정하세요. option을 바꾼 뒤 App을
재시작합니다.

`antigravity_sensitive_data_access`는 일반 권한을 높이거나 Recorder 쓰기를 허용하지
않습니다. 문제 진단에 꼭 필요할 때만 잠시 켜고, 결과에 개인 정보가 포함될 수 있다고
가정하세요.

## 작업 공간과 도구

기본 workspace는 `/config`입니다. `/share`와 `/media`도 App 안에서 접근할 수
있습니다. Antigravity에는 Home Assistant용 image-managed plugin이 제공되며 다음
기능을 포함합니다.

- 현재 state, service, registry, trace와 제한된 로그·시스템 정보 읽기
- `ha-config-check`와 검증 helper
- 일반 프로젝트 파일의 bounded read/write
- dashboard browser 검사
- 검증형 memory
- `/ha-feedback` 보고서 준비

먼저 읽기와 계획만 요청하고, 변경 전에 diff와 검증 방법을 확인하는 사용법을
권장합니다. 예시는 [프롬프트 예시](../docs/examples.ko.md)를 참고하세요.

### Dashboard browser

`home_assistant_browser_auto_auth: true`이면 App은 browser 전용 local read-only
Home Assistant identity를 만들거나 재사용합니다. 이 identity는 일반 사용자 계정이나
Remote Google 계정을 대신하지 않습니다.

```bash
ha-browser-auth-status
ha-browser-auth-remove
```

option을 끄면 다음 browser session부터 일반 Home Assistant login 화면이 나타납니다.
기존 managed identity를 삭제하려면 `ha-browser-auth-remove`를 실행합니다. screenshot,
console, network와 화면 안의 entity 상태는 민감할 수 있으므로 공개 보고서에 그대로
첨부하지 마세요.

### 검증형 memory

memory는 `/data/antigravity-ha-memory/memory.sqlite3`에 저장됩니다. 현재 state와
로그를 자동으로 장기 기억하지 않습니다. 사용자가 명시한 별칭·용도·선호 또는 근거로
검증된 Home Assistant 구조만 후보 → 검증 → 적용 흐름으로 보존합니다.

```bash
ha-memory status
ha-memory search 'kitchen'
```

`empty`, `stale`, `degraded`는 서로 다른 상태입니다. 문제가 있으면 먼저 status를
확인하고 App log와 같은 시각의 Core 상태를 함께 조사하세요.

### Feedback

앱 문제나 기능 요청은 Remote task 또는 Ingress에서 `/ha-feedback`을 사용합니다.
최초 요청은 읽기 전용 조사와 공개 가능한 보고서 작성만 승인하며, 외부 제출까지
승인하지 않습니다.

```text
/ha-feedback bug 재현되는 증상과 영향을 한두 문장으로 설명
/ha-feedback feature 필요한 동작과 사용 사례를 한두 문장으로 설명
```

생성된 보고서에서 개인 정보와 credential이 제거되었는지 직접 확인하세요. 보안 문제로
판정되면 공개 검색과 제출을 중단하고
[비공개 취약점 신고](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/security/advisories/new)를
사용합니다.

## 권한과 보안

Antigravity native fine-grained permissions가 작업 승인 UI의 단일 기준입니다. 규칙은
`deny > ask > allow` 순서로 적용됩니다. `ask` 작업은 Remote에서 사용자 결정을
기다리며, App은 별도의 채널별 승인 protocol을 만들지 않습니다. native permission은
[공식 permissions 문서](https://antigravity.google/docs/cli/permissions/)에서
검토할 수 있습니다.

AppArmor는 native 승인과 별개의 최종 OS 경계입니다. 다음은 설정으로 해제할 수
없습니다.

- Home Assistant `secrets.yaml`, `.storage`, backup·SSL과 credential 경로 보호
- Google OAuth, App runtime token, browser token과 private key의 모델 접근 차단
- Recorder DB와 Home Assistant database 쓰기 차단
- Docker socket, host root/PID namespace와 보호 mode 해제 금지
- symlink·hardlink·범위 밖 경로를 이용한 broker 우회 차단

Supervisor token은 root 소유 runtime 경로에 있고 scoped helper만 사용합니다. 일반
Antigravity model process, browser와 memory process에는 token을 전달하지 않습니다.
API helper는 필요한 결과만 크기 제한·redaction 후 반환합니다.

Remote daemon은 App 내부 `127.0.0.1`의 `4400–4499` 중 빈 port 하나에 bind합니다.
Home Assistant에 외부 Remote port를 publish하지 않습니다. Ingress 역시 Home Assistant
인증 뒤의 복구 surface이며 일반 외부 제어 채널이 아닙니다.

## 3.0.0 전환

3.0.0은 의도적인 breaking upgrade입니다. 첫 시작 때 고정된 App 소유 경로를
**backup 없이 한 번** 초기화합니다.

삭제 대상은 정확히 다음과 같습니다.

```text
/data/home
/data/antigravity
/data/antigravity-ha
/data/antigravity-ha-memory
/data/browser-auth
/data/github-cli
/data/ssh
/data/tmux
```

다음은 삭제하지 않습니다.

- `/config`, `/share`, `/media`
- `/data/options.json` 파일 자체
- Home Assistant Core data와 다른 App data

Supervisor option은 새 네 개의 기본값으로 정규화되어 폐기된 option을 제거합니다.
Supervisor 요청을 일시적으로 사용할 수 없으면 runtime은 네 기본값만 사용하고 다음
시작에서 option 정규화를 다시 시도합니다. data 초기화가 끝나면 marker를 원자적으로
기록하며, 중단되면 다음 시작에서 같은 고정
대상을 안전하게 다시 처리합니다. 대상이 symlink이거나 예상 ownership과 다르면 App은
삭제하지 않고 시작을 중단합니다.

초기화 뒤에는 `ha-antigravity-remote-login`을 다시 실행해야 합니다. GitHub 연결,
managed browser identity, local memory와 Antigravity customization도 빈 상태에서 다시
만듭니다. `/config`의 automation, dashboard와 사용자 파일은 유지되지만, 그래도
업그레이드 전에 Home Assistant backup을 권장합니다.

3.0 이전으로의 downgrade는 자동·무손실 복구가 아닙니다. 필요하면 해당 버전에서 만든
Home Assistant App backup을 복원하고, 서로 다른 버전의 runtime data를 섞지 마세요.

## 문제 해결

### 첫 대화가 `file does not exist`로 실패함

3.0의 1회 초기화는 App 소유 Antigravity project 파일도 삭제합니다. Remote
Dashboard가 초기화 전 project 선택을 계속 보내면 첫 대화가 HTTP 500
`file does not exist`로 실패할 수 있습니다.

1. OAuth token이나 `/data`를 삭제하지 말고 실패한 대화를 닫습니다.
2. 첫 인증 직후라면 App을 한 번 재시작하고 instance가 online이 될 때까지 5–10초
   기다립니다. 이 단계는 인증용 instance와 상시 instance를 분리하지만 저장된 project
   선택 자체를 지우지는 않습니다.
3. Dashboard에서 올바른 instance와 새로 만든 유효 project를 명시적으로 선택하거나
   project 밖의 새 대화를 선택합니다. 이전 project·실패 대화를 재개하지 마세요.
4. 일반 새로고침에도 선택은 browser local storage에 남습니다. UI에서 유효 project로
   바꿀 수 없으면 Remote Dashboard의 저장된 site data를 초기화한 뒤 `/config`의 새
   project에서 다시 시작합니다.

App log의 memory refresh 경고나 `home_assistant_browser_auto_auth` option은 이
Remote project 오류와 별개입니다. 인증 파일, code 또는 token 내용은 확인하거나
공유하지 마세요.

### Remote instance가 보이지 않음

1. App이 실행 중이고 인터넷에 연결되는지 확인합니다.
2. Dashboard와 helper에 같은 Google 계정을 사용했는지 확인합니다.
3. Ingress에서 `ha-antigravity-remote-login`을 다시 실행합니다.
4. 성공 뒤 App log에서 secret이 아닌 상태 메시지만 확인합니다.
5. `remote_control_name`이 유효하고 다른 instance와 구분되는지 확인합니다.

일시적인 network 단절 중에도 host process가 살아 있으면 실행 중인 작업은 계속될 수
있습니다. 연결이 복구되면 Dashboard가 다시 연결을 시도합니다.

### Ingress가 열리지 않음

- App 상태와 Ingress URL을 Home Assistant에서 다시 확인합니다.
- App log의 첫 failure를 확인합니다. 초기화 대상 안전성 검사 실패라면 경로를 임의로
  삭제하지 말고 공개 가능한 진단 보고서를 만드세요.
- 보호 mode를 끄거나 host 경로를 추가 mount하는 방식으로 우회하지 마세요.

### Browser 또는 memory 문제

- `ha-browser-auth-status`와 `ha-memory status`로 `disabled`, `empty`, `stale`,
  `degraded`를 구분합니다.
- 관련 option을 바꿨다면 App을 재시작하고 새 browser session으로 확인합니다.
- 실제 HAOS 결과와 container fixture 결과를 구분해 보고합니다.

## 업데이트와 지원

릴리스 notes에서 breaking version, reset, architecture와 HAOS evidence를 확인한 뒤
업데이트하세요. source test, container smoke와 emulated architecture는 실제 HAOS
증거가 아닙니다. 수행하지 않은 실제 장치 검증은 `NOT RUN`, 일부만 수행한 검증은
`PARTIAL`로 기록합니다.

지원 절차는 [SUPPORT.md](../SUPPORT.md), 공개 변경 내역은
[CHANGELOG.md](CHANGELOG.md), 개발 계약은
[docs/development](../docs/development/README.md)을 참고하세요.
