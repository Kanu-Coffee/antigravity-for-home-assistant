# v2 보안 계약

`SEC-*`는 이 계약의 안정 식별자다. 문구나 순서가 바뀌어도 기존 번호를 다른
요구사항에 재사용하지 않는다.

## SEC-001 — 보안 목표

이 App은 `/config` read-write와 Supervisor `manager` API를 가진 production
administrator다. 목표는 Antigravity가 Home Assistant를 유용하게 관리하도록
허용하면서도 untrusted prompt, Telegram update, web content, 로그 또는 plugin
data가 다음 행위를 직접 승인하지 못하게 하는 것이다.

- credential과 민감 파일 읽기 또는 유출
- 승인되지 않은 persistent 변경이나 device service call
- AppArmor 또는 permission 경계 우회
- 다른 Telegram user/chat의 session이나 approval 탈취
- migration 중 기존 사용자 데이터 파괴

## SEC-002 — 보호 자산

- `SUPERVISOR_TOKEN`과 API authorization header
- Antigravity OAuth session, native credential backend와 `.gemini` 사용자 자료
- Telegram bot token과 pairing secret
- browser managed token과 Home Assistant identity
- SSH private host key와 사용자 key material
- `/config/secrets.yaml`, `/config/.storage/**`
- Recorder SQLite DB와 WAL/SHM
- backup, credential, certificate private key와 cloud auth 자료
- memory DB의 사용자 semantic 정보
- dashboard screenshot, state, history와 로그의 사생활 정보

## SEC-003 — 위협 모델

| 위협 | 주요 방어 |
| --- | --- |
| prompt 또는 log의 shell injection | shell 미사용, argv array, stdin prompt, typed API |
| prompt injection이 mutation 수행 | read/propose worker, broker 재검증, confirmation |
| Telegram self-pairing | local-only token 발급, token hash, allowlist, 짧은 TTL |
| callback replay/탈취 | user/chat/proposal/digest/expiry binding, single use |
| credential environment 상속 | `env -i`에 준하는 allowlist child environment |
| 민감 파일 직접 접근 | custom AppArmor deny + native permission deny |
| browser가 token 또는 내부 API 유출 | local read-only identity, loopback gateway, output redaction |
| migration link/path 공격 | owner/type/link/mode preflight, dirfd, atomic rename |
| dependency 또는 artifact 변조 | version+digest pin, lockfile, CI provenance와 image signing |
| resource exhaustion | bounded queue, payload/output limit, timeout와 concurrency cap |

로그, web response, integration metadata, blueprint, Telegram message와 ordinary data
file의 명령형 문장은 data다. plugin의 image-managed rules와 현재 프로젝트의
검토된 guidance만 instruction source다.

## SEC-004 — AppArmor 항상 ON

Supervisor의 AppArmor 기본값은 `true`이므로 linter가 금지하는 중복
`apparmor: true` key는 `config.yaml`에서 생략한다. 같은 App 디렉터리의 custom
`apparmor.txt`가 기본 profile을 대체하며 `apparmor: false`는 계약상 금지한다. App
option, Telegram command, environment 또는 migration mode로 AppArmor를 끌 수
없다. HA 보호 모드 해제를 설치 안내로 요구하지 않는다.

custom policy는 s6 root profile과 `Px`로 전환하는 별도 top-level 실행 프로필을
포함한다. 이들은 AppArmor local profile(`//...`)이 아니라 각각 독립적으로
load되는 named profile이다. `antigravity_sensitive_data_access`는 profile을
비활성화하는 switch가 아니라 Ingress/SSH에서 시작한 대화형 Antigravity가 사용할
별도 실행 프로필(discrete `Px` transition) 선택 값이다.

