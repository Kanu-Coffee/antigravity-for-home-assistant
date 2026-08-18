# v2 보안 계약

`SEC-*`는 이 계약의 안정 식별자다. 문구나 순서가 바뀌어도 기존 번호를 다른
요구사항에 재사용하지 않는다.

## SEC-001 — 보안 목표

이 App은 `/config` read-write와 Supervisor `manager` API를 가진 production
administrator다. 목표는 Antigravity가 Home Assistant를 유용하게 관리하도록
허용하는 것이다. 인증된 Telegram user/chat의 직접 요청은 CLI 입력과 같은 관리자
instruction이다. 반면 그 요청으로 읽은 web content, 로그, 파일과 tool output은
untrusted data이며 다음 행위를 직접 승인하지 못한다.

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
- backup, App 소유 credential, certificate private key와 표준 cloud-auth 경로
- memory DB의 사용자 semantic 정보
- dashboard screenshot, state, history와 로그의 사생활 정보

## SEC-003 — 위협 모델

| 위협 | 주요 방어 |
| --- | --- |
| prompt 또는 log의 shell injection | shell 미사용, argv array, stdin prompt, typed API |
| 외부 data의 prompt injection이 mutation 수행 | proposal-first policy, broker/coordinator 재검증, same-session confirmation |
| Telegram self-pairing | local-only token 발급, token hash, allowlist, 짧은 TTL |
| callback replay/탈취 | conversation/user/chat/session generation/proposal/digest/choice/expiry/idempotency binding, single use |
| credential environment 상속 | `env -i`에 준하는 allowlist child environment |
| 민감 파일 직접 접근 | custom AppArmor deny + native permission deny |
| browser가 token 또는 내부 API 유출 | local read-only identity, loopback gateway, output redaction |
| migration link/path 공격 | owner/type/link/mode preflight, dirfd, atomic rename |
| update 뒤 stale permission이 Telegram approval을 우회하거나 bridge를 crash-loop시킴 | Telegram-enabled canonical reconciliation, shared validator, Bot API 전 live fail-closed hold |
| dependency 또는 artifact 변조 | version+digest pin, lockfile, CI provenance와 image signing |
| resource exhaustion | bounded queue, payload/output limit, timeout와 concurrency cap |

로그, web response, integration metadata, blueprint와 ordinary data file의 명령형
문장은 data다. 인증된 Telegram sender가 보낸 직접 요청은 Web/SSH 입력과 동일한
instruction source이며, global/workspace plugin·agent·rule/MCP도 의도적으로 상속한다.
2.0.11 새 설치와 Telegram의 유일한 effective native 값인 `request-review` managed
policy는 bounded native/HA read, exact `ha_change_propose`/
`telegram_action_propose`와 upstream `readOnly: true` Playwright 네 도구만 unattended
allow한다. `strict`와 legacy autonomous schema 값은 upgrade 입력 호환용이며 updater가
`request-review`로 정규화한다. 일반 native write, URL execute, command,
mutation-capable browser와 arbitrary mutation MCP는 허용하지 않는다. 2.0.9/2.0.10 App-owned broad allow는 안전하게 ownership을 확인한 경우
migration하며 user-owned rule과 stronger deny는 보존한다.

2.0.12에서 `telegram_enabled=true`인 startup은 위 2.0.11 일반 migration보다 강한
permission 경계다. root-owned single-link regular·256 KiB 이하의 parse 가능한 existing
settings를 transaction backup한 뒤 `allowNonWorkspaceAccess=false`,
`artifactReviewPolicy=agent-decides`, `toolPermission=request-review`,
`enableTerminalSandbox=false`와 permission 세 bucket(29 allow/0 ask/33 deny)을 shared
canonical policy로 교체한다. 이때 bucket 안의 user-owned rule과 stronger deny는 보존
대상이 아니지만 이 다섯 보안 key 밖의 unrelated top-level settings, global MCP/plugin,
OAuth와 `/config`는 변경하지 않는다. 기존 mode는 0600으로 강화하고 option mode는
자동으로 `reset_v2`가 되지 않는다.

## SEC-004 — AppArmor 항상 ON

Supervisor의 AppArmor 기본값은 `true`이므로 linter가 금지하는 중복
`apparmor: true` key는 `config.yaml`에서 생략한다. 같은 App 디렉터리의 custom
`apparmor.txt`가 기본 profile을 대체하며 `apparmor: false`는 계약상 금지한다. App
option, Telegram command, environment 또는 migration mode로 AppArmor를 끌 수
없다. HA 보호 모드 해제를 설치 안내로 요구하지 않는다.

