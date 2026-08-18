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

2.0.12의 실제 HAOS 18.2 amd64 `preserve` 업데이트에서는 Telegram 권한 자동 복구,
Bot 재연결·전달과 App 재시작/재연결이 통과했고 custom AppArmor attach는
`docker-default (enforce)`로 실패했습니다. 이를 고친 공개 2.0.13은 다음 컨테이너
기동에서 custom profile이 `/run/s6`와 `/run/service` 생성을 막아
`s6-overlay-suexec` exit 111로 실패했습니다. 2.0.14는 S6와 nginx의 정확한 runtime
경로만 허용하고 기존 민감정보 deny를 유지합니다. 2.0.14의 실제 HAOS 기동·재시작
검증은 아직 `NOT RUN`입니다. aarch64 실기기 시험도 장비 부재로 `NOT RUN`이며,
소유자가 experimental 배포에 한해 면제했지만 PASS로 간주하지 않습니다.

### 실행 표면

| 표면 | 용도 | 변경 경계 |
| --- | --- | --- |
| Ingress Web terminal | 대화형 Antigravity와 로컬 관리 | native permission + AppArmor |
| 공개키 SSH | 신뢰하는 관리자의 원격 shell | native permission + AppArmor |
| Telegram Bot | 관리자급 Antigravity 주 채널 | native permission + AppArmor + 승인 broker |

Ingress, SSH와 Telegram은 같은 `/config` 프로젝트, `/data/home`, OAuth, 전역·
workspace plugin/agent/rule/MCP와 권한 정책을 사용합니다. Telegram transport는
Web terminal의 shell이나 tmux 입력을 중계하지 않지만 별도 격리 identity는 아닙니다.

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

v2는 Antigravity 1.1.13의 native JSON/plugin 경로를 사용합니다.

| 역할 | 경로 |
| --- | --- |
| CLI settings | `/data/home/.gemini/antigravity-cli/settings.json` |
| global MCP settings | `/data/home/.gemini/config/mcp_config.json` |
| App 관리 HA plugin | `/data/home/.gemini/config/plugins/home-assistant/` |
| workspace MCP | `/config/.agents/mcp_config.json` |
| Web/SSH/Telegram 공유 HOME | `/data/home/` |

App은 기존의 알 수 없는 사용자 JSON key와 사용자 plugin을 보존하고 자신이 소유한
key만 merge합니다. 프로젝트의 `/config/AGENTS.md`를 HA preset으로 자동 생성하거나
덮어쓰지 않습니다. HA용 기본 규칙, skills와 MCP는 image-managed
`home-assistant` plugin에 있습니다. Telegram에서 실행한 Antigravity도 이
global/workspace customization을 상속하고 사용자 요청에 따라 수정할 수 있습니다.

## App 설정

### 권장 시작 설정