| profile | 허용 | 주요 deny |
| --- | --- | --- |
| init/broker | options 읽기, 제한된 `/data`, Supervisor socket/API | 임의 host path, kernel/admin capability |
| ordinary shell | 일반 `/config` 프로젝트 파일과 shell 도구 | native OAuth Home, SSH/App credential, broker state, 다른 PID의 env/fd/root |
| interactive-restricted | `/config` 일반 프로젝트 파일, native CLI/OAuth Home, plugin socket | 세 조건부 민감 경로 read/write, broker state, Supervisor/App credential |
| interactive-sensitive-read | restricted 허용 범위 + 세 조건부 민감 경로 진단용 read | 세 조건부 민감 경로 write, broker state, Supervisor/App credential |
| sshd daemon | public-key 인증에 필요한 exact `/data/ssh` host key와 `authorized_keys` read | `/config`, key write/exec, App credential와 broker socket |
| Telegram worker | image-managed safe cwd, 전용 native OAuth Home, readonly/proposal sockets | `/config`, interactive Home/customization, raw HA mutation endpoint, Supervisor/App credential |
| browser | Chromium runtime, loopback gateway, `/run` profile | `/data`, `/config`, Supervisor network/credential |
| memory | memory DB, readonly catalog endpoint | OAuth, Telegram/SSH/browser credential, `/config` write |

두 interactive profile 사이에서만 달라지는 경로는 다음 세 종류다.

| 경로 | option `false` | option `true` |
| --- | --- | --- |
| `/config/secrets.yaml` | read/write deny | diagnostic read-only, write deny |
| `/config/.storage/**` | read/write deny | diagnostic read-only, write deny |
| `/config/{,**/}*.{db,sqlite,sqlite3}{,.*,-*,~}` | read/write deny | diagnostic read-only, write deny |

마지막 pattern은 기본 `home-assistant_v2.db`뿐 아니라 configured/nested SQLite
파일, `-wal`, `-shm`, `-journal`, 점 suffix backup과 `~` backup 후보를 포함한다.
파일명만 바꿔 Recorder 보호를 우회할 수 없어야 한다.

option 값과 profile 종류에 관계없이 다음 경로와 그 하위·보조 파일은 계속
거부한다.

```text
/config/backups/**
/config/.cloud/**
/config/.ssh/**
/config/ssl/**
/data/browser-auth/**
/data/antigravity-ha/telegram/**
/data/ssh/**
/data/antigravity-ha-memory/**        # memory profile 외 deny
/data/antigravity-ha/change-broker/** # change broker 외 deny
```

`/data/home/.gemini/**`는 image-managed launcher가 `Px`로 전환한 interactive
Antigravity 실행 프로필만의 예외이며 settings/plugin을 위해 `/data/home/**`
read-write를 받는다.
Ingress/SSH/SFTP의 ordinary shell과 s6 root profile은 이 경로를 거부하고 다른 PID의
`environ`, `cmdline`, `mem`, `fd`, `root`, `map_files`를 통한 우회도 거부한다. Telegram worker는 이
경로를 거부하고 전용 `/data/antigravity-ha/telegram-home/**`만 사용한다. 성공한 HAOS
OAuth의 primary credential backend와 exact path는 아직 검증하지 않았으므로 어느
허용도 특정 OAuth 파일의 필요성으로 정당화하지 않는다. browser, memory, broker와
coordinator profile은 두 native Home을 모두 거부한다.
`antigravity_sensitive_data_access`는 이 예외를 넓히거나 줄이지 않는다.

sshd는 별도 top-level 실행 프로필에서 인증 자료를 읽은 뒤, 인증된 shell/remote command와
external SFTP를 `ha-ssh-session` 또는 `sftp-server` executable transition으로 ordinary
interactive root profile에 넘긴다. 따라서 사용자 session은 host private key read
권한을 상속하지 않는다. transition/profile 부재는 sshd profile에 남아 `/config`가
차단되는 fail-closed 결과여야 한다.

Telegram 전용 plugin copy는 image source의 exact five-server MCP inventory를 검증한
뒤 각 server의 `cwd`만 image-managed safe workspace로 파생한다. source plugin은
interactive `/config` 계약을 유지하고, worker는 파생 copy의 byte/content drift와
`/config{,/**}` 접근을 모두 거부한다.

AppArmor syntax는 generic Linux container에서만 확정하지 않는다. 처음에는
개발용 HAOS에서 `complain` audit로 필요한 access를 수집하고, allowlist를 좁힌 뒤
release candidate는 enforce 상태로 시험한다. public image와 `VERIFIED` 판정은
enforce 상태에서만 가능하다.

Telegram, browser, memory, broker와 일반 shell은 option 값으로
`interactive-sensitive-read` 권한을 얻지 않는다. option 전환 후에도 profile
attach/enforce 실패는 권한 확대로 fallback하지 않고 대화형 Antigravity 시작을
중단한다.

