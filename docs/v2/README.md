# Antigravity for Home Assistant v2 개발 계약

이 디렉터리는 Antigravity for Home Assistant v2의 제품, 아키텍처, 보안,
마이그레이션, 테스트 계약을 보관하는 단일 기준점이다. v2 구현과 리뷰는 이
문서들을 우선하며, `docs/development/`와 `docs/archive/`는 현재 구현의 역사와
참고 자료로만 사용한다.

## 문서 상태

이 문서 세트는 목표 계약이다. 문서에 적힌 기능은 코드와 실제 HAOS 증거가
있기 전까지 구현 완료를 뜻하지 않는다.

체크리스트 상태는 다음 다섯 값만 사용한다.

| 상태 | 의미 |
| --- | --- |
| `TODO` | 구현 또는 검증이 시작되지 않았거나 증거가 부족함 |
| `IN_PROGRESS` | 범위가 정해졌고 구현 또는 검증 중임 |
| `BLOCKED` | 구체적인 외부 조건 때문에 진행할 수 없으며 원인과 해제 조건이 기록됨 |
| `PARTIAL` | 좁은 local fixture 등 일부 범위만 통과했고 HAOS·architecture·E2E 검증이 남음 |
| `VERIFIED` | 요구 범위 전체를 검증하는 재현 가능한 증거가 기록됨 |

`VERIFIED`는 의도, 코드 존재, 단일 unit test, 다른 버전의 과거 성공을 뜻하지
않는다. 아키텍처별 이미지와 실제 HAOS/AppArmor 같은 요구는 같은 범위의
증거로만 완료할 수 있다.

host source checkout의 `ha-feedback-development`/`tools/development/ha-feedback` test
mode는 sanitized report 형식의 local collect/validate/render만 검증한다. live Supervisor
credential이나 HAOS App state를 받지 않으므로 그 결과를 실기기 증거로 승격하지 않고,
재현하지 않은 HAOS 항목은 `NOT RUN`으로 둔다.

## 읽는 순서

| 문서 | 역할 |
| --- | --- |
| [goal.md](goal.md) | 장기 Goal 프롬프트, 성공 조건과 완료 판정 |
| [product-spec.md](product-spec.md) | 사용자 시나리오, 기능 요구사항과 App 옵션 |
| [architecture.md](architecture.md) | 컴포넌트, 신뢰 경계, 데이터 흐름과 디렉터리 스키마 |
| [antigravity-contract.md](antigravity-contract.md) | Antigravity 1.1.13 CLI, 설정, 플러그인과 MCP 계약 |
| [security.md](security.md) | 위협 모델, AppArmor, 비밀정보와 승인 경계 |
| [telegram-spec.md](telegram-spec.md) | 새 Telegram 브리지의 인증, 상태 머신과 실행 계약 |
| [migration-release.md](migration-release.md) | 기존 데이터 이관, rollback, multi-arch GHCR 릴리스 |
| [decisions.md](decisions.md) | v2 target, 지원 창과 변경 불가 설계 결정 |
| [gap-register.md](gap-register.md) | 남은 결함·외부 검증 gate와 해제 증거 |
| [test-plan.md](test-plan.md) | 자동·컨테이너·실제 HAOS 검증 및 증거 규칙 |
| [checklist.md](checklist.md) | 구현 순서, 제약, 주의사항과 현재 진행 상태 |

## 기준선

2026-08-11 준비 감사에서 확인한 기준선은 다음과 같다.

- 저장소는 `main`의 `aba6805`이며 당시 `origin/main`과 일치했다.
- 기존 amd64 App 이미지는 로컬에서 빌드됐지만 v2 이미지가 아니다.
- 현재 App metadata는 amd64만 선언하고 GHCR `image` 항목과 custom
  `apparmor.txt`가 없다.
- 현재 wrapper는 Antigravity의 `-c`를 Codex식 설정 override로 사용한다.
  Antigravity 1.1.13에서 `-c`는 `--continue`이므로 이 경로는 잘못됐다.