```yaml
telegram_enabled: false
telegram_bot_token: ""
telegram_allowed_user_ids: []
telegram_allowed_chat_ids: []
authorized_keys: []
web_terminal_auto_start_antigravity: false
tmux_session_name: antigravity-ha
antigravity_tool_permission: request-review
antigravity_terminal_sandbox: false
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
| `authorized_keys` | `[]` | SSH root 로그인을 허용할 OpenSSH 공개키 한 줄 목록 |
| `web_terminal_auto_start_antigravity` | `false` | 새 tmux session에서 `agy`를 한 번 자동 시작 |
| `tmux_session_name` | `antigravity-ha` | `[A-Za-z0-9._-]`로 된 1~64자 session 이름 |
| `antigravity_tool_permission` | `request-review` | effective 값은 `request-review` 하나; schema의 `strict`/`proceed-in-sandbox`/`always-proceed`는 upgrade 입력 호환용이며 모두 정규화 |
| `antigravity_terminal_sandbox` | `false` | deprecated/no-op compatibility 입력. 어느 값도 native sandbox를 켜지 않으며 `false`로 정규화 |
| `antigravity_sensitive_data_access` | `false` | AppArmor를 유지한 채 Web/SSH/Telegram runtime의 Recorder DB 진단 read-only 허용 여부 |
| `antigravity_user_files_update_mode` | `preserve` | `preserve`, `refresh_managed`, `reset_v2`; 폐기 예정 migration-only `refresh_agents`, `refresh_all` |
| `home_assistant_browser_auto_auth` | `true` | local-only read-only browser identity 자동 관리 |
| `log_level` | `info` | `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal` |

App의 Network 설정 `22/tcp` host port 기본값은 `2224`입니다. JSON option이 아니며
SSH를 사용하지 않으면 port를 비활성화할 수 있습니다.

Telegram은 별도 mode를 사용하지 않고 `antigravity_tool_permission`과
`antigravity_sensitive_data_access`를 Web/SSH와 동일하게 따릅니다. 1.1.13 native
`--sandbox`는 비특권 HAOS App에서 namespace 생성이 거부되므로 2.0.9의 세 채널은
이를 사용하지 않습니다. 대신 model이 실행한 command와 stdio tool은 discrete `Px`
transition으로 `antigravity_home_assistant-command` AppArmor 프로필에 들어가며, host
권한을 추가하지 않습니다. `antigravity_terminal_sandbox`는 deprecated/no-op 입력으로
어느 값이든 `false`로 정규화되고 native sandbox argv override도 거부됩니다.
2.0.11 새 설치와 Telegram의 effective native policy는 `request-review` 하나입니다.
고정 CLI의 headless 가용성 때문에 `strict`, `always-proceed`,
`proceed-in-sandbox` option은 user-files updater가 모두 이 값으로 정규화합니다.
schema가 다른 세 값을 계속 받는 것은 저장된 Supervisor option으로 upgrade를 시작하기
위한 입력 호환성입니다. safely identified 2.0.9/2.0.10 App-owned broad allow도 bounded
read/proposal-only managed rule로 migration됩니다. Telegram이 꺼진 preserve 경로는
기존 user-owned rule과 stronger deny를 계속 보존합니다. 2.0.12부터 Telegram이 켜지면
root-owned single-link regular·256 KiB 이하·parse 가능한 settings를 시작 transaction으로
backup하고 다섯 App 관리 보안 key 및 permission 세 bucket을 exact 29/0/33 safe policy로
정규화합니다. unknown custom allow/ask/deny는 제거하지만 그 다섯 key 밖의 top-level
설정, global MCP/plugin/OAuth와 `/config`는 보존하고 기존 mode는 0600으로 강화합니다.
symlink/hardlink/non-root owner, 크기 초과나 parse 불가능한 JSON은 수정하지 않고 gate가
`permission_boundary_blocked`를 한 번 기록한 뒤 Bot API 연결과 재시작 loop 없이
대기합니다. 관리자가 `reset_v2` 또는 안전한 파일 복구를 적용하고 App을 재시작해야
합니다. unattended allow에는 안전한 `/config`·customization
read, HA read/validate/memory read, `ha_change_propose`,
`telegram_action_propose`만 들어갑니다. 일반 command, native write, URL execute,
interactive browser와 임의 mutation MCP는 포함하지 않습니다. `secrets.yaml`,
`.storage`, App runtime option/token, native MCP 설정, SSH/private key와 표준 cloud-auth
경로는 exact read/write deny입니다.

Playwright 자동 허용은 upstream `readOnly: true`인
`browser_console_messages`, `browser_network_requests`, `browser_snapshot`,
`browser_take_screenshot` 네 도구로 제한됩니다. `browser_navigate`,
`browser_navigate_back`, `browser_tabs`, `browser_hover`, `browser_wait_for`,
`browser_resize`, `browser_close` 등 mutation-capable 도구는 typed approval adapter가
구현되기 전까지 Telegram에서 fail closed합니다.

Telegram의 HA 변경은 `ha_change_propose`, terminal/script/command choice/finite question은
`telegram_action_propose`로 먼저 등록해야 합니다. 두 MCP는 실행하지 않고 exact
digest와 public preview만 bridge에 넘깁니다. direct tool부터 호출해 발생한 native
permission denial은 승인이 아니며 같은 tool을 resume할 수 없습니다. bridge는 한 번
같은 conversation에 proposal-first 재계획을 요청할 수 있지만 unsupported side effect는
우회하지 않고 fail closed합니다.

### 설정 변경 후

App 옵션을 바꿨다면 저장한 뒤 App을 재시작합니다. native settings, plugin, MCP 또는
전역 권한 profile을 바꿨다면 Web/SSH의 기존 Antigravity process를 끝내고 새로
시작합니다.
Telegram binding은 재시작 뒤에도 유지되며 사용자가 `/new`를 보낼 때만 회전합니다.
민감정보 옵션의 profile attach가 실패하면 넓은 권한으로 fallback하지
않고 해당 Antigravity 실행이 실패해야 합니다.

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
> Telegram은 CLI와 동등한 관리자 주 채널입니다. 허용된 사용자는 `/config`, OAuth와
> 사용자가 만든 전역·workspace plugin/agent/rule/MCP를 사용하고 일반 customization을
> 수정할 수 있습니다. raw settings 직접 write는 예외이며 일반 전역 설정은
> `agy-settings patch`로 매개 수정합니다. bot
> token, 허용 chat과 Telegram 계정을 HA 관리자 credential처럼
> 보호하세요. 실제 HAOS OAuth/AppArmor/Bot API 통합 E2E는 아직 `NOT RUN`입니다.

Web UI 또는 SSH에서 `ha-antigravity-login`으로 한 번 로그인합니다. Telegram도 같은
`/data/home` identity를 사용하므로 별도 `ha-telegram-login`은 없습니다.

Bot pairing은 이 관리자 환경에 접근할 Telegram user/chat을 인증합니다. `/start`,
`/help`, `/status`, `/new`, `/cancel`은 AI를 실행하지 않고 bridge가 직접 처리하는
local control command이며, 자연어 text만 같은 Antigravity 환경으로 갑니다.

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

Telegram을 먼저 활성화했더라도 bridge는 Bot API에 연결하지 않고
`waiting_for_authorization` 상태로 조용히 대기합니다. 같은 App 터미널에서 pairing을
생성하면 App 재시작 없이 이를 감지해 연결합니다. 정적 목록을 나중에 바꾼 경우에는
App 옵션 적용을 위해 재시작합니다.

### 권한과 변경 정책

Telegram 전용 `read_only`/`confirm_changes`/`autonomous` mode는 2.0.7에서 제거됐습니다.
Web/SSH와 같은 native `antigravity_tool_permission`, 민감정보 설정과 AppArmor command
경계를 사용합니다. native nested sandbox는 사용하지 않습니다. 2.0.6 이하에서 저장된
`telegram_access_mode`는 권한으로 사용하지 않는 ignored migration input입니다.
2.0.11 관리형 runtime은 Telegram side effect를 두 typed proposal 경로로 나눕니다.
모든 HA service/config 변경은 `ha_change_propose`, terminal command·bounded inline
script·명령 선택지·유한 질문은 `telegram_action_propose`로 먼저 등록합니다. proposal
MCP 자체에는 실행 credential이나 최종 실행 socket이 없으며 exact payload digest와
public preview만 등록합니다. bridge가 requester·chat·session generation·update·
conversation·TTL을 검증해 durable 실행/선택/취소 카드를 보냅니다. 승인 뒤 HA broker
또는 credential-free executor가 card 생성 전에 검증된 action 하나만 실행합니다.

Antigravity 1.1.13 `--print --output-format stream-json`에는 native permission prompt를
외부 channel로 내보내고 승인 뒤 중단 지점에서 재개하는 protocol이 없습니다. 따라서
Telegram 버튼은 거부된 native tool turn을 resume하지 않으며 App은 임의의 미래/user
plugin MCP를 투명하게 intercept한다고 주장하지 않습니다. native permission denial을
감지하면 bridge는 같은 conversation에 proposal MCP를 쓰도록 최대 한 번 재계획을
요청하지만, 거부된 tool 자체를 승인하거나 반복 실행하지 않습니다. 두 proposal이
표현하지 못하는 Telegram side effect는 direct tool로 fallback하지 않고 fail
closed합니다.

인증된 Web/SSH의 interactive 작업은 native review와 AppArmor 아래 direct tool을 쓸
수 있고 Telegram 카드로 자동 변환되지 않습니다. 이는 같은 HOME·OAuth identity를
사용하지만 승인 transport가 다르다는 뜻입니다. shared OAuth가 이미 인증되어 있으면
지원되는 일상 작업은 Telegram만으로 끝낼 수 있지만 최초 OAuth는 controlling TTY가
필요하므로 미인증 설치는 Web/SSH에서 `ha-antigravity-login`을 한 번 실행해야 합니다.

### 명령과 세션

| 명령 | 동작 |
| --- | --- |
| `/start` | 인증 상태와 기본 안내 |
| `/help` | 사용 가능한 명령과 현재 global permission |
| `/status` | bridge와 현재 session 상태 |
| `/retry` | 전달 여부가 불명확한 현재 session 응답을 명시적으로 재전송 |
| `/new` | 해당 user·chat의 새 대화 시작 |
| `/cancel` | 현재 queue 작업 취소 요청 |

한 user·chat의 요청은 순서대로 처리되고 bounded queue, timeout과 응답 크기 제한을
적용합니다. 첫 요청은 실행 전에 conversation ID를 영속 결합하며, 이후 대화와
승인은 같은 session을 재사용합니다. 오직 `/new`만 새 session을 생성합니다.
Antigravity 결과는 Telegram 전송 전에 암호화된 영속 outbox에 기록되고 API가 전달을
확인한 뒤 제거됩니다. 429처럼 미전송이 명확한 오류만 bounded backoff로 재시도하고,
전달 여부가 모호하면 `/retry` 전까지 격리합니다. `/cancel`은 이미 외부에서 완료된 작업을 되돌리는 rollback 명령이
아닙니다.

승인/선택/거절 callback의 Telegram ACK와 기본 인증 검사는 즉시 처리하지만 승인된
broker/executor 실행은 같은 requester queue에서 session-serialized됩니다. 실행 직전에 requester·chat·
현재 session generation·conversation·proposal digest를 다시 검증합니다.
`/new`, `/cancel`, 재시작, 만료 또는 중복 callback은 기존 승인을 실행시키지 않으며,
broker의 durable idempotency record 때문에 동일 변경은 정확히 한 번만 접수됩니다.

### 승인 보안

Telegram model process는 raw Supervisor token이나 최종 실행 socket을 받지 않고 typed
proposal만 만듭니다. bridge는 coordinator/broker에서 proposal을 다시 조회한 뒤
preview를 보여 줍니다. 확인은 proposal ID, 같은 conversation·user·chat, update/run
nonce, preview/source digest와 짧은 TTL에 묶입니다. 승인 callback과 sealed result는 원
conversation의 새 turn으로 이어집니다. action은 durable state에 commit된 뒤에만
executor로 전달합니다. commit 뒤 완료를 확정할 수 없으면 `in_doubt`로 저장하고 다시
spawn하지 않습니다. preview나 precondition이 바뀌거나 확인이 만료되면 새 proposal이
필요합니다.

proposal MCP의 coordinator 등록 자체는 crash-durable하지 않습니다. 등록 성공 뒤
bridge가 encrypted approval state와 card/outbox를 봉인하기 전에 종료되면 사용자가
원래 요청을 다시 보내 새 proposal을 만들어야 합니다. durable approval이라는 표현은
봉인 이후 decision/result와 broker가 이미 접수한 실행에만 적용됩니다.

#### 멀티 선택 승인 카드

2.0.10의 `multi_choice_service_call`은 운전 모드, 밝기 preset 또는 모호한 entity처럼
한 번에 정확히 하나만 골라야 하는 작업을 위한 broker operation입니다. proposal에는
1~31개의 고유한 `choice_id`와 표시 label, 그리고 각각의 사전 검증된 Home Assistant
service call이 들어갑니다. 모든 선택지는 같은 live `/api/services` snapshot과 기존
`service_call`의 entity·`service_data`·precondition·verification·크기 제한을
통과해야 카드가 생성됩니다.

Telegram은 취소를 더해 최대 32개 버튼을 행당 최대 4개, 최대 8행으로 표시합니다.
새 카드의 선택/취소 callback은 `v3c`/`v3d`이고 기존 binary 실행/취소 카드의
`v2a`/`v2d`도 계속 처리합니다. callback에는 HA domain, service, entity 또는
`service_data`가 들어가지 않습니다. bridge가 암호화해 저장한 짧은 opaque token을
원래 `choice_id`로 해석하고, 선택을 durable state에 먼저 기록한 다음 requester·chat·
session generation·conversation·preview digest·choice·capability·idempotency를
broker와 함께 검증해 정확히 한 선택지만 실행합니다.

conversation binding, choice token mapping과 선택 결과는 bridge 재시작 뒤에도
보존됩니다. 다만 아직 실행이 접수되지 않은 proposal 본문은 change broker의
process memory에만 있으므로 broker가 계속 살아 있는 bridge-only 재시작에서만 기존
카드를 다시 검증할 수 있습니다. App 전체 또는 broker 재시작으로 proposal이
사라지면 이전 카드는 fail closed하고 새 요청이 필요합니다. broker가 이미 접수한
실행은 durable idempotency/status에서 완료 결과 또는 `in_doubt`를 회수하며 같은
service call을 다시 보내지 않습니다.

2.0.11 `multi_choice_terminal`은 같은 1~31개+취소 grid에서 각각 완성된 command 또는
inline script 중 하나를 선택합니다. `question`은 부작용 없는 label 선택을 같은
conversation에 돌려줍니다. action 카드 callback은 binary `v4a`/`v4d`, choice
`v4c`이며 command, script, cwd나 parameter 대신 encrypted state의 짧은 opaque
token만 담습니다. 실행기는 승인된 exact source digest, canonical cwd와 bounded
timeout만 받고 별도 AppArmor command profile에서 실행하며 Supervisor token, bot
token, native OAuth를 받지 않습니다. `/cancel`은 pending/approved action을 취소하지만
committed action을 rollback하지 않습니다. TTL cleanup은 untouched pending card만
만료하고 approved/answered/committed/terminal decision은 callback ACK 전까지 보존합니다.
shell-visible background/daemon pattern은 spawn 직전에 best-effort로 거부하지만 opaque
interpreter의 double-fork를 cgroup 수준으로 봉쇄하지 않으므로 daemon 작업은 지원하지
않으며, 완료 여부가 불명확하면 `in_doubt`로 기록하고 재실행하지 않습니다.

이 경로는 HA·terminal·script·question용 관리형 protocol입니다. 임의 plugin MCP의
새 side effect를 자동으로 카드화하는 범용 native hook은 아니며, 지원하지 않는 호출은
fail closed합니다. 실제 HAOS AppArmor enforce, native OAuth, live Bot API 카드/callback,
실제 service/config/command E2E는 릴리스 증거가 생기기 전까지 `NOT RUN`입니다.

broker preview는 token/secret/password/auth/key/PIN/code/credential 계열 값을 가린
bounded 요약을 표시하지만 raw payload digest에 승인을 묶습니다. `service_call`은 live
`GET /api/services`에서 모든 Home Assistant domain/service를 검증하며 optional 단일
entity 또는 최대 100개 entity 배열과 bounded plain-JSON `service_data`를 지원합니다.
broker `service_call`은 모두 고위험으로 분류되어 승인이 필요합니다. 단일 entity와 명시된
`expected_state`만 fresh state 검증을 지원하고, 그 밖에는 REST API 접수 완료까지만
정확히 보고합니다.

`config_patch`는 `secrets.yaml`, `.storage`와 기타 민감 hidden 경로를 제외한 `/config`
내 일반 YAML을 지원합니다. expected SHA, atomic backup/write와 `ha-config-check`를
수행하고 검사 실패 시 exact backup을 복원한 뒤 다시 검사합니다. activation을 생략하면
`restart_required`로 보고하며 `input_boolean`, `automation`, `script`, `scene`의 명시적
reload activation만 지원합니다. broker `config_patch`도 모두 고위험 승인 대상입니다.

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
`http://127.0.0.1:8099/`의 현재 dashboard를 관찰합니다. Telegram 자동 허용은
upstream `readOnly: true`인 console messages, network requests, snapshot, screenshot
네 도구뿐입니다. navigate/back, tabs, hover, wait, resize와 close는 mutation-capable로
분류되어 typed approval adapter가 생기기 전까지 fail closed하므로 Telegram이 직접
desktop/mobile viewport나 페이지를 전환한다고 가정하지 마세요.

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