## SEC-005 — credential boundary와 scoped broker

- Supervisor가 주입한 원본 token은 init이 root-only runtime file로 만든다. read/change
  broker bootstrap은 owner/mode/type/link/path를 검증한 뒤 inherited descriptor로만
  anonymous pipe로 복사해 runtime에 넘긴다. runtime은 시작 즉시 한 번 읽고 닫아
  token과 descriptor 변수를 environment에서 제거한다. AppArmor exec 전환의 inherited
  descriptor 재검증은 pipe에 대해 수행되고, 장기 broker profile의 원본 token 파일
  deny는 유지된다. 명시적으로 전환된 단기 helper만 제한적으로 원본 파일 경로를 연다. 별도
  `credential-broker` longrun은 현재 구현에 없다.
- broker는 고정 endpoint와 method allowlist만 지원한다.
- proposal worker는 `/run/antigravity-ha/change-proposal.sock`의 `health/propose`만,
  Telegram coordinator는 `/run/antigravity-ha/change-broker.sock`의
  `health/inspect/authorize/execute/execute_status`만 사용한다. listener가 action allowlist를
  결정하며 request payload로 역할을 선택할 수 없다.
- mutation capability는 random 256-bit 이상, 1회용, operation·requester·digest와
  expiry에 묶는다. 원문 capability는 `/run` 0600 또는 process memory에만 둔다.
- browser identity token은 loopback gateway process에만 전달한다.
- MCP와 CLI child를 시작할 때 `SUPERVISOR_TOKEN`, `BASH_ENV`, `ENV`,
  `NODE_OPTIONS`, `NODE_PATH`와 알려지지 않은 proxy/token 변수를 제거한다.
- API error는 status와 allowlisted reason만 반환하며 response header/body 전체를
  model 또는 로그에 전달하지 않는다.

### Native OAuth 잔여 위험

Supervisor/App token broker 격리와 native OAuth 격리는 서로 다른 보장이다. 대화형
CLI는 `HOME=/data/home`, Telegram은 전용 root-owned
`HOME=/data/antigravity-ha/telegram-home`과 image-managed safe cwd를 사용한다. 성공한
HAOS OAuth session의 primary credential backend와 exact file path는 아직 검증하지
않았으므로 특정 `.gemini` 파일에 token이 있다고 가정하거나 credential을 두 HOME
사이에 복사하지 않는다.

실제 1.1.11 local positive control에서 shared HOME의 사용자 global
`mcp_config.json` stdio server가 `--agent ha-telegram`의 Google OAuth 인증 완료 전
실행됐다. 전용 worker에서는 같은 global marker와 `/config/.agents` marker가 모두
실행되지 않았고 fixed settings/빈 MCP/single managed plugin의 MCP 변조는 exit 70,
rules 변조는 fail closed로 거부됐다. 이는 custom-agent `tools` allowlist를 보안
경계로 추정한 결과가 아니라
HOME/cwd/customization source 자체를 분리하고 검증한 결과다.

그럼에도 AppArmor는 Telegram worker 자신의 정상 native OAuth 자료 접근과
prompt/tool이 유도한 동일-process 접근을 구분할 수 없다. 따라서 Telegram OAuth가
대화형 credential과 경로상 분리됐다는 local 증거를 완전한 token isolation로
표현하지 않는다. terminal sandbox, shell-free worker, MCP용 별도 실행 프로필, output
redaction과 broker가 추가 방어층이며 Telegram은 실제 HAOS OAuth 성공·비유출과
AppArmor enforce 전까지 기본 OFF 및 release blocker를 유지한다.

release 후보는 두 Antigravity profile에서 OAuth canary가 command/tool output,
Telegram reply, App log와 artifact로 유출되지 않는 negative test를 통과해야 한다.
동일 process가 임의 file-read command로 native auth 원문을 출력할 수 있거나 이를
차단했다는 증거가 없으면 공개 v2의 보안 release blocker 또는 명시적으로 승인된
known residual이다. 이 잔여 위험을 `SEC-012` 증거에서 누락한 채 보안을
`VERIFIED`로 표시할 수 없다.

## SEC-006 — 민감 파일 정책