custom policy는 s6 root profile과 `Px`로 전환하는 별도 top-level 실행 프로필을
포함한다. 이들은 AppArmor local profile(`//...`)이 아니라 각각 독립적으로
load되는 named profile이다. `antigravity_sensitive_data_access`는 profile을
비활성화하는 switch가 아니라 Ingress/SSH/Telegram에서 시작한 Antigravity가 사용할
bootstrap/runtime 쌍(discrete `Px` transition) 선택 값이다. runtime이 시작하는 일반
command와 stdio tool executable은 다시 공통 command profile로 전환한다.

Supervisor 2026.07.5의 App policy primary scanner는 column 0의 `^profile[ ]` 선언을
정확히 하나만 허용한다. 2.0.12처럼 독립 profile 선언 23개를 모두 column 0에 두면
custom file 자체를 거부해 실제 amd64에서 `docker-default (enforce)` fallback이
관찰됐다. 2.0.13은 slug primary만 column 0에 두고 다른 22개 선언을 들여쓰지만,
AppArmor parser에는 계속 별도 global named profile이며 기존 `Px transition`과 deny를
그대로 유지한다. 들여쓰기는 Supervisor presentation 호환성이지 profile nesting이나
권한 병합이 아니다.

공개 2.0.13의 실제 HAOS amd64 startup에서는 이 custom 경계가 S6보다 먼저 적용됐지만
descendant-only `/run` rule이 `/run/s6`와 `/run/service` directory entry의 생성을
허용하지 않아 exit 111로 실패했다. 2.0.14는 S6 runtime directory·container exit
result와 nginx PID의 exact access만 허용했지만, 실제 amd64 HAOS에서 다음 init의
resolved `/usr/lib/bashio/bashio` execute가 거부되어 exit 126으로 `FAIL`했다.
`/command/with-contenv`도 실제 S6 package target으로 resolve된다. 2.0.15의 후속
cold-start trace는 다음 profile-scoped closure를 요구한다.

- primary/init의 `/usr/lib/bashio/bashio`, init의 exact
  `execline`·`s6-envdir`·`with-contenv`, narrow shell 기반 profile의 resolved
  `/usr/bin/bash`, Telegram의 resolved `s6-pause`, shell의 architecture-bound
  `utempter`, browser의 `/usr/lib/chromium/chromium`과
  `chrome_crashpad_handler`만 execute한다. browser profile 전환 뒤 interpreted
  Playwright runtime과 traced font/config metadata만 읽는다.
- init은 passwd/shadow lock·교체 파일과 nginx PID/temp state만 갱신하고, sshd는
  `owner @{PROC}@{pid}/oom_score_adj`, shell은 `/run/utmp`·`/var/log/wtmp`, HA feedback helper는
  `/config/antigravity-workspace/feedback/**`, browser는
  `/var/cache/fontconfig/*`만 해당 기능에 맞게 갱신한다.
- 새로운 `/run/**`, `/usr/lib/**`, `/package/admin/**` 전체 execute, `/etc/**` 전체 write나
  credential·민감정보 경계를 넓히는 우회는 추가하지 않는다.

kernel-enforced 자동 startup/restart smoke는 실제 profile attach와 안전하게 준비한
`/config/secrets.yaml` read-denial canary를 검사하지만 HAOS 증거가 아니며, 2.0.15 HAOS
enforce 수용은 `NOT RUN`이다.