1. 민감 deny 경로 밖의 대상과 expected SHA를 확인합니다.
2. 최소 YAML patch와 secret-redacted preview를 만듭니다.
3. 승인 뒤 atomic backup/write를 수행하고 `ha-config-check`를 실행합니다.
4. 검사가 실패하면 exact backup을 복원하고 다시 검사합니다.
5. 지원되는 명시적 reload를 실행하거나 `restart_required`로 정확히 보고합니다.
6. 의미 검증을 지원하는 작업만 fresh HA API 결과를 성공 조건에 포함합니다.

`.storage` 직접 편집과 Recorder DB 수리는 정상 작업 흐름이 아닙니다. 진단 결과만으로
restart, update, remove, restore 또는 service call이 승인되지 않습니다.

## AppArmor와 민감정보

### 항상 enforce

Supervisor는 AppArmor를 기본 활성화합니다. metadata의 중복 기본값은 생략하지만
App 디렉터리의 custom `apparmor.txt`가 기본 profile을 대체합니다. 사용자 option,
Telegram 명령, migration mode로 AppArmor를 끌 수 없고 HA 보호 모드 해제를 설치
조건으로 요구하지 않습니다. profile attach가 실패하면 넓은 권한으로 fallback하지
않아야 합니다.

2.0.12 amd64 현장 보고에서 `docker-default (enforce)`가 확인된 것은 custom policy
PASS가 아니라 attach `FAIL`입니다. 공개 2.0.13에서는 custom policy 활성화 뒤 S6가
필요한 `/run/s6`·`/run/service` 디렉터리 자체를 만들 수 없어 다음 기동이 exit 111로
실패했습니다. 2.0.14 업데이트 뒤 App terminal과 관련 service 실행 경로의
`/proc/self/attr/current` 및 Supervisor 상태에서 `antigravity_home_assistant` named
profile이 enforce인지 확인하고, `s6-mkdir` 오류와 예상하지 않은 `DENIED`를 검토하세요.
문제를 우회하려고 보호 mode나 AppArmor를 끄지 마세요.

