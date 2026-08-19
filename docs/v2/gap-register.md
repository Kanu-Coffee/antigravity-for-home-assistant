# v2 갭 레지스터

이 문서는 완료 판정을 막는 결함과 외부 검증 게이트를 issue 단위로 고정한다. 각
항목은 해제 증거가 생길 때까지 삭제하지 않고 `OPEN`, `IN_PROGRESS`, `CLOSED` 중
하나로 유지한다. 좁은 local fixture는 실제 HAOS 항목을 닫지 않는다.

## 상태 추적

| ID | 상태 | 범위 | 해제 조건 |
| --- | --- | --- | --- |
| GAP-001 | `OPEN` | 실제 HAOS 양 아키텍처 설치 | amd64 HA-007, aarch64 HA-006과 양쪽 HA-001/native updater digest canary PASS |
| GAP-002 | `OPEN` | native Google OAuth | shared Web/SSH/Telegram identity login/restart와 credential 비유출 canary PASS |
| GAP-003 | `OPEN` | 2.1.0 AppArmor operational blacklist 실제 enforce | HAOS의 PTY/ordinary-operation positive, mandatory-sensitive/raw-host negative AA-001 matrix와 예상 deny audit PASS |
| GAP-004 | `OPEN` | live Telegram | 실제 Bot API에서 request-review/always-proceed inheritance, healthy session/`/new`, failed-conversation quarantine/no-replay, same-session approval, sealed outbox retry, pairing/restart/network interruption HA-004 PASS |
| GAP-005 | `OPEN` | public v1 migration | numeric publish 후 original repository/add-on identity의 amd64 `1.0.4 → 2.0.0` update/rollback HA-005 PASS |
| GAP-006 | `OPEN` | public release supply chain | Candidate/HAOS evidence/finalize, numeric promotion/supply chain, reviewed merge/Release resume, post-publish two-arch public fresh-install `HA-008` artifact와 anonymous pull PASS |
| GAP-007 | `OPEN` | 성능·내구성 (non-blocking advisory) | 짧은 CI contract를 유지한다. 30분 soak, 15분 동시 장애와 restart 20회는 필요할 때만 수동 진단하며 Candidate·finalize·tag·release를 차단하지 않는다. |
| GAP-008 | `OPEN` | transient device test HAOS 증거 | 분리된 typed workflow의 local success/failure/replay suite는 PASS; 실제 safe entity restore E2E 필요 |
| GAP-009 | `CLOSED` | transport ownership | ordinary read/memory/validate를 ha-read broker로 고정한 static + shared failure-injection PASS; privileged mutation/browser-auth 분리 사유 문서화 |

현재 실행 환경은 일반 Ubuntu Docker host다. Supervisor credential, App option 파일,
HAOS AppArmor enforcement와 HA read socket이 없으므로 GAP-001~005와 GAP-008을
여기서 PASS로 바꿀 수 없다. 이 제약은 기능을 더 작은 local 요구사항으로 바꾸는
근거가 아니다. GAP-009는 production source ownership과 local injected failure 범위만
닫았으며 HAOS 전체 기능 검증을 대신하지 않는다.

GAP-007의 짧은 local contract fixture는 2 workers/chat queue 4, 네 surface 동시 장애,
1,000 entity/긴 로그 bounded output와 증거 schema를 PASS했다. 이 결정론적 검사는
일반 CI에서 계속 실행하지만 장시간 내구성이나 실제 HAOS 성공의 증거는 아니다. 첫 장시간 결과 SHA-256
`b2cb64cac2c5f12c61d4a779c06a4bca1307799e485086d9512974e231d51d09`도 budget baseline일
뿐이다. 그 image는 source revision label이 없었고 workload가 host source를 사용했으므로
해제 증거가 아니다. exact revision/source-rootfs manifest, packaged Telegram
queue/worker/backoff와 [고정 budget](performance-budget.json)이 포함된 source-bound
candidate에서 2026-08-12 실제 release mode를 완료했다. sanitized evidence SHA-256은
`2c2b3fe0cb0aa2522722e192323bdb0e0a291f5d99193df603eace003dc7f8f9`다. source
`ae8b0bc4fdd042bdb84c55a1767d619d9adc734f`, amd64 stage
`sha256:06ce690a72a028db5d47b979514b686d36726d06b66a2c685ef0a3b647d83d06`, runtime leaf
`sha256:782f1247a826f07bb8ab7b2f118d194e50cf30594b7c4516714d0c1080b7105c`에서 1,800초
soak, 900초 동시 장애, broker/candidate restart 20회와 resource budget을 모두 PASS했고
외부 호출은 0이었다. 다만 이 historical local run의 evidence bytes와
immutable URI가 보존돼 있지 않고 source와 packaged runtime도 현재 Candidate와 다르다.
따라서 GAP-007은 `OPEN`인 비차단 advisory 항목으로 유지한다. 장시간 `release` mode는
누수·장애 복구·restart 회귀가 의심되거나 정기 성능 기준을 다시 측정할 때 운영자가
명시적으로 실행하는 수동 진단 도구다. 이름의 `release`는 full-duration evidence 형식을
뜻할 뿐 Candidate, finalize, Builder, numeric tag 또는 post-publish workflow의 필수 gate를
뜻하지 않는다. 원본 JSON이나 `gap007_release` binding이 없어도 릴리스는 진행할 수 있어야
한다. 수동 실행 시에는 host `docker export` verifier와 unmanifested rootfs context 거부를
그대로 유지한다. 이 local 증거는 실제 HAOS와 live Bot API 검증을 대신하지 않으며,
GAP-007을 닫으려면 별도의 실제 HAOS 장시간 운용·network interruption·재시작 증거가
필요하다.

## 폐기한 legacy 표면

| ID | 상태 | 제거 대상 | 회귀 방지 |
| --- | --- | --- | --- |
| LEGACY-001 | `CLOSED` | Telegram shell/tmux prompt interpolation | bridge argv/stdin 및 session/outbox tests |
| LEGACY-002 | `CLOSED` | legacy Codex `approval_policy=never`와 `danger-full-access` 강제 | native dual-mode wrapper/policy tests; explicit native `always-proceed`는 2.1.0 지원 mode |
| LEGACY-003 | `CLOSED` | unauthenticated pairing PIN/deep-link 응답 | local-only pairing tests |
| LEGACY-004 | `CLOSED` | Codex식 `-c`, TOML와 `$skill` 사용자 명령 | native help/settings/plugin contracts |
| LEGACY-005 | `CLOSED` | model process의 raw Supervisor token | broker env/AppArmor/token canaries |

## 갱신 규칙

1. 항목을 닫을 때 exact command 또는 UI 경로, source commit, immutable image digest,
   architecture와 sanitized artifact를 [test-plan.md](test-plan.md)의 양식으로 남긴다.
2. 실패가 발견되면 동일 ID를 다시 열고 이전 evidence를 지우지 않는다.
3. 실제 entity, credential, OAuth session, Telegram token과 사용자 대화 원문은
   evidence에 넣지 않는다.
4. 외부 시스템이 필요한 항목은 임의 mock 성공으로 닫지 않는다.