| profile | 허용 | 주요 deny |
| --- | --- | --- |
| init | options, exact resolved startup executable, passwd/shadow lock·nginx runtime state | broad library/package execute, broad `/etc` write, 임의 host path |
| broker | 제한된 `/data`, Supervisor socket/API | 임의 host path, kernel/admin capability |
| ordinary shell | 일반 `/config`, shell 도구, exact `utempter`와 login accounting | native OAuth Home, SSH/App credential, broker state, 다른 PID의 env/fd/root |
| interactive bootstrap | clean environment copy와 image-owned `antigravity-real`로 단일 전환 | HOME/OAuth, `/config` data, runtime credential |
| interactive-runtime-restricted | Web/SSH/Telegram의 `/config` 일반 프로젝트 파일, native CLI/OAuth Home read, 사용자 customization, plugin socket, 매개 settings update helper 실행 | raw settings direct write; secrets/storage/Recorder read/write; runtime token/options, SSH/private key, broker state |
| interactive-runtime-sensitive-read | restricted runtime 허용 범위 + Recorder DB 진단용 read | raw settings direct write; secrets/storage read/write; Recorder write, runtime token/options, SSH/private key, broker state |
| `antigravity_home_assistant-command` | 일반 `/config`, network, user plugin/agent/rule/skill과 scoped helper | OAuth backend, App 관리 settings/MCP config, token, secrets/storage/Recorder, broker state |
| Telegram action proposal client | active run-bound private proposal socket write | `/config`/`/data` content, token, OAuth, final executor |
| Telegram action executor | exact committed action envelope와 fixed shell transition | Supervisor/bot token, OAuth, App settings/MCP config, proposal socket |
| Telegram runtime | exact resolved `s6-pause`와 bridge runtime | settings write, Supervisor credential, direct mutation fallback |
| sshd daemon | public-key 인증용 exact key read와 own OOM-score/accounting state | `/config`, key write/exec, App credential와 broker socket |
| HA feedback helper | sanitized report의 exact `/config/antigravity-workspace/feedback/**` subtree | 그 밖의 `/config` write, runtime credential와 broker socket |
| browser | interpreted Playwright runtime read, exact Chromium/crashpad runtime, traced font/config read·cache, loopback gateway, `/run` profile | `/data`, `/config`, Supervisor network/credential |
| memory | memory DB, readonly catalog endpoint | OAuth, Telegram/SSH/browser credential, `/config` write |

두 interactive runtime profile 사이에서 달라지는 경로는 Recorder DB 진단 read뿐이다.
secrets와 `.storage`는 두 profile 모두 직접 read/write를 거부한다.

| 경로 | option `false` | option `true` |
| --- | --- | --- |
| `/config/secrets.yaml` | read/write deny | read/write deny |
| `/config/.storage/**` | read/write deny | read/write deny |
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

`/data/home/.gemini/**`는 image-managed launcher가 bootstrap을 거쳐 `Px`로 전환한
Web/SSH/Telegram Antigravity runtime만의 예외다. runtime은 인증과 global
customization을 위해 shared HOME을 읽고 일반 사용자 전역 파일을 쓸 수 있지만 App
관리 `settings.json`의 raw direct write는 native permission exact deny다. 일반 전역
설정은 interactive Web/SSH에서 digest-bound `agy-settings patch`가 별도
settings-update profile로 원자적으로 매개 수정하며, `permissions`,
`enableTerminalSandbox`, `allowNonWorkspaceAccess`, `toolPermission`,
`artifactReviewPolicy`는 거부한다. Telegram action과 command profile은 OAuth backend와
App 관리 settings/MCP config를 읽거나 쓸 수 없다.
Ingress/SSH/SFTP의 ordinary shell과 s6 root profile은 이 경로를 거부하고 다른 PID의
`environ`, `cmdline`, `mem`, `fd`, `root`, `map_files`를 통한 우회도 거부한다. 성공한 HAOS
OAuth의 primary credential backend와 exact path는 아직 검증하지 않았으므로 어느
허용도 특정 OAuth 파일의 필요성으로 정당화하지 않는다. browser, memory, broker와
coordinator profile은 native Home을 거부한다.
`antigravity_sensitive_data_access`는 이 예외를 넓히거나 줄이지 않는다.

sshd는 별도 top-level 실행 프로필에서 인증 자료를 읽은 뒤, 인증된 shell/remote command와
external SFTP를 `ha-ssh-session` 또는 `sftp-server` executable transition으로 ordinary
interactive root profile에 넘긴다. 따라서 사용자 session은 host private key read
권한을 상속하지 않는다. transition/profile 부재는 sshd profile에 남아 `/config`가
차단되는 fail-closed 결과여야 한다.

Telegram은 별도 plugin copy를 만들지 않는다. Web/SSH와 같은 `/data/home` global 및
`/config` workspace plugin·agent·rule·MCP를 로드한다. mutation은 승인된 HA/action
proposal로만 수행하며 native MCP config와 App-owned permission settings는 보호한다.

AppArmor syntax는 generic Linux container에서만 확정하지 않는다. 처음에는
개발용 HAOS에서 `complain` audit로 필요한 access를 수집하고, allowlist를 좁힌 뒤
release candidate는 enforce 상태로 시험한다. public image와 `VERIFIED` 판정은
enforce 상태에서만 가능하다.

