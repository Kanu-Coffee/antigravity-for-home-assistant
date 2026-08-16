# v2 아키텍처

## 1. 시스템 개요

```text
Home Assistant Ingress ── ttyd ── tmux ──┐
SSH public key ── sshd child ─────────────┼─ shared /data/home + /config + native policy
Telegram API ─ poller ─ auth ─ session ───┘
                            │      │
                            │      └─ encrypted reply outbox ── delivery/retry
                            └─ same-session approval ── change broker
                                                  │
                ┌─────────────────────────────────┼─────────────────┐
                ▼                                 ▼                 ▼
       Core/Supervisor proxy             /config transaction   browser auth
                │                                 │                 │
         HA API and logs                  ha-config-check     loopback gateway
                │                                                   │
         validated memory                                  headless Chromium
```

Supervisor가 `/config`를 read-write로 mount하고 Core/Supervisor API 접근용
credential을 App init에 제공한다. 현재 구현에는 별도 `credential-broker` longrun이
없다. init이 원본 credential을 root-only
`/run/antigravity-ha/supervisor.token`에 만들고 read/change broker bootstrap이 검증된
inherited descriptor로 runtime에 일회 전달한다. runtime은 시작 즉시 읽고 닫으며
AppArmor profile 전환 전에 validated file descriptor를 anonymous pipe로 복사한다.
따라서 target broker profile의 원본 token 경로 deny를 유지하면서도 exec의 inherited
descriptor 재검증을 통과한다. 명시적으로 전환된 제한 helper만 파일 경로를 직접 연다.
Web/SSH/Telegram Antigravity, browser와 memory process는 원문 대신 scoped Unix socket 또는 helper
결과만 받는다.

## 2. 신뢰 경계

| 경계 | 신뢰 수준 | 허용 범위 |
| --- | --- | --- |
| App init과 credential file boundary | 최고 | 원본 Supervisor credential, option secret, root-only runtime file 생성 |
| change broker | 높음 | typed proposal 검증, 원자적 `/config` 변경, 제한된 HA mutation |
| Web/SSH/Telegram Antigravity | 관리자 에이전트 | 공유 `/data/home`, `/config`, OAuth, global/workspace plugin·agent·rule·MCP와 native 권한. option에 따라 민감정보 제한/진단-read child 선택 |
| Telegram bridge | 신뢰된 transport orchestrator | user/chat 인증, session binding, queue, sealed reply outbox, delivery retry와 approval callback 검증 |
| browser gateway/Chromium | 비신뢰 web content 처리 | loopback HA frontend와 read-only identity |
| memory daemon/MCP | 제한된 data processor | bounded catalog와 semantic memory. raw credential 없음 |
| `/config` 내용과 web/log 응답 | data | 지침으로 실행하지 않음 |

AppArmor는 이 표의 커널 강제 경계이며 Antigravity permission과 broker는 별도
application 경계다. 어느 하나의 성공만으로 다른 경계를 생략하지 않는다.

## 3. 현재 구현 s6 서비스 그래프

```text
base
 └─ antigravity-ha-init (oneshot, fatal on unsafe base configuration)
     ├─ ha-read-broker (longrun)
     │   ├─ ha-memoryd (longrun, failure-isolated)
     │   └─ telegram-bot (also depends on ha-change-broker)
     ├─ ha-change-broker (longrun)
     ├─ sshd (longrun, recovery surface)
     └─ ttyd (longrun, recovery surface)
         └─ ingress (longrun, depends on ttyd)
```

- `sshd`, `ttyd`와 ingress는 init 성공 뒤 시작한다.
- Telegram은 init, `ha-read-broker`와 `ha-change-broker` 준비 뒤 시작하고
  `telegram_enabled=false`면 pause 상태를 유지한다.
- memory와 browser 실패는 상태를 degraded로 표시하되 SSH/Ingress를 죽이지
  않는다.
