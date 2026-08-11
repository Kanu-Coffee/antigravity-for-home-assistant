<p align="right">
  <strong>한국어</strong> · <a href="DOCS.en.md">English</a>
</p>

# Antigravity for Home Assistant 사용 설명서

이 문서는 v2 App을 설치하고 native Google Antigravity, Telegram, Home Assistant
전용 도구와 안전 기능을 사용하는 방법을 설명합니다.

> [!WARNING]
> 이 App은 `/config` 전체의 쓰기 권한과 Home Assistant Core·Supervisor 관리자급
> API 권한을 사용합니다. 신뢰하는 관리자만 접근하게 하고, 변경 전 preview와
> backup을 확인하세요. SSH port를 인터넷에 직접 노출하지 마세요.

## 상태와 지원 범위

### 지원 환경

- Supervisor가 있는 Home Assistant OS 또는 Supervised 설치
- `amd64` 또는 `aarch64` 장치
- App image와 Google Antigravity OAuth에 필요한 인터넷 연결
- Antigravity를 사용할 수 있는 Google 계정

이 App은 HACS integration이 아니며 현재 `stage: experimental`, `boot: manual`입니다.
릴리스는
`ghcr.io/kanu-coffee/antigravity-for-home-assistant:<version>`의 prebuilt image를
사용하도록 패키징됩니다. 설치 전 릴리스의 multi-arch manifest와 실제 HAOS 검증
기록을 확인하세요.

### 실행 표면

| 표면 | 용도 | 변경 경계 |
| --- | --- | --- |
| Ingress Web terminal | 대화형 Antigravity와 로컬 관리 | native permission + AppArmor |
| 공개키 SSH | 신뢰하는 관리자의 원격 shell | native permission + AppArmor |
| Telegram Bot | 제한된 비대화형 질문·proposal | read/proposal worker + 승인 broker |

Ingress와 SSH는 같은 `/config` 프로젝트와 영속 Home을 사용합니다. Telegram은
별도 `agy --print` worker를 사용하며 Web terminal의 shell이나 tmux 입력을
중계하지 않습니다.

## 설치

### App 저장소 추가