browser, memory, broker와 일반 shell은 option 값으로 sensitive runtime 권한을 얻지
않는다. Web/SSH/Telegram Antigravity에는 동일한 option을 적용하며 bootstrap/runtime/
command profile attach 또는 enforce가 실패하면 권한 확대로 fallback하지 않고 실행을
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

Supervisor/App token broker 격리와 native OAuth 접근은 서로 다른 보장이다.
Web/SSH/Telegram은 `HOME=/data/home`과 `/config`를 의도적으로 공유하므로 Telegram
Antigravity가 OAuth 자료와 사용자 customization에 접근할 수 있다는 사실을 isolation
failure로 취급하지 않는다. 특정 `.gemini` credential 파일명이나 backend는 여전히
추정·수동 편집하지 않는다.

실제 1.1.11 local positive control에서 shared HOME의 사용자 global
`mcp_config.json` stdio server가 OAuth 인증 완료 전에도 실행될 수 있음이 확인됐다.
2.0.7은 이 동작을 차단하는 대신 Telegram을 관리자 주 채널로 명시하고 global 및
workspace plugin·agent·rule·MCP 상속을 제품 계약으로 채택했다. 2.0.11 mutation은
proposal-first 승인 경계로 제한한다.

AppArmor는 정상 OAuth·settings 접근과 Telegram prompt/tool이 유도한 동일-process
접근을 구분할 수 없다. command/stdio MCP executable은 별도 command profile로
전환되어 OAuth·settings·MCP config를 읽지 못하지만, native built-in file tool이나
trusted extension처럼 runtime process 안에서 끝나는 동작은 executable transition으로
투명하게 가로챌 수 없다. 2.0.11은 arbitrary native/plugin tool을 승인 대상으로
가로챘다고 주장하지 않고, exact managed proposal이 표현하지 못하는 Telegram side
effect를 fail closed한다. App 관리 `settings.json`과 native MCP config의 raw write는
native permission exact deny로 별도 차단한다.
따라서 exact user/chat 인증과 Telegram 계정·bot token 보호가 여전히 관리자 경계다.
shell-free transport, output redaction과 broker는 추가 방어층이며 전체 same-process
credential isolation 보장이 아니다.

release 후보는 공유 Antigravity runtime에서 command/tool OAuth canary가 command
profile에 들어가고 Telegram reply, App log와 artifact로 유출되지 않는 negative test를
통과해야 한다. generic container에서 functional transition 입력과 정적 policy를
검증해도 실제 HAOS enforce 결과는 아니다. 동일 process의 임의 native file read를
차단했다는 증거가 없으면 공개 v2의 보안 release blocker 또는 명시적으로 승인된 known
residual이다. 이 잔여 위험과 실제 HAOS `NOT RUN`을 `SEC-012` 증거에서 누락한 채
보안을 `VERIFIED`로 표시할 수 없다.

## SEC-006 — 민감 파일 정책

- `.storage`, `secrets.yaml`, App 소유 runtime option/token, SSH/private key와 표준
  cloud-auth 경로의 직접 읽기·쓰기는 option과 관계없이 거부하며 API와 secret key
  이름을 우선 사용한다. spawned command/stdio tool은 native OAuth backend도 AppArmor로
  읽을 수 없다.
- 사용자가 관리하는 전역 plugin/MCP 설정에 inline한 secret은 신뢰된 확장 컨텍스트로
  분류하며 이 exact-deny 보장 밖이다. inline header/client secret 대신
  credential-aware wrapper나 보호된 환경 참조를 사용한다.
- OAuth를 사용하는 native parent는 `/data/home`을 읽어야 하므로 same-process built-in
  read와 정상 인증 read를 AppArmor로 구분하지 못한다. primary backend 실제 경로와
  비유출은 HAOS에서 미검증이며 `SEC-012`의 잔여 위험으로 유지한다.
- `antigravity_sensitive_data_access=true`일 때만 Web/SSH/Telegram Antigravity child가
  Recorder DB와 sidecar를 진단 목적으로 읽을 수 있다. 직접 편집, rename, truncate,
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

## SEC-007 — App-managed broker 변경 승인과 위험도

진단 결과는 변경 권한이 아니다. 관리형 runtime rule은 일반 HA service/config 변경을
`ha_change_propose`로 라우팅하며 broker가 operation과 target을 기준으로 위험을
재분류한다. 이 절의 always-confirm 보장은 `ha_change_propose`로 제출된 App-managed
broker operation에 적용된다.