- 기본값은 `.storage`, Recorder DB와 `secrets.yaml` 직접 읽기·쓰기를 모두
  거부하며 API history/statistics와 key 이름을 우선 사용한다.
- 사용자가 `antigravity_sensitive_data_access=true`를 선택한 경우에만 대화형
  child가 이 세 종류를 진단 목적으로 읽을 수 있다. 직접 편집, rename, truncate,
  delete, lock과 DB repair는 계속 거부한다.
- Recorder DB는 SQLite read-only 방식으로만 열고 WAL/SHM도 read-only다. 전체 DB
  dump나 context 적재는 허용하지 않는다.
- 설정 검사가 secret을 Core 내부에서 해석하는 것은 option과 무관하게 가능하다.
- 읽은 값은 model output, 로그, memory, screenshot, proposal 또는 artifact에
  복사하지 않는다.
- screenshot, state와 로그도 민감 자료로 보고 artifact lifetime과 공유 범위를
  제한한다.

read broker의 state redaction은 무제한 비밀 탐지 보장이 아니다. entity/attribute key가
`secret`, `token`, `password`, `credential`, `api_key`, `authorization` 계열이거나 값이
실제 Supervisor token, Bearer/JWT/private-key marker, credential 포함 URL이라는 bounded
신호를 만족할 때 해당 state/value를 fail closed로 가린다. 일반 `on`/`off`/수치 상태와
allowlist attribute 진단은 유지한다. 이 규칙에 걸리지 않은 state도 사생활 정보일 수
있으므로 SEC-002의 민감 자산 및 공유 제한은 그대로 적용한다.

## SEC-007 — 변경 승인과 위험도

진단 결과는 변경 권한이 아니다. broker가 operation과 target을 기준으로 위험을
재분류한다.

### 항상 고위험

- door lock 해제, gate 또는 garage door 열기
- alarm disarm 또는 보안 장치 비활성화
- 안전 관련 heating, boiler, gas, water valve와 pump 변경
- host, Core 또는 Supervisor restart/shutdown
- backup restore, App 제거, DB 삭제·교체·truncate
- Home Assistant Core, OS, Supervisor, App 또는 custom integration update
- user, group, token, credential, network trust 또는 permission 변경
- AppArmor, 보호 모드, broker policy 또는 audit 기능 약화
- secrets, SSH key, browser identity 또는 Telegram 인증 자료 변경

`autonomous`에서도 위 작업은 같은 현재 사용자·채팅의 명시적 확인이 필요하다.
작업 종류가 애매하면 높은 위험으로 분류한다.

v2 최소 구현은 안전 metadata가 검증되지 않은 모든 `service_call`을 높은 위험으로
분류한다. `autonomous`도 사람 확인 없이는 실행하지 않는다.

### 저위험 조건

저위험 자동 실행 후보는 다음 조건을 모두 만족해야 한다.

- 정책에 명시된 typed operation이다.
- target이 민감 경로가 아니다.
- rollback 또는 이전 상태 복원이 정의돼 있다.
- config 변경이면 사전 backup과 `ha-config-check`가 가능하다.
- device test이면 대상과 이전 상태가 기록되고 안전하게 복원 가능하다.
- 권한, update, restart, deletion 또는 safety domain을 포함하지 않는다.

하나라도 충족하지 않으면 확인 대상으로 승격한다.

현재 구현에서 이 조건을 모두 만족하는 typed operation은 canonical root-level
`input_boolean: !include`를 대상으로 restricted helper parser와
`input_boolean_reload` activation/rollback plan을 통과하고 fresh API로 완전히 확인되는
기존 helper의 `name`/`icon` metadata update뿐이다. helper create/remove, 기존 metadata
제거, 임의 YAML과 모든 `service_call`은 low로 분류하지 않는다.

## SEC-008 — Telegram 보안 불변조건

- user ID와 chat ID를 모두 검증한다. username과 display name은 인증 자료가 아니다.
- 미인증 요청에는 pairing token, deep link, allowlist 내용이나 실패 상세를 보내지
  않는다.
- callback은 최초 requester가 최초 chat에서 눌러야 한다.
- preview 내용이 바뀌면 기존 confirmation은 무효다.
- mode 변경은 Home Assistant App 설정에서만 가능하고 Telegram prompt로 바꾸지
  않는다.