- 현재 Telegram 브리지는 shell interpolation, 승인 우회, pairing 노출,
  session 격리 문제 때문에 v2에서 재사용하지 않는다.
- 당시 Python 검사는 84개 성공, executable-bit 계약 1개 실패였다. Docker
  smoke, memory smoke, user-file update smoke와 최신 GitHub CI/Builder도
  실패가 남아 있었다.
- aarch64 이미지와 v2 AppArmor, Telegram 보안, 실제 HAOS v2 E2E는 검증되지
  않았다.

세부 상태와 해소 순서는 [checklist.md](checklist.md)에 기록한다.

## 변경 절차

1. 루트 `AGENTS.md`, 이 README와 변경 대상 문서를 읽는다.
2. `checklist.md`와 `gap-register.md`에서 요구사항 ID와 현재 증거를 확인한다.
3. 변경 전 Git 상태와 관련 파일을 검사하고, 사용자 변경을 보존한다.
4. 비밀 경계, AppArmor 영향, Telegram 승인 영향을 먼저 검토한다.
5. 가장 작은 검증 가능한 단위로 구현한다.
6. `test-plan.md`의 해당 자동 검사를 수행한다.
7. 실제 HAOS가 필요한 항목은 로컬 컨테이너 성공과 분리해 기록한다.
8. 체크리스트에 명령, commit SHA, image digest 또는 HAOS 보고서 링크를
   남긴 뒤에만 `VERIFIED`로 바꾼다.

## 계약 우선순위

충돌할 때 다음 순서를 적용한다.

1. 현재 사용자의 명시적 요구와 보안 승인
2. 루트 및 하위 `AGENTS.md`
3. `docs/v2/`의 제품·보안·인터페이스 계약
4. 실제 고정 버전 Antigravity `--help`와 공식 schema
5. Home Assistant 공식 App 문서와 실제 Supervisor/HAOS 동작
6. 기존 구현과 `docs/development/`

Antigravity 명령이나 설정을 추정하지 않는다. 문서와 고정 binary가 충돌하면
구현을 중지하고, 실제 binary의 계약 테스트 결과와 공식 근거를 이 문서에
반영한 후 진행한다.

## v2 완료 정의

다음 조건을 모두 만족해야 v2 목표가 완료된다.

- Antigravity 1.1.13의 native CLI, `settings.json`, MCP와 plugin 경로만 사용한다.
- Ingress, 공개키 SSH와 Telegram에서 정의된 사용자 흐름이 동작한다.
- Telegram이 CLI의 전역 환경·권한을 상속하고 `/new`까지 같은 session과 reply
  outbox를 유지한다. `ha_change_propose`로 제출된 App-managed broker
  `service_call`/`multi_choice_service_call`/`config_patch`에는 durable
  requester/session/choice-bound approval과 exactly-once broker 접수를 강제한다.
  multi-choice는 최대 31개 사전 검증 선택지 중 하나만 실행하고 기존 binary approval과
  호환한다. 관리형 runtime rule은 일반 HA service/config 변경을 이 broker로
  라우팅한다. 신뢰된 사용자 전역 native tool과 direct command/API helper는 관리자
  권한을 상속하며 broker가 투명하게 가로채지 않는다.
- native 기본 permission은 `request-review`다. 이 모드의 Playwright auto-allow는
  upstream read-only console/network/snapshot/screenshot 네 도구뿐이고 mutation 도구는
  typed adapter 전까지 fail closed한다. 명시적 `always-proceed`는 mandatory blacklist
  밖의 일반 운영과 installed MCP/Playwright interaction을 자율 관리자 권한으로
  실행한다. `strict`와 `proceed-in-sandbox`만 legacy 입력으로 `request-review`에
  정규화된다. native `read_file`/`write_file`은 두 mode 모두 deny되며 ordinary file은
  confined `ha_files`만 사용한다.