Telegram terminal/script/question mutation은 별도 `telegram_action_propose` 경계와
credential-free executor를 사용한다. authenticated Web/SSH direct tool은 native
interactive review와 AppArmor 아래 동작하지만 Telegram headless mutation은 direct
fallback하지 않는다. pinned CLI가 arbitrary permission prompt를 external resume할 수
없으므로 두 proposal이 표현하지 못하는 side effect는 fail closed한다.

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

App-managed broker에 제출된 위 작업은 global native permission과 관계없이 같은 현재
conversation·사용자·채팅의 명시적 확인이 필요하다.
작업 종류가 애매하면 높은 위험으로 분류한다.

모든 App-managed broker `service_call`, `multi_choice_service_call`, `config_patch`는
높은 위험으로 분류하고 durable Telegram 확인 없이는 실행하지 않는다. service call은
live `/api/services`에서 domain/service를 검증하고 bounded plain-JSON
`service_data`만 받는다. multi-choice는 최대 31개 상호 배타적 service call을 같은 live
registry snapshot에서 모두 검증하고 선택한 하나만 실행한다. config patch는
민감 경로 밖의 `/config` YAML에 expected SHA, atomic backup/write, config check와
exact rollback을 적용한다.

### 저위험 조건

저위험 자동 실행 후보는 다음 조건을 모두 만족해야 한다.

- 정책에 명시된 typed operation이다.
- target이 민감 경로가 아니다.
- rollback 또는 이전 상태 복원이 정의돼 있다.
- config 변경이면 사전 backup과 `ha-config-check`가 가능하다.
- device test이면 대상과 이전 상태가 기록되고 안전하게 복원 가능하다.
- 권한, update, restart, deletion 또는 safety domain을 포함하지 않는다.

하나라도 충족하지 않으면 확인 대상으로 승격한다.

현재 App-managed broker 구현은 service call과 config patch를 모두 high로 승격하므로
broker에서 저위험 자동 실행하는 mutation은 없다. `expected_state`/`verify_state`는
단일 entity의 선택적 결과 검증일 뿐 risk를 낮추지 않는다.

## SEC-008 — Telegram 보안 불변조건

- user ID와 chat ID를 모두 검증한다. username과 display name은 인증 자료가 아니다.
- 미인증 요청에는 pairing token, deep link, allowlist 내용이나 실패 상세를 보내지
  않는다.
- callback은 최초 conversation·requester·chat에서 눌러야 하고 승인 결과도 그
  conversation에 전달한다.
- approval callback ACK와 기본 인증/control 처리는 즉시 수행하되 승인된 broker/executor 실행은
  requester FIFO에서 session-serialized한다. 실행 직전 현재 session generation·
  conversation과 durable approval binding을 다시 검증한다. `/new`, `/cancel`,
  restart, expiry 또는 duplicate callback은 stale proposal을 실행하지 않는다.
- multi-choice callback은 executable service parameter나 raw `choice_id`가 아닌 opaque
  token만 싣는다. encrypted approval state의 token→choice mapping과 선택을
  authorization 전에 영속화하고 requester/chat/session generation/conversation/
  proposal digest/choice/capability/idempotency를 모두 일치시킨다.
- 최대 31개 choice와 cancel을 4×8 inline-keyboard로 표시한다. 새 `v3c`/`v3d`
  protocol과 기존 `v2a`/`v2d` binary callback을 operation 종류에 맞게 분리하며 unknown
  token, protocol 혼합과 두 번째 다른 선택은 거부한다.
- action approval은 binary `v4a`/`v4d`, choice `v4c` protocol을 사용한다. callback에는
  command/script/cwd/parameter를 넣지 않고 encrypted durable record의 opaque token만
  둔다. `terminal_command`, `multi_choice_terminal`, `question`만 지원한다.
- terminal/script action은 requester/session/update/run/conversation/source digest와
  결합하고 durable commit 뒤 credential-free executor에 한 번만 전달한다. commit 뒤
  완료를 증명할 수 없으면 `in_doubt`이며 다시 spawn하지 않는다.
- broker idempotency record는 동일 requester/proposal/choice 실행을 정확히 한 번만
  접수한다.