### 민감정보 옵션

`antigravity_sensitive_data_access`는 AppArmor on/off switch가 아니라 Ingress/SSH/Telegram에서
시작한 Antigravity가 사용할 **별도 top-level 실행 프로필(discrete `Px`
transition)** 선택입니다.

| 경로 종류 | `false` 기본값 | `true` |
| --- | --- | --- |
| `/config/secrets.yaml` | read/write 거부 | read/write 거부 |
| `/config/.storage/**` | read/write 거부 | read/write 거부 |
| Recorder DB와 sidecar | read/write 거부 | 진단 read-only, write 거부 |

`true`에서도 secrets와 storage의 직접 접근, 그리고 Recorder rename, truncate,
delete, lock, DB repair와 전체 dump를 허용하지 않습니다. 읽은 진단값을 output,
memory, screenshot, proposal 또는 artifact에 복사하면 안 됩니다. 우선 supported
API와 secret key 이름만 사용하세요.

### 계속 차단되는 항목

옵션 값과 관계없이 browser, memory, broker와 일반 shell에는 민감 read 권한이
추가되지 않습니다. Web/SSH/Telegram Antigravity는 이 옵션을 함께 적용받습니다.
SSH private/host key, App·browser·bot token, backup, `/config/ssl` private material,
표준 cloud-auth 경로와 broker capability는 각 소유 process 외에는 계속 거부됩니다.
전역 plugin/MCP에는 inline secret을 넣지 말고 credential-aware wrapper나 보호된 환경
참조를 사용하세요.

