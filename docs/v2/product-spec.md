# v2 제품 사양

## 1. 제품 정의

Antigravity for Home Assistant는 HAOS Supervisor가 관리하는 Home Assistant
App이다. 컨테이너 안에 고정 버전 Antigravity CLI와 Home Assistant 전용 native
plugin을 제공한다. 사용자는 다음 세 표면에서 같은 `/config` 프로젝트와
영속 Antigravity 계정을 사용한다.

- Home Assistant Ingress의 ttyd/tmux 터미널
- 공개키 인증만 허용하는 App SSH endpoint
- 인증·queue·승인 broker를 거치는 Telegram Bot

Ingress와 SSH는 대화형 관리 표면이다. Telegram은 제한된 비대화형 운영
표면이며 shell이나 tmux TUI를 중계하지 않는다.

## 2. 사용자 시나리오

### US-001 설치와 로그인

사용자는 repository를 HAOS에 추가하고 자신의 아키텍처 이미지를 설치한다.
Ingress 또는 SSH에서 공식 Antigravity OAuth 흐름을 완료한다. 인증은 `/data`에
영속화되고 App 재시작과 정상 업데이트 뒤에도 유지된다.

### US-002 Home Assistant 진단

사용자는 entity, device, area, automation, history, trace, Core/App 로그를 묻는다.
기본값에서 Antigravity는 Recorder DB나 비밀 파일을 읽지 않고 HA plugin의 bounded
API를 통해 관련 정보만 가져온다. 사용자가 진단용 민감정보 읽기를 명시적으로
켜면 대화형 Antigravity에만 제한된 read-only profile을 적용한다.

### US-003 설정 변경

사용자는 `/config`의 YAML, dashboard resource 또는 automation을 수정한다.
대화형 표면은 Antigravity native permission과 AppArmor를 적용한다. persistent
변경은 사전 상태를 기록하고 `ha-config-check`, 필요한 reload와 fresh API
검증을 수행한다.
Telegram broker의 첫 executable YAML 범위는 canonical input boolean include로
제한하며 다른 YAML은 human-reviewable preview만 만들고 실행하지 않는다.

### US-004 Telegram 조회와 변경

허용된 사용자는 Bot에 자연어로 질문한다. 조회는 바로 응답하고, 변경은 선택한
Telegram 모드에 따라 거부, 확인 대기 또는 저위험 자동 실행된다. 고위험 작업은
모드와 관계없이 같은 사용자·채팅의 새 확인이 필요하다.

### US-005 dashboard 검증

Antigravity는 image-managed browser MCP로
`http://127.0.0.1:8099/`의 Home Assistant dashboard를 열어 desktop
1440×900과 mobile 390×844를 검사한다. visible snapshot, screenshot, console과
실패한 network resource를 함께 검토한다.

### US-006 검증형 메모리

App은 첫 시작 이후 entity/device/area/automation의 허용된 구조 metadata를
색인한다. 사용자가 명시한 지속 사실은 검증 절차로 저장한다. 현재 상태,
대화 원문, credential과 automation 원문은 메모리에 저장하지 않는다.

### US-007 안전한 업데이트와 복구

사용자는 보존 정책을 선택해 v1에서 v2로 업데이트한다. 변경 대상은 먼저
root-only backup에 저장되고 migration은 원자적이며 재실행 가능하다. 실패하면
App은 기존 복구 표면을 유지하고 rollback 절차를 안내한다.

## 3. 기능 요구사항

### FR-001 App 패키징

- App slug는 `antigravity_home_assistant`를 유지한다.
- `init: false`와 s6-overlay를 사용한다.
- `arch`는 `amd64`, `aarch64`를 목표로 한다.
- public 설치는
  `ghcr.io/kanu-coffee/antigravity-for-home-assistant:<version>`의 generic
  multi-arch manifest를 사용한다.
- `config.yaml`의 `image`는 tag 없는 generic image 이름이다.
- custom `apparmor.txt`를 포함하고 AppArmor는 항상 켠다.
- `/config`는 `homeassistant_config`를 read-write로 정확히 한 번 mount한다.
- `homeassistant_api: true`, `hassio_api: true`, `hassio_role: manager`를 사용한다.
- `full_access`, Docker API, host network, privileged capability와 host journal mount는
  기본적으로 사용하지 않는다.

### FR-002 Antigravity

- CLI version은 1.1.11에 고정하고 아키텍처별 artifact digest를 검증한다.
- 사용자 명령은 `agy`와 `antigravity` alias를 제공한다.
- 대화형 기본 `HOME`은 `/data/home`, 기본 작업 디렉터리는 `/config`다. Telegram은
  별도 `/data/antigravity-ha/telegram-home`과 image-managed safe cwd를 사용한다.