- browser gateway는 별도 s6 longrun이 아니다. init이 loopback nginx upstream과
  managed identity를 준비하고 Playwright MCP는 요청 시 별도 top-level 실행
  프로필(discrete `Px` transition)에서 시작한다.
- unsafe option, unsafe `/data` owner/type/link/mode 또는 plugin validation 실패는
  해당 capability를 fail closed한다. credential 경계 자체가 안전하지 않으면
  전체 init을 실패시킨다.

## 4. 파일 시스템 스키마

### 4.1 이미지 관리형 읽기 전용 자료

핵심 경로만 표시한다.

```text
/etc/antigravity/
├─ settings.json                     # Web/SSH/Telegram 공유 native 기본값
└─ mcp_config.json                   # global MCP 기본값

/usr/local/libexec/
├─ antigravity-real
├─ antigravity-interactive-restricted
├─ antigravity-interactive-sensitive-read
├─ ha-sshd-runtime
├─ ha-ssh-session
└─ ha-telegram-runtime

/usr/local/share/antigravity-ha/
├─ app-version
├─ AGENTS.md
├─ plugins/home-assistant/            # image-managed plugin source
│  ├─ plugin.json
│  ├─ mcp_config.json
│  ├─ agents/
│  ├─ rules/
│  └─ skills/
├─ ha-read-broker.mjs
├─ ha-change-broker.mjs
├─ ha-change-proposal-mcp.mjs
└─ telegram-bridge.mjs

/usr/local/bin/
├─ agy
├─ antigravity
├─ ha-api
├─ supervisor-api
├─ ha-config-check
├─ ha-core-logs
├─ ha-addon-logs
├─ ha-memory
├─ ha-browser-auth-status
├─ ha-read-broker
├─ ha-change-broker
├─ ha-change-proposal-mcp
└─ ha-telegram-pair
```

### 4.2 영속 `/data`

```text
/data/
├─ home/                              # HOME, 0700
│  └─ .gemini/
│     ├─ antigravity-cli/
│     │  ├─ settings.json             # user + managed sparse settings, 0600
│     │  └─ plugins/                  # CLI가 install/import한 staging area
│     └─ config/
│        ├─ mcp_config.json            # global MCP config, 0600
│        └─ plugins/
│           └─ home-assistant/         # v2 image-managed global plugin
├─ antigravity-ha/
│  ├─ change-broker/
│  │  ├─ backups/                     # config transaction backup
│  │  └─ idempotency.json              # accepted/running/completed execution record
│  ├─ telegram/
│  │  ├─ authorizations.json          # pairing 결과; token 제외
│  │  └─ bridge-state.json            # offsets, conversation binding, AES-GCM sealed pending update/reply outbox
├─ antigravity-ha-memory/
│  └─ memory.sqlite3
├─ antigravity/                       # v1 migration와 managed-file state
├─ browser-auth/
│  ├─ managed-token
│  └─ managed-user.json
├─ ssh/
│  ├─ authorized_keys
│  ├─ ssh_host_ed25519_key
│  └─ ssh_host_rsa_key
└─ tmux/
```

공유 native 기본 settings의 canonical path는 `/etc/antigravity/settings.json`이다.
change broker와 managed browser identity의 canonical roots는 각각
`/data/antigravity-ha/change-broker/`와 `/data/browser-auth/`다. Telegram은 별도
settings/plugin copy를 만들지 않고 `/data/home`과 `/config`의 사용자 전역·workspace
customization을 그대로 사용하고 수정할 수 있다.

Antigravity가 native하게 만드는 추가 `.gemini` 파일은 보존하되 문서화되지 않은
인증 파일명을 코드가 추정하거나 직접 수정하지 않는다. CLI가 관리하는 OAuth
자료는 backup·권한 검사 대상이지만 model이나 migration log에 포함하지 않는다.