Web/SSH/Telegram Antigravity는 `/data/home`과 `/config`를 의도적으로 공유합니다.
따라서 AppArmor는 정상 OAuth·사용자 설정 접근과 Telegram prompt/tool이 유도한
동일 접근을 구분하지 못합니다. 이는 격리 실패가 아니라 관리자 주 채널이라는 제품
경계이며, exact user/chat 인증, native permission, spawned executable의 AppArmor
command 전환, output redaction과 broker가 추가 방어층입니다. Telegram은 기본 OFF이며
primary OAuth backend의 실제 경로와 same-process built-in read 비유출은 실제 HAOS에서
아직 검증되지 않았습니다. 실제 HAOS OAuth/AppArmor gate와 알려진
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
| `preserve` | OAuth·사용자 settings/MCP/plugin 보존; 단, Telegram enabled이면 안전한 settings의 다섯 App 관리 보안 key와 permission 세 bucket을 exact policy로 자동 정규화; App 소유 HA plugin은 version당 canonical 보안 갱신 |
| `refresh_managed` | 위 보존·plugin 갱신에 더해 소유권이 기록된 settings key·permission rule을 root-only backup 후 merge |
| `reset_v2` | 명시적 복구 mode. 안전하게 parse 가능한 settings를 backup하고 ownership state와 무관하게 managed key와 permission 세 bucket을 image exact default로 교체 |