- 설정과 extension은 [antigravity-contract.md](antigravity-contract.md)의 native
  JSON 경로만 사용한다.
- 로그인은 공식 CLI OAuth 흐름만 사용한다. App option으로 임의 API token을
  주입하지 않는다.

### FR-003 Ingress와 SSH

- Ingress는 외부 ttyd port 없이 Supervisor 인증 뒤에 둔다.
- ttyd는 재접속 가능한 tmux session을 열며 Antigravity 자동 시작은 선택 사항이다.
- SSH는 public key만 허용하고 host key를 `/data`에 보존한다.
- password, empty password와 root remote password login은 허용하지 않는다.

### FR-004 Home Assistant plugin

plugin은 다음 capability를 분리해 제공한다.

- `ha_read`: Core/Supervisor 정보, state, registry, history, trace, logs
- `ha_validate`: configuration check와 변경 후 fresh verification
- `ha_memory`: bounded search, explicit memory, candidate와 change verification
- `playwright`: loopback dashboard 탐색, snapshot, screenshot, console, network
- `ha_change_propose`: typed 변경 preview 생성

Telegram model process에는 최종 실행 credential이나 raw Supervisor token을
주지 않는다. 실제 변경은 승인 broker가 검증된 proposal만 수행한다.

기존의 “HA용 AGENTS.md preset” 요구는 Antigravity native plugin의 image-managed
`rules/`와 `skills/`로 구현한다. 루트 `AGENTS.md`는 저장소 개발자용이며 runtime
preset으로 복사하지 않는다. 사용자 `/config/AGENTS.md`와 다른 프로젝트 지침은
자동 생성하거나 덮어쓰지 않는다.

### FR-005 메모리

- 저장소는 `/data/antigravity-ha-memory/memory.sqlite3`를 유지한다.
- 구조 catalog와 사용자 semantic memory를 논리적으로 분리한다.
- 첫 bootstrap과 정기 refresh 실패는 memory만 `empty`, `degraded` 또는 `stale`로
  표시하고 Ingress, SSH와 Telegram 조회 서비스의 시작을 막지 않는다.
- 사용자 명시 사실은 `memory_remember_explicit`로 처리한다.
- 다른 학습은 candidate → verified → applied 순서를 지킨다.
- persistent HA 변경은 표현 가능한 경우 `memory_begin_change`와 fresh API 기반
  `memory_verify_change`로 연결한다.

### FR-006 브라우저

- Chromium과 Playwright MCP version을 image lockfile과 build에서 고정한다.
- executable path는 실제 image에서 계약 테스트하고 wrapper와 일치시킨다.
- browser profile과 screenshot은 `/run/antigravity-ha` 아래 임시 저장하고 재시작
  때 제거한다.
- 관리형 browser 사용자는 active, local-only, non-admin이며 sole
  `system-read-only` group이어야 한다.
- Core TLS 오류를 무시하지 않는다.

### FR-007 Telegram

- 기본은 꺼짐이며 기존 bridge 코드를 재사용하지 않는다.
- 허용된 user ID와 chat ID의 교집합만 처리한다.
- `read_only`, `confirm_changes`, `autonomous` 세 모드를 제공한다.
- trusted local TTY의 `ha-telegram-login`으로 별도 identity의 native OAuth를
  수행하고 대화형 credential/customization을 공유하지 않는다.
- 상세 계약은 [telegram-spec.md](telegram-spec.md)를 따른다.

### FR-008 비밀과 로그

- `SUPERVISOR_TOKEN`, OAuth credential, Telegram token, browser token, SSH private
  key와 민감 파일 내용은 model, argv, 로그, artifact, screenshot 이름에 넣지 않는다.
- 자식 프로세스 환경은 capability별 allowlist로 새로 구성한다.
- 로그는 event type, opaque correlation ID, duration, result code만 기본 기록한다.
- 사용자 prompt와 model raw output은 기본 기록하지 않는다.
- AppArmor는 항상 enforce한다. `antigravity_sensitive_data_access`는 AppArmor를
  끄지 않고 대화형 Antigravity의 top-level named `Px` 실행 프로필만 선택한다.
- 기본 `false`는 `secrets.yaml`, `.storage`와 Recorder DB의 read/write를 모두
  거부한다. `true`는 이 세 종류의 진단용 read만 허용하고 write는 계속 거부한다.
- Telegram, browser, memory와 broker에는 이 option을 적용하지 않는다. SSH key,
  App token, backup, SSL private material과 cloud auth는 두 값 모두 계속 거부한다.

## 4. App 옵션 계약

신규 설치 기본값은 다음과 같다.