- 2.0.12부터 `telegram_enabled=true`이면 안전하게 읽고 parse할 수 있는 기존
  `settings.json`의 Telegram permission 경계를 migration mode와 무관하게 transaction
  backup 뒤 canonical policy로 reconcile한다. 2.1.2의 공통 관리 대상은
  `allowNonWorkspaceAccess`, `artifactReviewPolicy`, `permissions`다. `request-review`는
  top-level `toolPermission`을 생략하고 `allow`/`deny`/`ask`를 기록하며,
  `always-proceed`는 `toolPermission: "always-proceed"`와 `allow`/`deny`만 기록한다.
  `enableTerminalSandbox`와 빈 `ask`는 두 mode 모두 제거한다. 그 밖의 top-level
  settings, OAuth, global MCP, plugin과 `/config`는 보존한다. 안전한 기존 mode drift는
  transaction에서 0600으로 강화한다.
  mode를 `reset_v2`로 자동 변경하지 않으며 같은 입력의 재시작은 idempotent해야 한다.
- Telegram의 exact native `run_command` headless denial은 proposal이 없는
  `request-review`에서만 최대 한 번 proposal-first로 재계획한다. exact single same-run
  proposal은 기존 receipt 검증을 계속한다. `always-proceed`에서 같은 denial은 정상
  승인 요청이 아니라 `unexpected_permission_denied` policy mismatch이며 approval card
  없이 conversation을 격리한다. Native file denial은 managed `ha_files` 경계로 안내하고 generic shell/AppArmor
  permission 오류는 native approval denial로 재분류하지 않는다.
- init 뒤 effective permission 재검증도 통과하지 못하면 bridge는 Bot API에 접촉하지
  않고 `permission_boundary_blocked`를 한 번 기록한 뒤 살아 있는 fail-closed hold에
  머문다. 같은 설정의 fatal/S6 restart loop를 만들지 않으며 안전한 복구 뒤 App을
  재시작해야 한다.