[![Home Assistant에 App 저장소 추가](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fantigravity-for-home-assistant)

버튼을 사용할 수 없다면 다음 URL을 **설정 → Apps → App store →
Repositories**에 추가합니다.

```text
https://github.com/Kanu-Coffee/antigravity-for-home-assistant
```

App을 선택하고 설치합니다. 공개 릴리스는 HA 장치에서 소스를 빌드하지 않고
아키텍처에 맞는 GHCR image를 받습니다. App이 목록에 없거나 image pull이 실패하면
해당 version의 `linux/amd64` 또는 `linux/arm64` manifest가 실제로 게시되었는지
먼저 확인하세요.

### 최초 시작

1. 기본 설정으로 App을 시작합니다.
2. 로그에서 init, 별도 AppArmor 실행 프로필, read broker, memory와 Web terminal 시작
   결과를 확인합니다. token이나 내부 응답 본문을 공유하지 마세요.
3. **OPEN WEB UI**를 엽니다. shell은 `/config`에서 시작합니다.
4. 읽기 전용 요청으로 연결을 먼저 시험합니다.

```text
현재 Home Assistant 구조와 최근 Core 오류를 읽기 전용으로 요약해 줘.
파일, registry, 기기 상태는 아직 변경하지 마.
```

## Native Antigravity 로그인

### Google OAuth

Web terminal 또는 공개키 SSH의 controlling TTY에서 처음 한 번 실행합니다.

```bash
ha-antigravity-login
```

CLI가 표시하는 공식 Google OAuth 절차를 완료합니다. helper는 native Antigravity를
직접 실행하며 존재하지 않는 별도 login subcommand나 App 전용 API token을
사용하지 않습니다. 완료 뒤 새 세션을 시작합니다.

```bash
agy
```

`antigravity`와 `ha-antigravity`도 같은 native CLI wrapper입니다. OAuth 자료는
`/data/home/.gemini/**` 아래 CLI가 관리하며 App 재시작과 일반 update 뒤에도
보존됩니다. 해당 디렉터리, authorization header 또는 credential 내용을 출력하거나
Git·Telegram·지원 이슈에 복사하지 마세요.

### Native 경로와 plugin

v2는 Antigravity 1.1.11의 native JSON/plugin 경로를 사용합니다.

| 역할 | 경로 |
| --- | --- |
| CLI settings | `/data/home/.gemini/antigravity-cli/settings.json` |
| global MCP settings | `/data/home/.gemini/config/mcp_config.json` |
| App 관리 HA plugin | `/data/home/.gemini/config/plugins/home-assistant/` |
| workspace MCP | `/config/.agents/mcp_config.json` |
| Telegram 전용 native HOME | `/data/antigravity-ha/telegram-home/` |

App은 기존의 알 수 없는 사용자 JSON key와 사용자 plugin을 보존하고 자신이 소유한
key만 merge합니다. 프로젝트의 `/config/AGENTS.md`를 HA preset으로 자동 생성하거나
덮어쓰지 않습니다. HA용 기본 규칙, skills와 MCP는 image-managed
`home-assistant` plugin에 있습니다.
Telegram worker는 위 대화형 global/workspace customization을 상속하지 않습니다.

## App 설정

### 권장 시작 설정

```yaml
telegram_enabled: false
telegram_bot_token: ""
telegram_allowed_user_ids: []
telegram_allowed_chat_ids: []
telegram_access_mode: confirm_changes
authorized_keys: []
web_terminal_auto_start_antigravity: false
tmux_session_name: antigravity-ha
antigravity_tool_permission: request-review
antigravity_terminal_sandbox: true
antigravity_sensitive_data_access: false
antigravity_user_files_update_mode: preserve
home_assistant_browser_auto_auth: true
log_level: info
```

### 옵션 참조

| 옵션 | 기본값 | 허용값·의미 |
| --- | --- | --- |
| `telegram_enabled` | `false` | Telegram bridge 시작 여부 |
| `telegram_bot_token` | `""` | BotFather secret token. 로그·이슈에 노출 금지 |
| `telegram_allowed_user_ids` | `[]` | 허용할 numeric user ID 문자열 목록 |
| `telegram_allowed_chat_ids` | `[]` | 허용할 numeric chat ID 문자열 목록 |
| `telegram_access_mode` | `confirm_changes` | `read_only`, `confirm_changes`, `autonomous` |
| `authorized_keys` | `[]` | SSH root 로그인을 허용할 OpenSSH 공개키 한 줄 목록 |
| `web_terminal_auto_start_antigravity` | `false` | 새 tmux session에서 `agy`를 한 번 자동 시작 |
| `tmux_session_name` | `antigravity-ha` | `[A-Za-z0-9._-]`로 된 1~64자 session 이름 |
| `antigravity_tool_permission` | `request-review` | `request-review`, `proceed-in-sandbox`, `always-proceed`, `strict` |
| `antigravity_terminal_sandbox` | `true` | 대화형 CLI에 native `--sandbox` 적용 여부 |
| `antigravity_sensitive_data_access` | `false` | AppArmor를 유지한 채 대화형 child의 세 민감 경로 진단 read-only 허용 여부 |
| `antigravity_user_files_update_mode` | `preserve` | `preserve`, `refresh_managed`, `reset_v2`; 폐기 예정 migration-only `refresh_agents`, `refresh_all` |
| `home_assistant_browser_auto_auth` | `true` | local-only read-only browser identity 자동 관리 |
| `log_level` | `info` | `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal` |

App의 Network 설정 `22/tcp` host port 기본값은 `2224`입니다. JSON option이 아니며
SSH를 사용하지 않으면 port를 비활성화할 수 있습니다.

`always-proceed`는 native prompt를 줄이는 값일 뿐 AppArmor deny, Telegram
위험도 재분류 또는 broker 확인을 약화하지 않습니다. terminal sandbox를 끄는 것도
AppArmor를 끄지 않습니다.

### 설정 변경 후

설정을 저장한 뒤 App을 재시작합니다. native settings, plugin, MCP, terminal
profile 또는 Telegram mode를 바꿨다면 기존 Antigravity process를 끝내고 새 세션을
시작합니다. 민감정보 옵션의 profile attach가 실패하면 넓은 권한으로 fallback하지
않고 대화형 Antigravity 시작이 실패해야 합니다.

## 접속 방법

### Web terminal

**OPEN WEB UI**는 Home Assistant Ingress 인증 뒤의 ttyd/tmux terminal입니다.
기본값에서는 Bash가 열리고 `agy`를 직접 실행합니다. tmux는 브라우저 재접속을 위한
대화형 terminal 전용입니다. 여러 탭은 같은 session을 공유할 수 있으므로 신뢰하는
관리자만 열어 두세요.

### SSH

SSH는 선택 사항이며 공개키만 허용합니다.

1. client에서 Ed25519 key pair를 만듭니다.
2. 공개키 한 줄만 `authorized_keys`에 추가합니다. 개인키를 App 설정에 넣지 마세요.
3. App을 재시작하고 Network의 host port를 확인합니다.
4. 내부망 또는 VPN에서 접속합니다.

```bash
ssh -p 2224 root@homeassistant.local
```

password와 keyboard-interactive login은 차단됩니다. TCP `2224`를 공유기에 직접
port-forward하지 말고 신뢰하는 VPN 또는 mesh VPN을 사용하세요.

## Telegram

> [!CAUTION]
> actual Antigravity 1.1.11 local canary에서 공유 HOME의 global MCP launch를
> 재현한 뒤, 전용 Telegram HOME/safe cwd worker에서는 같은 marker와
> `/config/.agents` marker가 실행되지 않고 managed customization 변조가
> fail-closed됨을 확인했습니다. 실제 HAOS OAuth 성공과 AppArmor enforce 전에는
> `telegram_enabled: false`를 유지하세요.

신뢰하는 local Ingress/SSH TTY에서 `ha-telegram-login`을 실행해 별도 Telegram
identity의 native first-run OAuth를 완료합니다. 대화형 HOME의 인증 자료를 복사하거나
문서화되지 않은 credential 경로를 추정하지 않습니다.

### Bot 생성

1. Telegram의 [@BotFather](https://t.me/botfather)에서 `/newbot`을 실행합니다.
2. 발급된 HTTP API token을 `telegram_bot_token`에 저장합니다.
3. 아래 인증 방식 하나를 준비한 뒤 `telegram_enabled: true`로 설정하고 App을
   재시작합니다.

Bot token은 password처럼 다룹니다. screenshot, shell history, 로그 또는 지원
payload에 포함하지 마세요.

### 사용자 인증

#### 정적 user·chat 교집합

`telegram_allowed_user_ids`와 `telegram_allowed_chat_ids`를 모두 설정합니다.
bridge는 sender user ID와 현재 chat ID가 각 목록에 함께 있을 때만 요청을
처리합니다. user 목록 또는 chat 목록만으로는 인증되지 않습니다. ID는 JSON/YAML
number가 아니라 따옴표로 감싼 문자열로 저장하는 것을 권장합니다.

#### 로컬 일회용 pairing

정적 ID를 모르면 App의 Web terminal 또는 SSH에서 만료형 token을 만듭니다.

```bash
ha-telegram-pair create --ttl 5m
```

token 만료 전에 bot 대화에서 `/start TOKEN`을 전송합니다. 발급은 local-only이고,
원문 token은 한 번만 표시되며 소비 후 재사용할 수 없습니다. TTL은 초(`30s`) 또는
분(`5m`) 단위이고 최대 10분입니다.

```bash
ha-telegram-pair list
ha-telegram-pair revoke AUTHORIZATION_ID
```

`list` 결과와 authorization ID도 필요한 범위에서만 다루세요. v2에는 로그가
자동 생성하는 deep link, 6자리 PIN 또는 Telegram `/unpair` 명령이 없습니다.

### 모드와 변경 정책

| 작업 | `read_only` | `confirm_changes` | `autonomous` |
| --- | --- | --- | --- |
| 상태·서비스·bounded 로그 조회 | 허용 | 허용 | 허용 |
| dashboard 관찰 | 허용 | 허용 | 허용 |
| 지원되는 `/config` 변경 | 거부 | 매번 확인 | broker 검증 저위험만 자동 |
| HA `service_call` | 거부 | 매번 확인 | 매번 확인 |
| restart/update/restore/delete | 거부 | 미지원·거부 | 미지원·거부 |

현재 최소 broker는 검증된 device safety metadata가 없으므로 모든
`service_call`을 고위험으로 분류합니다. door lock, alarm, safety heating/water,
host/Core restart, backup restore, update, removal, credential·permission 변경은
prompt나 mode가 위험도를 낮출 수 없습니다.

### 명령과 세션

| 명령 | 동작 |
| --- | --- |
| `/start` | 인증 상태와 기본 안내 |
| `/help` | 사용 가능한 명령과 현재 mode |
| `/status` | bridge와 현재 session 상태 |
| `/new` | 해당 user·chat의 새 대화 시작 |
| `/cancel` | 현재 queue 작업 취소 요청 |

한 user·chat의 요청은 순서대로 처리되고 bounded queue, timeout과 응답 크기 제한을
적용합니다. `/cancel`은 이미 외부에서 완료된 작업을 되돌리는 rollback 명령이
아닙니다.

### 승인 보안

Telegram model process는 raw Supervisor token이나 최종 실행 socket을 받지 않고
typed proposal만 만듭니다. bridge는 broker에서 proposal을 다시 조회한 뒤 preview를
보여 줍니다. 확인은 proposal ID, 같은 user·chat, preview digest와 짧은 TTL에
묶입니다. 256-bit 일회용 capability와 idempotency key가 재사용·중복 실행을
막습니다. preview나 precondition이 바뀌거나 확인이 만료되면 새 proposal이
필요합니다.

broker-generated YAML preview는 secret value를 제거한 bounded before/after와 전체
mutation digest를 표시합니다. 현재 실제로 파일을 쓰고 reload까지 완료할 수 있는
config change는 `configuration.yaml`의 단일 canonical
`input_boolean: !include <file>.yaml` 대상뿐입니다. 이 경우 broker가 memory begin,
config check, `input_boolean.reload`, fresh API memory verify를 모두 통과해야 성공이며,
그 외 YAML은 preview-only로 실행을 거부합니다.

## Home Assistant 기능

### Helper와 read MCP

| 도구 | 용도 |
| --- | --- |
| `ha-config-check` | Home Assistant configuration 검사 |
| `ha-core-logs` | Core 로그의 bounded 조회 |
| `ha-addon-logs ADDON_SLUG` | 지정 App 로그 조회 |
| `ha-api` | Core API helper |
| `supervisor-api` | Supervisor API helper |
| `ha-memory status` | memory schema·freshness·degraded 상태 확인 |
| `ha-feedback` | 비밀을 제외한 bug/feature report 후보 준비 |

Antigravity plugin의 `ha_read_config`, `ha_read_state`, `ha_read_states`,
`ha_read_services`, `ha_read_system_info`, `ha_read_registry`,
`ha_read_history`, `ha_read_traces`, `ha_read_core_logs`, `ha_read_app_logs`는
고정 endpoint를 project하고 크기를 제한합니다. `ha_validate_config`는 reload 없이
configuration을 검사하고 `ha_verify_state`는 exact entity의 fresh API 결과를 기대
state·하한 timestamp와 비교합니다. raw Supervisor token은 model에 전달되지
않습니다. trace 도구는 raw config, action/result, trigger와 context를 반환하지
않습니다.
API helper는 관리자 표면이므로 진단 결과만으로 service call이나 수정을 실행하지
마세요.

### Dashboard browser

`playwright` MCP는 container-local
`http://127.0.0.1:8099/`에서 dashboard를 관찰합니다. 관련 화면은 desktop
1440×900과 mobile 390×844에서 snapshot, screenshot, console warning/error와
실패한 network request를 함께 확인합니다.

`home_assistant_browser_auto_auth: true`이면 App은 local-only, non-admin,
`system-read-only` 단일 group 사용자를 만들거나 재사용합니다.
`ha-browser-auth-status`로 상태를 확인할 수 있습니다. 옵션을 끄면 다음 browser
session부터 일반 login 화면이 나타나며 managed identity는 자동 삭제되지 않습니다.
완전한 제거는 사용자가 명시적으로 `ha-browser-auth-remove`를 실행할 때만 합니다.

읽기 전용 identity도 custom integration의 permission 결함까지 막는 절대 경계는
아닙니다. dashboard 검증은 관찰용으로 사용하고 Core TLS 오류를 우회하지 마세요.

### 검증형 memory

memory는 `/data/antigravity-ha-memory/memory.sqlite3`에 저장됩니다. 전체 DB를
prompt로 읽지 않고 현재 질문과 정확한 subject에 맞는 bounded 결과만 검색합니다.
사용자가 직접 말한 하나의 명확한 지속 사실은 explicit memory로 저장할 수 있고,
그 밖의 학습은 candidate → verified → applied 절차를 거칩니다.

현재·과거 state value, timestamp, raw conversation, automation 원문, credential과
unsupported inference는 보존하지 않습니다. `empty`, `degraded`, `stale`은 검증된
no-result와 다릅니다. `ha-memory status`, bounded `search`, `history`, `conflicts`로
상태와 이력을 점검하세요. memory rollback은 semantic event만 보상하며 HA 설정이나
기기 상태를 되돌리지 않습니다.

### 설정 변경

대화형 Antigravity에서 HA 설정을 바꿀 때도 다음 순서를 지킵니다.

1. 관련 파일과 기존 Git 상태를 확인합니다.
2. 최소 diff와 복구 가능한 checkpoint를 만듭니다.
3. 지원되는 persistent 변경이면 memory change expectation을 기록합니다.
4. 변경 후 `ha-config-check`를 실행합니다.
5. 검사가 실패하면 reload/restart하지 말고 scoped change를 수정하거나 복원합니다.
6. 필요한 reload 뒤 fresh HA API로 결과를 확인합니다.

`.storage` 직접 편집과 Recorder DB 수리는 정상 작업 흐름이 아닙니다. 진단 결과만으로
restart, update, remove, restore 또는 service call이 승인되지 않습니다.

## AppArmor와 민감정보

### 항상 enforce

Supervisor는 AppArmor를 기본 활성화합니다. metadata의 중복 기본값은 생략하지만
App 디렉터리의 custom `apparmor.txt`가 기본 profile을 대체합니다. 사용자 option,
Telegram 명령, migration mode로 AppArmor를 끌 수 없고 HA 보호 모드 해제를 설치
조건으로 요구하지 않습니다. profile attach가 실패하면 넓은 권한으로 fallback하지
않아야 합니다.

### 민감정보 옵션

`antigravity_sensitive_data_access`는 AppArmor on/off switch가 아니라 Ingress/SSH에서
시작한 Antigravity가 사용할 **별도 top-level 실행 프로필(discrete `Px`
transition)** 선택입니다.

| 경로 종류 | `false` 기본값 | `true` |
| --- | --- | --- |
| `/config/secrets.yaml` | read/write 거부 | 진단 read-only, write 거부 |
| `/config/.storage/**` | read/write 거부 | 진단 read-only, write 거부 |
| Recorder DB와 sidecar | read/write 거부 | 진단 read-only, write 거부 |

`true`에서도 rename, truncate, delete, lock, DB repair와 전체 dump를 허용하지
않습니다. 읽은 민감값을 output, memory, screenshot, proposal 또는 artifact에
복사하면 안 됩니다. 우선 supported API와 secret key 이름만 사용하세요.

### 계속 차단되는 항목

옵션 값과 관계없이 Telegram worker, browser, memory, broker와 일반 shell에는
민감 read 권한이 추가되지 않습니다. SSH private/host key, OAuth·App·browser·bot
token, backup, `/config/ssl` private material, cloud auth와 broker capability는 각
소유 process 외에는 계속 거부됩니다.

native OAuth를 사용하는 대화형 Antigravity는 `/data/home`, Telegram worker는 별도
`/data/antigravity-ha/telegram-home` read-write가 필요합니다. identity는 공유되지
않지만 AppArmor는 각 owning process 안에서 정상 인증 read와 prompt/tool이 유도한
credential read를 완전히 구분하지 못합니다. native permission, sandbox, shell-free
worker, 별도 실행 프로필, output redaction과 broker가 추가 방어층이며 완전한 token
isolation은 아닙니다. Telegram은 기본 OFF이며 실제 HAOS OAuth/AppArmor gate와 알려진
잔여 위험을 확인하세요.

## 업데이트, migration과 rollback

### 업데이트 전

1. Home Assistant 전체 backup을 만들고 복원 가능성을 확인합니다.
2. 현재 동작 App version과 가능하면 immutable image digest를 기록합니다.
3. `/config`의 Git 상태와 미커밋 변경을 확인합니다.
4. OAuth, Web UI/SSH, memory, browser와 Telegram 인증 상태를 비밀 없이 기록합니다.
5. 릴리스의 amd64/aarch64, AppArmor enforce, migration 검증표를 확인합니다.

### Migration mode

| mode | 보존·변경 범위 |
| --- | --- |
| `preserve` | OAuth·사용자 settings/MCP/plugin 보존; App 소유 HA plugin은 version당 canonical 보안 갱신 |
| `refresh_managed` | 위 보존·plugin 갱신에 더해 소유권이 기록된 settings key·permission rule을 root-only backup 후 merge |
| `reset_v2` | 같은 managed settings merge를 엄격하게 수행; ownership state가 없거나 모호하면 fail closed |

세 mode 모두 `/config`, native OAuth, SSH key, browser identity, memory DB와 사용자
소유 plugin/MCP를 초기화 대상으로 삼지 않습니다. mode와 관계없이 App 소유
`home-assistant` plugin은 안전한 ownership marker가 있으면 App version당 한 번
image의 canonical copy로 갱신됩니다. 새 설치는 현재 version marker를 기록하고,
같은 이름의 marker 없는 기존 plugin은 사용자 소유 충돌로 보고 덮어쓰지 않은 채
시작을 중단합니다. 그 밖의 교체 파일은 먼저
`/data/antigravity-ha/backups/native-files/` 아래 root-only backup에 보존됩니다.
global `mcp_config.json`은 없을 때 빈 `mcpServers` 기본본만 생성하며 기존 파일은
모든 mode에서 byte-preserve합니다. HA MCP·rules·skills는 App plugin 내부에
있습니다. `refresh_managed`와 `reset_v2`는 App version별 transaction 상태로 재실행을
제한하지만, 작업을 확인한 뒤 `preserve`로 돌려놓는 것을 권장합니다.

### v1 migration 주의

- v1의 managed-file refresh 값은 보수적으로 `refresh_managed`로 매핑되며
  `reset_v2`로 자동 승격되지 않습니다. v2 schema는 Supervisor가 업그레이드된
  container를 시작할 수 있도록 이 두 폐기 예정 값만 migration input으로
  수용합니다. user-file과 managed-plugin bootstrap이 성공하면 App은 고정된
  Supervisor self-options endpoint에 현재 option 전체를 보내되 이 key만
  `refresh_managed`로 바꿉니다. 요청을 사용할 수 없으면 legacy 값을 유지하고
  다음 App 시작에서 재시도합니다.
- 이전 provider credential이나 App 전용 token을 native 인증으로 import하지
  않습니다. Google OAuth를 다시 완료해야 할 수 있습니다.
- 이전 비-native 설정과 guidance 파일은 보존될 수 있지만 Antigravity 1.1.11의
  native settings/plugin으로 로드된다고 가정하면 안 됩니다.
- 공개 v1의 managed-file journal이 남아 있으면 v2는 검증된 기존 backup에서
  미완료 `config.toml`/`AGENTS.md` 교체를 먼저 복구합니다. 복구 자료가 손상되거나
  모호하면 native 파일을 쓰지 않고 시작을 중단합니다.
- legacy Telegram pairing/session은 신뢰하지 않습니다. 두 정적 목록 또는 새 로컬
  pairing으로 다시 인증합니다. 기존 authorization/pairing 파일은 v2가 재사용하지
  않고 `/data/antigravity-ha/quarantine/v1-telegram/`에 root-only로 격리합니다.

### Rollback

자동 HAOS rollback은 보장하지 않습니다. 문제 발생 시 다음 순서로 복구합니다.

1. Telegram과 mutation 작업을 중지하고 pending 승인을 폐기합니다.
2. App을 중지하고 비밀 없이 migration status와 로그를 확인합니다.
3. update mode를 `preserve`로 설정합니다.
4. Supervisor가 제공하는 이전 immutable version/image가 있으면 재설치합니다.
5. 필요한 경우에만 검증된 transaction backup에서 App 관리 파일을 범위 제한해
   복원합니다.
6. schema가 달라진 memory는 해당 version의 backup과 호환성을 먼저 확인합니다.
7. Ingress/SSH, OAuth, read API, memory와 browser smoke 후 Telegram을 마지막에
   다시 켭니다.

`/config` 삭제, DB 복원 또는 Home Assistant backup restore는 현재 사용자의
명시적 확인 없이 수행하지 마세요.

## 문제 해결

### App 설치 또는 시작 실패

- 장치가 `amd64` 또는 `aarch64`인지 확인합니다.
- release tag, `config.yaml` version과 GHCR manifest가 일치하는지 확인합니다.
- App/Supervisor 로그에서 init과 service별 오류를 찾되 token이나 response body를
  공유하지 않습니다.
- AppArmor profile attach 실패를 보호 모드 해제로 우회하지 않습니다.

### OAuth 실패

- Web terminal 또는 SSH가 controlling TTY인지 확인합니다.
- `ha-antigravity-login`을 다시 실행해 CLI가 제시하는 Google 흐름을 따릅니다.
- 존재하지 않는 login/status subcommand나 임의 API key 환경변수를 사용하지
  않습니다.
- OAuth 디렉터리를 출력하거나 수동 편집하지 않습니다.

### Telegram 응답 없음

- `telegram_enabled`, bot token 형식과 App 재시작 여부를 확인합니다.
- 정적 방식이면 user와 chat 두 목록의 교집합인지 확인합니다.
- pairing 방식이면 TTL, 한 번 소비 여부와 `ha-telegram-pair list`를 확인합니다.
- `/status`와 App 로그에서 queue/worker/broker 상태를 확인합니다.
- 변경 preview가 달라졌거나 만료되었다면 새 요청으로 다시 승인합니다.

### Browser 또는 memory 문제

- login 화면이면 `ha-browser-auth-status`를 확인합니다. `disabled`는 옵션을 끈
  의도된 상태일 수 있습니다.
- browser option을 바꾼 뒤 App과 browser session을 새로 시작합니다.
- `ha-memory status`에서 `empty`, `degraded`, `stale`을 구분합니다.
- browser 또는 memory 장애가 발생해도 recovery용 Web UI/SSH까지 임의로
  초기화하지 않습니다.

### 설정 변경 실패

- `ha-config-check` 결과와 scoped diff를 확인합니다.
- 검사가 실패한 상태에서 Core를 reload/restart하지 않습니다.
- broker의 precondition mismatch, expired capability 또는 `in_doubt`를 성공으로
  간주하지 않습니다. fresh state를 읽고 사람이 결과를 판단합니다.

## 검증 상태와 알려진 제한

2026-08-11 저장소 기준으로 정적·component test는 native CLI wrapper, read/change
broker, Telegram binding/replay, memory, browser 계약, migration과 AppArmor policy
parse를 대상으로 합니다. 다음은 generic 개발 환경의 성공만으로 `VERIFIED`라고
표시할 수 없습니다.

- 실제 HAOS amd64와 aarch64의 clean install·start·update
- 양쪽 아키텍처의 native Antigravity OAuth와 plugin discovery
- HAOS에서 별도 custom AppArmor 실행 프로필이 enforce 상태로 attach되는지
- 공개 GHCR generic manifest와 per-arch digest의 실제 pull
- 실제 dashboard, Telegram 세 mode, migration 세 mode와 rollback E2E

따라서 App은 experimental 상태를 유지합니다. 각 release의 CI, Builder, GHCR
manifest와 HAOS acceptance 기록에서 해당 항목이 통과했는지 확인하세요. 문서의
계획이나 unit test를 실제 장치 검증으로 해석하지 마세요.

## 지원 보고서

문제 보고 전에 App version, 아키텍처, 재현 절차, 기대/실제 결과와 수행한 검사를
정리합니다. `ha-feedback`으로 비밀이 제거된 report 후보를 만들 수 있지만 최종
payload를 직접 검토하세요. OAuth, Supervisor/bot/browser token, `secrets.yaml`,
`.storage`, private key, 내부 URL과 원문 로그 전체를 GitHub issue에 올리지 마세요.

- [저장소 README](../README.md)
- [v2 문서 색인](../docs/v2/README.md)
- [보안 계약](../docs/v2/security.md)
- [Telegram 계약](../docs/v2/telegram-spec.md)
- [Migration·release 계약](../docs/v2/migration-release.md)