```yaml
telegram_enabled: false
telegram_bot_token: ""
telegram_allowed_user_ids: []
telegram_allowed_chat_ids: []
telegram_access_mode: confirm_changes
antigravity_tool_permission: request-review
antigravity_terminal_sandbox: true
antigravity_sensitive_data_access: false
antigravity_user_files_update_mode: preserve
home_assistant_browser_auto_auth: true
web_terminal_auto_start_antigravity: false
authorized_keys: []
tmux_session_name: antigravity-ha
log_level: info
```

| 옵션 | 허용값과 의미 |
| --- | --- |
| `telegram_enabled` | bridge 시작 여부. 기본 `false` |
| `telegram_bot_token` | secret App option. 로그나 진단 payload에서 제외 |
| `telegram_allowed_user_ids` | Telegram numeric user ID allowlist |
| `telegram_allowed_chat_ids` | Telegram numeric chat ID allowlist |
| `telegram_access_mode` | `read_only`, `confirm_changes`, `autonomous` |
| `antigravity_tool_permission` | Antigravity native `toolPermission`: `request-review`, `proceed-in-sandbox`, `always-proceed`, `strict` |
| `antigravity_terminal_sandbox` | 대화형 CLI에 `--sandbox`를 적용할지 결정. Telegram 격리는 항상 적용 |
| `antigravity_sensitive_data_access` | 기본 `false`. AppArmor는 유지한 채 대화형 child의 세 민감 경로 진단용 read-only 허용 여부 선택 |
| `antigravity_user_files_update_mode` | `preserve`, `refresh_managed`, `reset_v2` |
| `home_assistant_browser_auto_auth` | 관리형 read-only browser identity 사용 여부 |
| `web_terminal_auto_start_antigravity` | Ingress tmux 접속 시 CLI 자동 시작 여부 |
| `authorized_keys` | SSH public key 목록 |
| `tmux_session_name` | `[A-Za-z0-9._-]{1,64}` |
| `log_level` | `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal` |

`antigravity_token`, Codex식 `antigravity_approval_policy`,
`antigravity_sandbox_mode`와 `browser_approval_policy`는 v2 public option이 아니다.
이전 옵션은 migration에서 의미를 보수적으로 변환하거나 사용자 조치가 필요한
항목으로 보고하며 런타임 CLI 인수로 전달하지 않는다.

Supervisor pre-container update 검증과의 호환을 위해 schema만 v1의
`refresh_agents`, `refresh_all`을 migration-only 값으로 임시 수용한다. 이 둘은
v2 user-facing mode가 아니며 첫 안전한 bootstrap 뒤 Supervisor self-options API를
통해 `refresh_managed`로 정규화한다.

`antigravity_sensitive_data_access=true`는 일반 shell, Telegram worker, browser,
memory 또는 broker의 권한을 늘리지 않는다. AppArmor attach/enforce 상태, 모든
민감 경로의 write deny와 나머지 민감정보 deny는 option 값과 무관한 불변조건이다.

## 5. Telegram 모드 계약

| 동작 | `read_only` | `confirm_changes` | `autonomous` |
| --- | --- | --- | --- |
| 상태·registry·로그 조회 | 허용 | 허용 | 허용 |
| dashboard 관찰 | 허용 | 허용 | 허용 |
| `/config` 또는 HA persistent 변경 | 거부 | 매번 확인 | 저위험만 자동 |
| HA `service_call` | 거부 | 매번 확인 | 항상 확인 |
| transient `device_test` | 거부 | 매번 확인 | 항상 확인 |
| 고위험 동작 | 거부 | 항상 확인 | 항상 확인 |

고위험 분류는 코드와 사용자 prompt가 낮출 수 없다. 자세한 목록과 확인
state machine은 [security.md](security.md)와
[telegram-spec.md](telegram-spec.md)에 고정한다.
`device_test`는 persistent `service_call`과 다른 typed operation이다. 허용된 on/off
entity의 fresh prior-state precondition, distinct test target, test-state fresh verify,
always-run restore service와 fresh restore verify가 모두 필요하며 항상 high risk다.

## 6. 비기능 요구사항

- 같은 입력과 App options는 같은 permission 결과를 낸다.
- bridge queue와 API 요청에는 상한, timeout, 취소와 backpressure가 있다.
- 서비스 하나의 실패가 복구용 Ingress와 SSH를 불필요하게 중단하지 않는다.
- update와 migration은 crash-safe, idempotent, recoverable해야 한다.
- image build는 network artifact와 dependency를 version과 digest로 고정한다.
- 한국어 문서를 canonical로 하고 사용자 문서는 한국어·영어를 함께 제공한다.
- 지원을 주장하는 각 아키텍처에서 같은 acceptance suite를 통과한다.