- preview 내용이 바뀌면 기존 confirmation은 무효다.
- Telegram 전용 mode는 없다. `antigravity_tool_permission`과 민감정보 option을
  Web/SSH와 동일하게 사용한다. 비특권 HAOS에서 실패하는 native sandbox는 세 채널
  모두 사용하지 않고 일반 command/stdio tool executable을 공통 command profile로
  전환한다. legacy `antigravity_terminal_sandbox`는 어느 값이든 `false`로 정규화한다.
- 최초 prompt 실행 전에 conversation binding을 영속화하고 `/new` 외에는 Antigravity
  실패·재시작·전송 실패를 이유로 conversation을 회전하지 않는다.
- bridge 재시작은 broker가 계속 살아 있을 때 encrypted choice mapping과 proposal을
  재검증해 계속할 수 있다. full App/broker 재시작으로 아직 접수하지 않은 in-memory
  proposal이 사라지면 오래된 card는 실행하지 않고 새 요청을 요구한다. 이미 broker가
  접수한 execution은 durable status/result만 회수하며 mutation을 다시 dispatch하지
  않는다.
- proposal MCP의 coordinator registration 자체는 crash-durable하지 않다. registration
  성공 뒤 encrypted approval state와 card/outbox sealing 전 bridge crash가 나면
  사용자에게 원 요청 재시도를 요구한다. durable 보장은 sealing 이후 decision/result와
  이미 접수된 execution부터 적용한다.
- 완료 응답은 Telegram 전송 전에 암호화된 영속 outbox에 기록하고 API ack 뒤
  제거한다. 429처럼 미전송이 명확한 오류만 자동 재시도하고 crash·network·timeout·
  5xx처럼 전달 여부가 모호하면 `/retry`까지 격리한다.
- raw prompt를 shell source, filename, tmux command 또는 log message에 넣지 않는다.
- Telegram 실행은 Web/SSH와 같은 Antigravity AppArmor profile과 native 사용자
  customization을 사용한다.
- native `stream-json` permission prompt는 Telegram callback으로 resume할 수 없다.
  HA mutation은 `ha_change_propose`, terminal/script/choice/question은
  `telegram_action_propose`를 먼저 사용한다. 임의 future/plugin MCP는 transparent
  intercept 대상이 아니며 unsupported side effect는 fail closed한다.
- 2.0.11 managed permissions의 유일한 effective native 값은 `request-review`이며,
  bounded reads, exact proposal MCP와 upstream read-only Playwright 네 도구를 제공한다.
  schema의 `strict`/autonomous 값은 upgrade input으로만 수용하고 updater가
  `request-review`로 정규화한다. 2.0.9/2.0.10 App-owned `mcp(*)`/`command(*)` broad allow는 safely identified
  migration에서 retire하며 user-owned rule과 stronger deny는 보존한다.
- 2.0.12에서 Telegram-enabled init은 ownership state나 migration mode에 기대지 않고
  다섯 App 관리 보안 key와 effective permission 세 bucket을 canonical policy로
  reconcile한다. 같은 input은 새
  backup/write 없이 idempotent해야 하며 global MCP는 byte-preserve하고 unrelated
  settings와 OAuth를 보존한다. preflight·parse·policy validation·transaction 중 하나라도
  안전하지 않으면 partial write나 permissive fallback을 허용하지 않는다.
- bridge의 init 후 검증이 실패하면 `permission_boundary_blocked`를 한 번만 정제해
  기록하고 Bot API에 접촉하지 않는 live hold로 들어간다. 같은 unsafe settings로 fatal
  exit/S6 restart를 반복하지 않으며 운영자가 안전하게 복구하고 App을 재시작해야 한다.
- App-managed broker proposal의 승인 transport는 Telegram requester-bound inline
  button이다. 인증된 Web/SSH에서 사용자가 명시한 trusted direct tool 작업은 native
  interactive flow를 사용할 수 있고 Telegram button으로 자동 broker되지 않는다. 두
  경로는 HOME/OAuth/global permission을 분리한 별도 runtime이 아니다.
- App 관리 settings와 native MCP config raw direct write는 exact deny다. authenticated
  Web/SSH의 일반 전역 setting은 digest-bound `agy-settings patch`로 매개 수정할 수
  있지만 protected key는 App option+restart로만 변경한다. Telegram customization
  mutation은 approved exact terminal/script proposal로만 수행한다.

## SEC-009 — 브라우저 보안