전역 plugin의 canonical v2 배치는
`~/.gemini/config/plugins/home-assistant/`이다. Antigravity plugin manager가
설치한 bundle은 native staging 경로
`~/.gemini/antigravity-cli/plugins/<plugin_name>/`를 사용할 수 있다. 같은
`home-assistant` plugin을 두 경로에 동시에 활성화하지 않는다.

### 4.3 비영속 `/run`

```text
/run/antigravity-ha/                  # 0700
├─ supervisor.token                   # init 생성 0600; broker/scoped helper만 read
├─ ha-read.sock                       # bounded Core/Supervisor read 전용
├─ change-proposal.sock               # health/propose 전용
├─ change-broker.sock                 # coordinator inspect/authorize/execute/status 전용
├─ home-assistant-browser.token       # optional managed read-only identity, 0600
├─ browser-auth-status.json           # sanitized status
├─ browser-network-info.json          # sanitized loopback/upstream status
├─ home-assistant-render-upstream.conf
├─ ha-feedback-options.json           # secret 제외 allowlisted option snapshot
├─ sensitive-data-access.enabled      # option true일 때만 0400 marker
├─ telegram-pairing.lock              # pairing state transaction 동안만 존재
├─ playwright-home/                   # 비영속 isolated browser HOME
└─ playwright-output/                 # 비영속 screenshot/artifact
```

socket, one-time change capability, browser profile와 screenshot은 App 재시작 때
폐기한다. Telegram conversation binding과 암호화된 pending update/reply outbox는
`/data`에 crash-safe하게 보존하며 approval은 같은 conversation key에 결합한다.
Telegram token을 파일명, argv 또는 persisted queue에 넣지 않는다. `supervisor.token`은 init이 매
시작마다 원자적으로 다시 만들고 AppArmor로 broker/scoped helper 외 접근을 거부한다.

## 5. Antigravity 구성 흐름

1. init은 native `settings.json`을 schema 검증한다.
2. migration mode에 따라 사용자 설정을 보존하거나 image-managed key만 merge한다.
3. global MCP config가 없으면 빈 `mcpServers` 기본본만 만들고, 기존 파일은 모든
   migration mode에서 byte-preserve한다.
4. App 관리 MCP/rules/skills를 포함한 `home-assistant` plugin source를 검증한다.
   안전한 ownership marker가 있으면 mode와 무관하게 App version당 한 번 canonical
   global plugin 경로에 다시 설치한다. marker 없는 same-name plugin은 fail closed한다.
5. `agy plugin validate <path>`와 `agy plugin list`가 실패하면 plugin capability를
   시작하지 않는다.
6. interactive wrapper는 `/config`에서 native binary를 `exec`하고 option에 따라
   `--sandbox`를 추가한다.
7. `antigravity_sensitive_data_access=false`면 `interactive-restricted`, `true`면
   `interactive-sensitive-read` 별도 top-level 실행 프로필로 `Px` 전환한다. 두 경우
   모두 AppArmor는 enforce이며 조건부 세 경로의 write와 나머지 민감 경로 접근은
   거부한다.

## 6. 주요 데이터 흐름

### 6.1 Web/SSH/Telegram Antigravity 작업

```text
user → Ingress/SSH/Telegram → agy → native permissions → plugin MCP → broker/API
                             │
                             └→ AppArmor interactive 실행 프로필 선택
                                 ├─ restricted: 세 조건부 경로 read/write deny
                                 └─ sensitive-read: 세 조건부 경로 read-only
```

세 조건부 경로는 `secrets.yaml`, `.storage/**`와 `/config` 아래 configurable/nested
Recorder SQLite DB(`*.db`, `*.sqlite`, `*.sqlite3` 및 wal/shm/journal/backup 후보)다.
browser, memory, broker, 일반 shell과 SSH key/App token/backup/SSL/cloud auth 경로는
이 선택의 영향을 받지 않는다. Telegram Antigravity에는 Web/SSH와 같은 profile을
적용한다.