세 mode 모두 `/config`, native OAuth, SSH key, browser identity, memory DB와 사용자
소유 plugin/MCP를 초기화 대상으로 삼지 않습니다. `reset_v2`는 `permissions` 밖의
사용자 top-level settings와 기존 global MCP도 보존하지만 managed key 및
`permissions.allow`/`ask`/`deny` 전체는 exact default로 되돌립니다. 기존 ownership
state가 없거나 모호해도 명시 선택을 복구 권한으로 사용하며, unsafe regular file이나
parse 불가능한 JSON은 계속 fail closed합니다. `reset_v2`를 선택한 동안은 같은
version에서도 매 시작 drift를 복구하므로 정상화 뒤 `preserve`로 돌려놓으세요.
mode와 관계없이 App 소유
`home-assistant` plugin은 안전한 ownership marker가 있으면 App version당 한 번
image의 canonical copy로 갱신됩니다. 새 설치는 현재 version marker를 기록하고,
같은 이름의 marker 없는 기존 plugin은 사용자 소유 충돌로 보고 덮어쓰지 않은 채
시작을 중단합니다. 그 밖의 교체 파일은 먼저
`/data/antigravity-ha/backups/native-files/` 아래 root-only backup에 보존됩니다.
global `mcp_config.json`은 없을 때 빈 `mcpServers` 기본본만 생성하며 기존 파일은
모든 mode에서 byte-preserve합니다. HA MCP·rules·skills는 App plugin 내부에
있습니다. `refresh_managed`는 App version별 transaction 상태로 재실행을 제한합니다.
Telegram-enabled permission reconciliation도 같은 journal/backup transaction을 사용하고
같은 설정으로 재시작하면 추가 backup 없이 idempotent하게 끝납니다.

저장소 개발자가 source image를 만들 때는 `tools/development/build-app`을 사용합니다.
이 helper는 checkout hash로 분리한 project-owned Buildx builder/cache만 종료 시
제거하고 global Docker prune을 하지 않으며, checkout-owned 미참조 local image는 최신
두 개를 보존합니다. reusable release build는 stable `antigravity-home-assistant` GHA
cache scope를 사용합니다. HAOS의 Supervisor image lifecycle에는 적용되지 않습니다.

### HAOS image와 저장공간

