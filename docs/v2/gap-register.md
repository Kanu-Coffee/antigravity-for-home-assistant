# v2 갭 레지스터

이 문서는 완료 판정을 막는 결함과 외부 검증 게이트를 issue 단위로 고정한다. 각
항목은 해제 증거가 생길 때까지 삭제하지 않고 `OPEN`, `IN_PROGRESS`, `CLOSED` 중
하나로 유지한다. 좁은 local fixture는 실제 HAOS 항목을 닫지 않는다.

## 상태 추적

| ID | 상태 | 범위 | 해제 조건 |
| --- | --- | --- | --- |
| GAP-001 | `OPEN` | 실제 HAOS 양 아키텍처 설치 | amd64/aarch64에서 HA-001과 native updater digest canary PASS |
| GAP-002 | `OPEN` | native Google OAuth | interactive와 Telegram 별도 identity login/restart, credential 비유출 canary PASS |
| GAP-003 | `OPEN` | AppArmor 실제 enforce | HAOS의 AA-001 positive/negative matrix와 예상 deny audit PASS |
| GAP-004 | `OPEN` | live Telegram | 실제 Bot API에서 세 mode, pairing, replay, restart와 network interruption HA-004 PASS |
| GAP-005 | `OPEN` | public v1 migration | public `1.0.4 → 2.0.0` preserve/refresh/reset/rollback HA-005 PASS |
| GAP-006 | `OPEN` | public release supply chain | remote CI/Builder, two-arch manifest, SBOM/provenance/Cosign와 anonymous pull PASS |
| GAP-007 | `IN_PROGRESS` | 성능·내구성 | 30분 Telegram soak, 15분 동시 장애 주입, 1,000 entity, candidate rapid restart 20회 evidence |
| GAP-008 | `OPEN` | transient device test HAOS 증거 | 분리된 typed workflow의 local success/failure/replay suite는 PASS; 실제 safe entity restore E2E 필요 |
| GAP-009 | `CLOSED` | transport ownership | ordinary read/memory/validate를 ha-read broker로 고정한 static + shared failure-injection PASS; privileged mutation/browser-auth 분리 사유 문서화 |

현재 실행 환경은 일반 Ubuntu Docker host다. Supervisor credential, App option 파일,
HAOS AppArmor enforcement와 HA read socket이 없으므로 GAP-001~005와 GAP-008을
여기서 PASS로 바꿀 수 없다. 이 제약은 기능을 더 작은 local 요구사항으로 바꾸는
근거가 아니다. GAP-009는 production source ownership과 local injected failure 범위만
닫았으며 HAOS 전체 기능 검증을 대신하지 않는다.

GAP-007의 짧은 local contract fixture는 2 workers/chat queue 4, 네 surface 동시 장애,
1,000 entity/긴 로그 bounded output와 증거 schema를 PASS했다. 이는 실행 시간을 줄인
contract 결과이므로 해제 증거가 아니다. 첫 장시간 결과 SHA-256
`b2cb64cac2c5f12c61d4a779c06a4bca1307799e485086d9512974e231d51d09`도 budget baseline일
뿐이다. 그 image는 source revision label이 없었고 workload가 host source를 사용했으므로
해제 증거가 아니다. exact revision/source-rootfs manifest, packaged Telegram
queue/worker/backoff와 [고정 budget](performance-budget.json)이 포함된 새 candidate에서
고정 30분/15분 wall-clock과 container restart 20회를 모두 PASS한 sanitized JSON이
생길 때까지 `IN_PROGRESS`를 유지한다. 공식 candidate/release workflow는 이 JSON의
SHA-256과 exact amd64 stage/leaf/source binding을 candidate artifact에 포함하고 numeric
release 직전에 다시 검사하도록 연결했다. 또한 host `docker export` verifier가 embedded
manifest/OCI label/current source와 각 root-owned file을 독립 대조하고 unmanifested
rootfs context file을 build에서 거부한다. 새 candidate의 실제 장시간 PASS가 아직
없으므로 이 wiring 자체도 GAP을 닫지 않는다.

## 폐기한 legacy 표면

| ID | 상태 | 제거 대상 | 회귀 방지 |
| --- | --- | --- | --- |
| LEGACY-001 | `CLOSED` | Telegram shell/tmux prompt interpolation | bridge argv/stdin 및 isolation tests |
| LEGACY-002 | `CLOSED` | `approval_policy=never`와 `danger-full-access` 강제 | native wrapper/policy tests |
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