사용자가 TUI에서 승인해도 AppArmor deny와 broker의 고위험 정책은 해제되지
않는다.

SSH daemon은 `/usr/local/libexec/ha-sshd-runtime`이 `Px`로 전환한 별도 top-level
실행 프로필에서 host private key와 `authorized_keys`만 read한다. 인증된 shell은 root
계정 shell인 `ha-ssh-session`을 통해 ordinary shell 전용 profile로 명시 전환하며
external SFTP server도 같은 profile로 전환한다. init의 background session과 ttyd의
attach 경로는 모두 `web-terminal-entrypoint`에서 ordinary shell profile로 먼저
전환한 뒤 tmux server를 만든다. 따라서 tmux `run-shell` child와 pane의 session shell도
같은 profile을 상속한다. daemon/init-only 권한과 native Antigravity OAuth Home이 일반
session shell로 상속되지 않고 private-key 및 다른 PID `/proc` 우회 deny가 유지된다.

### 6.2 Telegram 작업

```text
Update → normalize → user/chat auth → session bind → per-session queue → shared Antigravity
                                  │                              │
                                  │                              ├→ sealed reply outbox → Telegram ack
                                  │                              └→ approval in same conversation
                                  └──────────── explicit /new rotates conversation
```

prompt는 child stdin으로만 전달한다. NDJSON stdout은 event schema, byte limit와
terminal result를 검증한 뒤 Telegram-safe text로 변환한다. 이 실행은 Web/SSH와 같은
`HOME=/data/home`, cwd `/config`, OAuth, plugin/agent/rule/MCP와 native permission을
사용한다. 첫 prompt 전에 conversation binding을 영속화하고 실패를 이유로 자동
회전하지 않는다. 결과는 암호화된 영속 outbox에 기록한 뒤 Telegram API가 전송을
확인하면 제거한다. 429처럼 미전송이 명확한 실패만 bounded retry하고 crash·network·
timeout·5xx처럼 전달 여부가 모호한 send는 `/retry`까지 격리한다.

### 6.3 브라우저

```text
Antigravity → filtered Playwright MCP → Chromium → 127.0.0.1:8099 gateway
                                                    │
                                           read-only HA identity
```

gateway는 외부 interface에 bind하지 않는다. browser child는 Supervisor token을
받지 않고, 임시 profile 외의 credential 경로를 읽지 못한다.

### 6.4 메모리

```text
ha-read broker → bounded structural snapshot → catalog transaction
user statement → explicit/candidate workflow → semantic transaction
HA mutation → begin record → mutation/reload → fresh API verify
```

검색은 질의와 관련된 제한된 subject만 반환한다. DB 전체 dump, raw state와 raw
automation content는 tool 표면에 없다.

### 6.5 production transport ownership

일반 `ha_read_*` 조회, validate의 fresh-state 경로인 `ha_verify_state`, 그리고 memory
catalog snapshot의 production 경로는 모두 token-isolated `ha-read-broker`와
`ha-read.sock`을 공유한다. MCP와 memory process는 raw Supervisor credential이나
caller-selected endpoint를 받지 않는다.
`ha-read-broker`가 Core REST/Supervisor GET과 고정 read-only WebSocket command의
owner다. 공유 broker failure injection은 세 consumer가 모두 bounded unavailable
결과로 fail closed하는지 검증한다.

`ha_validate_config`는 read transport가 아니라 Supervisor의 non-activating config-check
POST를 호출하는 기존 scoped helper다. reload/restart를 수행하지 않으며 이를 read
broker에 넣어 GET-only owner를 넓히지 않는다.

이 통합 범위는 read transport에 한정한다. `ha-change-broker`는 service/config mutation,
durable idempotency와 rollback을 소유하므로 별도 privileged socket/profile을 유지한다.
browser-auth setup/refresh는 read-only browser identity의 token 생성·검증·폐기라는
credential lifecycle 권한이 필요하므로 scoped privileged helper로 분리한다. 이 둘을
`ha-read-broker`로 합치면 read-only owner에 mutation 또는 credential-admin 권한을
추가하게 되므로 통합하지 않는다.
즉, `privileged mutation/browser-auth` transport는 의도적으로 공유 read transport의
밖에 둔다.