이 App은 `config.yaml`의 generic `image:`로 GHCR prebuilt multi-arch container를
배포합니다. Home Assistant의 [App publishing
guide](https://developers.home-assistant.io/docs/apps/publishing/)가 권장하는 방식이며,
HAOS 장치는 App source나 BuildKit cache를 만들지 않고 최종 container를 받습니다.
성공한 update 뒤 구버전 App image 정리는 Supervisor가 담당합니다. 다른 App이 같은
image ID/layer를 참조하면 마지막 사용자가 교체될 때까지 유지되므로 image 목록의 여러
tag를 곧바로 중복 실사용량으로 계산하지 마세요.

이 App은 Docker socket, `docker_api`, `full_access`를 요청하지 않으며 이를 용량 정리
목적으로 추가하지 않습니다. update/start 때 `docker image prune`, `docker builder
prune` 또는 `POST /supervisor/repair`를 자동 실행하지도 않습니다. 공식
[`/supervisor/repair`](https://developers.home-assistant.io/docs/api/supervisor/endpoints/#supervisorrepair)는
stale container/image뿐 아니라 build cache, volume, network와 Supervisor 구성요소까지
복구하는 광범위한 관리자 작업입니다. failed/aborted pull, cleanup 오류 또는 overlay
장애가 로그와 용량 증거로 확인된 경우에만 별도 명시 승인을 받아 사용하세요.

용량 증가가 의심되면 Telegram에서 `ha_read_storage_usage`를 먼저 사용합니다. 이
read-only 도구는 공식
[`GET /host/disks/default/usage`](https://developers.home-assistant.io/docs/api/supervisor/endpoints/#get-hostdisksdiskusage)의
고정 endpoint에서 allowlisted 수치만 반환하므로 system, App data/config와 backup 증가를
나눠 볼 수 있습니다. 이어서 `ha_read_app_logs`와 Supervisor 로그에서 update cleanup
오류를 확인하되 token이나 option body를 복사하지 마세요. Docker image별 상세 breakdown은
이 endpoint가 제공하지 않습니다. 실제 HAOS update 전후 image/용량 관찰은 아직
`NOT RUN`이며, 이 문서는 현장 누적을 자동으로 재현·수정했다고 주장하지 않습니다.

App은 복구·갱신·config transaction이 성공 또는 unchanged로 끝난 뒤에만 backup을
정리합니다. `/data/antigravity-ha/backups/plugin-*`의 managed-plugin transaction,
`backups/native-files/refresh-*`의 native user-files refresh와
`change-broker/backups/*`의 config patch는 각각 소유 manifest와 root-owned/
no-symlink 완료 tree가 검증된 항목 중 최신 총 두 개를 보존합니다. 더 오래된 eligible
항목은 atomic quarantine 후 삭제합니다. active journal/result backup, manifest 없는
항목과 unsafe/symlink tree는 자동 삭제하지 않습니다.

`/data/antigravity-ha-memory/memory.sqlite3`는 단순 cache가 아니라 catalog provenance와
검증 history입니다. 15분 refresh가 만든 미참조 `success`/`failed` 종료 행은 최신 64개로
제한하지만, current catalog, revision, change record, metadata 또는 audit가 참조하는
sync는 계속 보존합니다. refresh 중 비정상 종료로 남은 `running` 행은 lease/PID로 live
작업과 안전하게 구분할 수 없어 자동 삭제하지 않습니다. 이 예외나 실제 semantic history
증가를 host image cache로 오인하지 마세요.

### v1 migration 주의

- v1의 managed-file refresh 값은 보수적으로 `refresh_managed`로 매핑되며
  `reset_v2`로 자동 승격되지 않습니다. v2 schema는 Supervisor가 업그레이드된
  container를 시작할 수 있도록 이 두 폐기 예정 값만 migration input으로
  수용합니다. user-file과 managed-plugin bootstrap이 성공하면 App은 고정된
  Supervisor self-options endpoint에 현재 option 전체를 보내되 이 key만
  `refresh_managed`로 바꿉니다. 요청을 사용할 수 없으면 legacy 값을 유지하고
  다음 App 시작에서 재시도합니다.
  Telegram-enabled permission reconciliation은 별도 startup boundary 예외이며 선택한
  mode를 바꾸지 않습니다.
- 이전 provider credential이나 App 전용 token을 native 인증으로 import하지
  않습니다. Google OAuth를 다시 완료해야 할 수 있습니다.
- 이전 비-native 설정과 guidance 파일은 보존될 수 있지만 Antigravity 1.1.13의
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
- Web/SSH/Telegram 공유 identity는 `ha-antigravity-login`을 실행해 CLI가 제시하는
  Google 흐름을 따릅니다.
- 존재하지 않는 login/status subcommand나 임의 API key 환경변수를 사용하지
  않습니다.
- OAuth 디렉터리를 출력하거나 수동 편집하지 않습니다.

### Telegram 응답 없음

- `telegram_enabled`, bot token 형식과 App 재시작 여부를 확인합니다.
- `waiting_for_authorization`이면 재시작을 반복하지 말고 두 정적 목록을 모두
  설정하거나 local pairing을 완료합니다. Telegram을 쓰지 않으면
  `telegram_enabled: false`로 저장합니다.
- 정적 방식이면 user와 chat 두 목록의 교집합인지 확인합니다.
- pairing 방식이면 TTL, 한 번 소비 여부와 `ha-telegram-pair list`를 확인합니다.
- `connect_retry`이면 bridge는 종료되지 않고 제한된 backoff로 Telegram 연결을
  재시도합니다. `transport_code`가 있으면 DNS, 경로 또는 TLS 문제를 구분하는
  안전한 코드이며 token이나 원문 오류는 기록되지 않습니다. `ETIMEDOUT`이 반복되는
  고지연 dual-stack 환경을 위해 App은 주소별 연결 시도를 1.5초까지 허용하며 IPv6를
  강제로 끄지는 않습니다.
- `connect_blocked`이면 Bot token 또는 요청 정책을 확인하고 App 옵션을 고친 뒤
  다시 시작합니다. 같은 4xx 요청은 자동 반복하지 않습니다.
- `permission_boundary_blocked`이면 symlink/hardlink/non-root owner, 256 KiB 초과,
  parse 불가능 또는 canonical 보안 경계를 만족하지 않는 native settings 때문에 자동
  정규화를 적용하지 못한 것입니다. bridge는 Bot API에 접속하지
  않았고 S6 재시작 loop 없이 살아서 대기합니다. broad allow를 추가하지 말고
  `reset_v2` 또는 다른 안전한 settings 복구를 적용한 뒤 App을 재시작합니다.
- `request_failed`의 `reason_class=authentication_required`이면 Bot pairing을
  반복하지 말고 신뢰하는 App 웹 터미널 또는 SSH에서 `ha-antigravity-login`을
  실행합니다.
- `reason_class=headless_read_denied`이면 headless AI의 비허용 파일 읽기가 차단된
  것입니다. 정상 질문에서 반복되면 사용자 settings를 편집하거나 `read_file(*)`를
  추가하지 말고 App을 최신 버전으로 업데이트한 뒤 재시작합니다.
- `reason_class=headless_permission_denied`가 proposal-first 재계획 뒤에도 반복되면
  요청한 side effect가 두 managed proposal MCP로 표현되지 않았다는 뜻입니다. broad
  `command(*)`/`mcp(*)`를 추가하지 말고 지원되는 HA 또는 terminal/script/question
  proposal로 요청을 바꾸거나 interactive Web/SSH에서 검토합니다.
- `/status`는 Telegram transport, 결합된 conversation과 최근 공유 AI runtime/outbox 결과를
  구분해 표시합니다. help와 status가 정상이어도 공유 native OAuth가 완료됐다는
  뜻은 아닙니다.
- `/start`, `/help`, `/status` 또는 bridge의 오류 안내가 Telegram에 도착하고
  `telegram_api_errors_total`이 증가하지 않았다면 outbound Bot API network는 정상입니다.
  `session_bound` 뒤 `request_failed`가 발생하고 `delivery_queued`가 없다면 전송 문제가
  아니라 Antigravity terminal result 검증 단계의 실패이며 `/retry`할 outbox도 없습니다.
- 이 경우 `reason_class`와 `/status`의 최근 runtime을 확인합니다.
  `terminal_missing`, `terminal_status_failed`, `terminal_response_invalid`,
  `conversation_mismatch`, `stream_contract_failed`, `proposal_result_invalid`는 prompt,
  raw model output 또는 stderr를 남기지 않는 제한된 terminal 진단입니다.
- 2.0.11은 exact `ha_change_propose` 또는 `telegram_action_propose` receipt의 필수
  `Arguments`/`ServerName`/`ToolName`과
  함께 최대 1,024 UTF-8 byte의 NUL·비공백 control-character가 없는
  `toolAction`/`toolSummary` 문자열 metadata를 허용합니다. 다른 parameter key나
  잘못된 metadata는
  `proposal_result_invalid`입니다.
- 정확히 하나의 완료된 유효 proposal receipt 뒤 terminal text만 비어 있으면 2.0.11은
  고정된 안전 문구를 사용해 승인 카드를 queue합니다. proposal이 없는 빈 응답,
  non-string 또는 32 KiB 초과 응답은 `terminal_response_invalid`로 계속 거부합니다.
- native CLI log, OAuth URL, token, prompt 원문을 지원 자료로 올리지 말고 공유 HOME의
  credential 경로를 추정하거나 수동 편집하지 않습니다.
- `--dangerously-skip-permissions`와 광범위한 file-read 허용은 사용하지 않습니다.
- 변경 preview가 달라졌거나 만료되었다면 새 요청으로 다시 승인합니다.

### Browser 또는 memory 문제

- login 화면이면 `ha-browser-auth-status`를 확인합니다. `disabled`는 옵션을 끈
  의도된 상태일 수 있습니다.
- browser option을 바꾼 뒤 App과 browser session을 새로 시작합니다.
- `ha-memory status`에서 `empty`, `degraded`, `stale`을 구분합니다.
- memory refresh 경고의 괄호 안 reason은 원문이 아닌 제한된 진단 코드입니다.
  기존 catalog를 삭제하지 말고 `ha-memory refresh --force` 결과와 같은 시각의
  Core 로그로 원인을 좁힙니다.
- browser 또는 memory 장애가 발생해도 recovery용 Web UI/SSH까지 임의로
  초기화하지 않습니다.

### 설정 변경 실패

- `ha-config-check` 결과와 scoped diff를 확인합니다.
- 검사가 실패한 상태에서 Core를 reload/restart하지 않습니다.
- broker의 precondition mismatch, expired capability 또는 `in_doubt`를 성공으로
  간주하지 않습니다. fresh state를 읽고 사람이 결과를 판단합니다.

## 검증 상태와 알려진 제한

2026-08-18 저장소 기준으로 정적·component test는 native CLI wrapper, read/change
broker, universal action proposal/coordinator/executor, Telegram binding/replay, memory,
browser 계약, migration과 AppArmor policy parse를 대상으로 합니다. 다음은 generic
개발 환경의 성공만으로 `VERIFIED`라고
표시할 수 없습니다.

- 실제 HAOS amd64의 clean install과 aarch64의 install·start·update
- 양쪽 아키텍처의 native Antigravity OAuth와 plugin discovery
- 2.0.14에서 별도 custom AppArmor 실행 프로필이 enforce 상태로 attach되고 S6가
  최초 기동·stop/start·restart를 완료하는지
- 공개 GHCR generic manifest와 per-arch digest의 실제 pull
- 실제 dashboard, live Telegram card/callback/command/HA action, migration 세 mode와
  rollback E2E

따라서 App은 experimental 상태를 유지합니다. 각 release의 CI, Builder, GHCR
manifest와 HAOS acceptance 기록에서 해당 항목이 통과했는지 확인하세요. 문서의
계획이나 unit test를 실제 장치 검증으로 해석하지 마세요.

현재 좁은 현장 증거는 2.0.12 amd64 Telegram reconcile/reconnect와 App
restart/reconnect `PASS`, 같은 image의 custom AppArmor attach `FAIL`, 공개 2.0.13의
S6/AppArmor startup `FAIL`, 2.0.14와 aarch64 실기기 `NOT RUN`입니다. 이 결과를 전체
HA-001~HA-008 또는 AA-001 PASS로 확대하지 않습니다.

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