- canonical dashboard URL은 `http://127.0.0.1:8099/`다.
- gateway는 loopback에만 bind하고 forwarded client IP를 합성하지 않는다.
- 관리형 HA user는 active, local-only, non-system, non-admin, sole
  `system-read-only` group이어야 한다. 조건이 달라지면 자동 수정하지 않고
  fail closed한다.
- Chromium은 isolated temporary profile로 headless 실행한다.
- Telegram auto-allow에는 upstream `readOnly: true`인
  `browser_console_messages`, `browser_network_requests`, `browser_snapshot`,
  `browser_take_screenshot`만 있다. `browser_navigate`, `browser_navigate_back`,
  `browser_tabs`, `browser_hover`, `browser_wait_for`, `browser_resize`, `browser_close`,
  임의 code execution과 file upload/download는 typed adapter 전까지 fail closed한다.
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
처리 중인 normalized update와 전송 대기 reply outbox는 Bot token 파생
HKDF-SHA256 key와 record별 nonce의 AES-256-GCM ciphertext로만 bounded state에
보존한다. conversation ID, reply fingerprint와 delivery attempt metadata만 필요한
범위에서 인증된 record에 결합한다. plaintext/token canary가 state에 나타나거나
decrypt authentication이 실패하면 polling과 delivery는 fail closed 하며, Telegram
API가 성공을 확인한 reply만 atomic state update에서 제거한다. pending record가 있을
때 Bot token을 rotate하지 않으며, accidental rotation/tamper 시 service를 중지하고
기존 token 복원 또는 state 보존·격리 후 명시적 폐기를 선택한다.

credential 노출이 의심되면 해당 service를 중지하고 token을 revoke/rotate한 뒤
`/run` artifact를 폐기한다. 공개 이슈를 만들지 말고 private security reporting
경로를 사용한다. 데이터 삭제나 backup 복원은 별도 사용자 승인을 받는다.

## SEC-012 — 보안 완료 증거

- AppArmor enforce HAOS E2E와 예상 deny audit
- prompt/command/callback injection 회귀
- command environment allowlist와 token canary 비노출
- bootstrap → runtime → command discrete `Px` transition과 native sandbox 무사용 검증
- 공유 Web/SSH/Telegram native OAuth canary 비유출과 동일-process 잔여 위험 기록
- 실제 1.1.13에서 Telegram이 user global/workspace plugin·agent·rule·MCP와 permission을
  CLI와 동일하게 상속하고 수정할 수 있는 positive canary
- symlink/hardlink/FIFO/path traversal migration 회귀
- Telegram-enabled preserve update가 permission boundary만 canonicalize하고 unrelated
  settings, global MCP와 OAuth를 보존하는 transaction/idempotency test
- unsafe effective permission의 `permission_boundary_blocked`, Bot API non-contact와
  no-exit/no-S6-restart negative test
- Telegram auth, stable conversation, explicit `/new`, same-session approval, sealed outbox
  retry/ack와 cross-chat negative test
- browser console/network/screenshot redaction test
- dependency checksum, SBOM, provenance와 signed multi-arch image

이 증거 중 하나라도 빠지거나 native OAuth 동일-process 잔여 위험과 실제 HAOS
OAuth/AppArmor gate가 검증되지 않으면 v2 보안은 `VERIFIED`가 아니다. Telegram은
기본 OFF이며 사용자가 관리자 주 채널의 잔여 위험을 명시적으로 수용한 뒤 켠다.
2.0.12 repaired image의 실제 HAOS amd64 update reconciliation, live Bot API
재연결·전달과 App restart/reconnect는 2026-08-18 `PASS`했다. unsafe-boundary hold,
OAuth/unrelated-state 보존과 전체 Telegram security matrix는 `NOT RUN`이다. 같은
현장의 custom AppArmor attach는 `docker-default (enforce)` 관찰로 `FAIL`했고,
공개 2.0.13은 S6 runtime directory 생성 거부와 exit 111로 startup `FAIL`했다.
공개 2.0.14는 관찰된 resolved Bashio execute 거부와 exit 126으로 startup `FAIL`했다.
후속 trace는 init의 resolved `with-contenv` target도 별도 exact execute가 필요함을 확인했다.
2.0.15 corrected profile의 실기기 enforce·재시작은 아직 `NOT RUN`이다. aarch64
실기기 `NOT RUN`은 experimental 배포에 한해 owner-waived됐지만 PASS가 아니며 전체
v2 수용은 `PARTIAL`이다.