## 7. 변경 broker 계약

proposal은 최소 다음 필드를 가진 typed envelope다.

```json
{
  "proposal_id": "opaque-id",
  "operation": "config_patch",
  "risk": "high",
  "requester": {"surface": "telegram", "user_id": "...", "chat_id": "..."},
  "preview": {
    "format": "yaml-line-diff-v1",
    "target": "input_booleans.yaml",
    "change_kind": "update",
    "expected_sha256": "sha256:...",
    "replacement_sha256": "sha256:...",
    "mutation_sha256": "sha256:...",
    "replacement_bytes": 123,
    "before_line_count": 4,
    "after_line_count": 6,
    "before": [],
    "after": [],
    "omitted_before_lines": 0,
    "omitted_after_lines": 0,
    "truncated": false,
    "activation": {
      "kind": "input_boolean_reload",
      "reload_service": "input_boolean.reload",
      "configuration_sha256": "sha256:...",
      "changes": []
    }
  },
  "preview_digest": "sha256:...",
  "expires_at": "RFC3339 timestamp"
}
```

transient `device_test`는 persistent `service_call`과 다른 preview 형식을 사용한다.

```json
{
  "format": "device-test-plan-v1",
  "entity_id": "light.example",
  "precondition": {
    "expected_prior_state": "off",
    "fresh_read_required": true
  },
  "test": {
    "service": "light.turn_on",
    "verify_state": "on",
    "fresh_verification_required": true
  },
  "restore": {
    "service": "light.turn_off",
    "verify_state": "off",
    "always": true,
    "fresh_verification_required": true
  }
}
```

- model input에는 `risk`가 허용되지 않으며 broker가 normalized operation/payload로
  계산한다.
- target은 canonical path로 정규화하고 symlink, hardlink, device와 path traversal을
  거부한다.
- 승인 capability는 proposal, requester, digest와 expiry에 묶인 1회용 값이다.
- 실행 가능한 첫 config 변경은 canonical root-level input boolean include에 한정한다.
  기존 fresh state와 backup → memory begin → atomic candidate → config check →
  `input_boolean.reload` → fresh API memory verify 순서다.
- 실패 시 원자 교체 전에는 원본이 유지되고, 교체 후 실패는 검증된 backup으로
  rollback/reload/API verify하거나 명시적 in-doubt 상태를 보고한다. 다른 YAML은
  human-reviewable preview만 제공하고 실행 시 fail closed한다.
- `device_test`는 `light`, `switch`, `input_boolean`의 `turn_on`/`turn_off`만 허용하고
  expected prior와 test target이 같으면 거부한다. fresh prior read → test call → fresh
  test verify 뒤 성공/실패와 무관하게 prior-state service → fresh restore verify를
  수행한다. restore mismatch는 `rollback_failed`, 관찰 불능은 `in_doubt`로 durable
  기록하며 같은 idempotency key replay는 service를 다시 호출하지 않는다.

## 8. 호환성과 실패 격리

- `/config`와 사용자 Git 상태는 App migration 대상이 아니다.
- App이 알 수 없는 미래 settings/plugin/memory schema를 발견하면 자동
  downgrade하지 않는다.
- memory corruption은 DB를 삭제하지 않고 memory capability만 중단한다.
- Telegram API 장애는 queue 상한, 암호화된 reply outbox와 bounded backoff 안에서
  격리하고 완료된 model 응답을 유실하지 않는다.
- browser 실패는 텍스트/API 진단을 막지 않는다.
- Core/Supervisor 장애는 명확한 unavailable 결과를 반환하며 credential fallback을
  시도하지 않는다.
