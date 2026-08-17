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
- custom AppArmor가 항상 활성화되고 민감 경로 차단을 실제 HAOS에서 확인한다.
- HA API, 로그, 메모리와 dashboard browser 기능이 최소권한 경계 안에서
  동작한다.
- amd64와 aarch64 이미지가 같은 tag의 GHCR manifest로 배포된다.
- 세 migration 모드와 rollback이 기존 사용자 데이터로 검증된다.
- 필수 CI와 실제 HAOS E2E가 모두 통과하며 미검증 항목이 없다.