- raw prompt를 shell source, filename, tmux command 또는 log message에 넣지 않는다.
- Telegram worker는 interactive profile보다 좁은 별도 AppArmor 실행 프로필(discrete
  `Px` transition)을 쓴다.

## SEC-009 — 브라우저 보안

- canonical dashboard URL은 `http://127.0.0.1:8099/`다.
- gateway는 loopback에만 bind하고 forwarded client IP를 합성하지 않는다.
- 관리형 HA user는 active, local-only, non-system, non-admin, sole
  `system-read-only` group이어야 한다. 조건이 달라지면 자동 수정하지 않고
  fail closed한다.
- Chromium은 isolated temporary profile로 headless 실행한다.
- 임의 code execution, file upload/download와 unrestricted navigation tool은
  기본 MCP allowlist에 없다.
- web page text는 approval이나 shell/API 작업을 승인할 수 없다.
- browser output에서 token과 authorization 값을 exact-match와 구조 기반으로
  정화한다. 정화 실패 시 출력 전체를 폐기한다.

## SEC-010 — 메모리와 개인정보

- catalog에는 identifier, domain, 안전한 display metadata와 관계만 저장한다.
- state value, attribute payload, timestamps, history, raw automation action/template,
  raw conversation과 credential은 저장하지 않는다.
- 사용자 semantic memory는 정확한 subject와 provenance를 요구한다.
- pending 또는 verified-but-unapplied candidate를 활성 기억처럼 반환하지 않는다.
- Home Assistant fresh API 구조가 structural memory보다 우선하며 명시적 사용자
  설명이 inferred semantic memory보다 우선한다.
- DB dump나 무제한 search tool을 제공하지 않는다.

## SEC-011 — 로그와 사고 대응

허용 로그 필드:

```text
timestamp, service, event, correlation_id, requester_hash,
operation_class, risk, duration_ms, result_code, retry_count
```

금지 로그 필드:

```text
raw prompt, raw model output, token, authorization header, pairing secret,
callback payload, entity state value, secret file content, full API body
```

Telegram transport offset을 먼저 확인해 crash 시 prompt가 유실되는 것을 막기 위해,
처리 중인 normalized update는 Bot token 파생 HKDF-SHA256 key와 record별 nonce의
AES-256-GCM ciphertext로만 bounded state에 보존한다. plaintext/token canary가 state에
나타나거나 decrypt authentication이 실패하면 polling은 fail closed 하며, ack된
record는 atomic state update에서 즉시 제거한다. pending record가 있을 때 Bot token을
rotate하지 않으며, accidental rotation/tamper 시 service를 중지하고 기존 token 복원
또는 state 보존·격리 후 명시적 폐기를 선택한다. bridge가 ciphertext를 자동 삭제하거나
빈 offset에서 진행하지 않는다.

credential 노출이 의심되면 해당 service를 중지하고 token을 revoke/rotate한 뒤
`/run` artifact를 폐기한다. 공개 이슈를 만들지 말고 private security reporting
경로를 사용한다. 데이터 삭제나 backup 복원은 별도 사용자 승인을 받는다.

## SEC-012 — 보안 완료 증거

- AppArmor enforce HAOS E2E와 예상 deny audit
- prompt/command/callback injection 회귀
- child environment allowlist와 token canary 비노출
- interactive/Telegram native OAuth canary 비유출과 동일-process 잔여 위험 기록
- 실제 1.1.11에서 Telegram 전용 customization 격리: user global stdio MCP가 인증
  전후 실행되지 않고 user/workspace plugin·agent·rule·MCP가 worker를 확장하지 않음
- symlink/hardlink/FIFO/path traversal migration 회귀
- Telegram auth, replay, expiry와 cross-chat negative test
- browser console/network/screenshot redaction test
- dependency checksum, SBOM, provenance와 signed multi-arch image

local 전용-HOME canary는 shared-HOME global MCP pre-auth launch 경로를 닫았지만,
이 증거 중 하나라도 빠지거나 native OAuth 동일-process 잔여 위험과 실제 HAOS
OAuth/AppArmor gate가 해결되지 않으면 v2 보안은 `VERIFIED`가 아니며 Telegram은
기본 OFF인 채 public release를 차단한다.