- 2026-08-18 실제 HAOS 18.2 amd64에서 2.0.12 public `preserve` update의 Telegram
  reconcile/reconnect/delivery와 App restart/reconnect는 PASS했지만 custom AppArmor
  attach는 `docker-default (enforce)`로 FAIL했다. 2.0.13은 Supervisor-recognized slug
  primary 선언 하나와 AppArmor parser가 독립 global profile로 읽는 22개 들여쓴
  `Px transition` target 선언으로 loader 호환성을 고쳤지만, 공개 image의 다음
  startup은 `/run/s6`·`/run/service` 생성 거부와 exit 111로 FAIL했다. 공개 2.0.14는
  이 runtime 지점을 통과했지만 resolved `/usr/lib/bashio/bashio` 실행이 거부되어 init
  exit 126으로 다시 FAIL했고, init `with-contenv`의 실제 S6 package target에도 exact
  execute가 필요했다. 전체 cold-start trace로 resolved S6/execline·Bash, init
  계정/nginx 상태, Telegram pause, SSH accounting/OOM, Chromium child와 feedback
  subtree까지 bounded runtime closure를 확인했다. 2.0.15는 이를 profile별 exact 경로로
  보완하고 kernel-enforced 자동 smoke를 필수화했지만, 실제 HAOS에서 primary profile의
  PTY multiplexor 접근 누락으로 ttyd `pty_spawn`이 EACCES를 반환했다. 같은 시작의
  `refresh_managed`는 malformed `permissions.ask`를 Telegram 안전 정규화보다 먼저
  거부해 bridge가 `permission_boundary_blocked`에 머물렀다. 따라서 공개 2.0.15의
  amd64 HAOS 수용은 `FAIL`이다. 2.0.16은 이 두 결함을 복구해 App, terminal과 Telegram
  transport를 시작했지만 `agy`/`antigravity --version`이 SIGSEGV/status 139로 즉시
  종료되고 Telegram worker도 실패했다. exact public image와 custom profile로 재현한
  kernel audit는 `interactive-runtime-restricted`에서 exact
  `/usr/local/libexec/antigravity-real` rule의 `file_mmap` permission `m` 거부를
  확인했고 sensitive-read에는 동일한 `r`-only rule이 있었다. 2.0.17은 두 rule을
  `r`에서 `rm`으로 바꾸고 full blank-auth trace의 exact
  bootstrap nsswitch/passwd identity read와 runtime `/usr/share/ca-certificates/**` TLS
  trust-store read만 두 transition chain에 추가한다. 새로운 broad `/etc/**`·`/usr/share/**`
  rule은 추가하지 않고, runtime의 기존 `/etc/** r`와 필수 system-library mapping 및
  proc/settings/credential deny는 유지한다. 이후 실제 2.0.17 amd64에서 App 기동,
  Ingress/Web terminal, native 기본 대화, Telegram transport와 도구 없는 답변은
  `PASS`했지만 managed MCP와 `telegram_action_propose`는 `FAIL`했다. kernel audit는
  `change-proposal-client`의 exact image-owned `supervisor-credential-fd.mjs` 전이 module
  read 거부를 확인했고, restricted/sensitive-read 두 launcher는 승인 제안에 필요한
  requester/run binding 다섯 값을 버렸다. 승인된 쓰기는 `NOT RUN`이며 공개 2.0.17
  수용은 전체 `FAIL`이다. 2.0.18은 exact module read와 두 launcher의 완전한 다섯 값
  검증·보존을 추가했다. 이후 실제 공개 2.0.18 amd64는 App startup,
  `antigravity --version` status 0, Telegram transport와 no-tool chat을 `PASS`했지만
  Web `agy`/`antigravity` interactive I/O가 실패했다. 현재 kernel audit는 interactive
  profile의 `/dev/pts/0` inherited/open `rw` denial을 기록한다. 첫 managed Telegram
  tool 요청은 terminal error였고, 후속 3~7은 failed conversation reuse 때문에 독립
  결과가 아니며 approved write는 `NOT RUN`이다. 공개 2.0.18 수용은 `FAIL`이다.
  2.1.0은 supported operational mount/API에 broad grant와 explicit credential/storage/
  policy/process-integrity blacklist를 적용하고 failed native conversation을 다음 요청 전
  격리한다. native `read_file`/`write_file`은 symlink alias 우회를 막기 위해 두 mode에서
  전역 deny하며, ordinary file은 confined `ha_files`의 `ha_files_list`,
  `ha_files_read_text`, `ha_files_write_text`만 사용한다. Host/Supervisor log는 raw를
  노출하지 않고 exact token과 known credential-shaped line/block을 제거한 bounded
  projection만 제공하며 arbitrary unkeyed text의 완전한 secret 판별은 보장하지 않는다.
  자동 회귀는 HAOS 증거가 아니며 2.1.0 amd64/aarch64 실기기는 배포 시점
  `NOT RUN`이다. aarch64 면제는 PASS가 아니며 전체 v2 수용은 `PARTIAL`이다.
- proposal registration만으로 crash durability를 주장하지 않는다. encrypted
  approval/card sealing 전 bridge crash는 사용자가 원 요청을 반복해야 한다.
- 명시적 `reset_v2`는 safe parseable settings를 backup하고 ownership state와
  무관하게 managed key/permission bucket을 exact default로 복구하며, `preserve`로
  되돌릴 때까지 매 시작 drift를 다시 복구한다.
- custom AppArmor가 항상 활성화되고 민감 경로 차단을 실제 HAOS에서 확인한다.
- HA API, 로그, 메모리와 dashboard browser 기능이 최소권한 경계 안에서
  동작한다.
- amd64와 aarch64 이미지가 같은 tag의 GHCR manifest로 배포된다.
- 세 migration 모드와 rollback이 기존 사용자 데이터로 검증된다.
- 필수 CI와 실제 HAOS E2E가 모두 통과하며 미검증 항목이 없다.
