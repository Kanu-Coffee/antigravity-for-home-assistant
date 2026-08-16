# v2 Goal

## Goal용 짧은 프롬프트

> 이 저장소의 `docs/v2/` 문서를 제품·아키텍처·보안 계약으로 삼아
> Antigravity for Home Assistant v2를 단계별로 구현하라. Antigravity의 실제
> CLI·settings·plugin 계약만 사용하고 Codex 명령을 추정하거나 복사하지
> 마라. 각 변경 전 체크리스트와 비밀·AppArmor·Telegram 승인 경계를
> 확인하고, 변경 후 자동 테스트와 실제 HAOS 검증 증거를 기록하라. 미검증
> 항목은 완료로 표시하지 말고 기존 사용자 데이터는 선택된 migration 정책에
> 따라 보존 또는 복구 가능하게 처리하라.

## 제품 목표

HAOS 사용자가 App을 설치하고 Google 계정으로 Antigravity에 로그인한 뒤
Ingress, 공개키 SSH 또는 Telegram에서 Home Assistant를 진단하고 안전하게
관리할 수 있게 한다. App은 `/config`를 작업공간으로 사용하고 Core/Supervisor
API, 시스템 로그, 검증형 메모리와 실제 headless browser를 하나의
Antigravity native plugin으로 제공한다.

## 성공 조건

1. 신규 설치가 별도의 중계 서버 없이 HAOS 내부에서 완료된다.
2. Antigravity 1.1.13의 실제 CLI와 JSON 설정만 사용한다.
3. 사용자 Home Assistant 설정과 기존 `/data` 상태가 명시한 migration 정책에
   따라 보존되며 실패 시 복구할 수 있다.
4. Telegram은 허용된 사용자와 채팅만 처리하며 CLI의 OAuth·전역 customization·
   native permission을 상속한다. `/new`까지 stable session과 same-session approval,
   durable reply delivery를 유지하고 고위험 항상 확인을 강제한다.
5. AppArmor는 항상 활성화된다. 민감정보 option이 꺼지면 보호 경로를 읽지
   못하고, 켜져도 명시한 Home Assistant 민감 설정과 Recorder 자료만 read-only로
   허용한다. raw App·SSH credential은 계속 차단하고, 공유 native OAuth는
   Antigravity 실행에만 사용하며 model output·로그·Telegram reply로 노출하지 않는다.
6. HA API, 로그, 메모리와 브라우저 기능이 비밀을 model, 로그, artifact 또는
   Telegram으로 노출하지 않는다.
7. amd64와 aarch64가 동일한 numeric tag와 GHCR multi-arch manifest로
   설치된다.
8. 모든 필수 자동 검사와 실제 HAOS/AppArmor E2E에 재현 가능한 증거가 있다.

## 범위 밖

- Home Assistant Core, OS 또는 Supervisor 자체를 fork하지 않는다.
- AppArmor 비활성 옵션이나 보호 모드 해제를 제공하지 않는다.
- Telegram을 일반 목적 root shell 또는 TUI 전달 통로로 제공하지 않는다.
- 사용자별 Home Assistant 의미 정보를 image나 `AGENTS.md`에 미리 넣지 않는다.
- `.storage`, Recorder DB 또는 credential 파일을 직접 수정하는 기능을 만들지
  않는다.
- 검증 없이 Antigravity 최신 버전으로 자동 업데이트하지 않는다.

## 완료 판정

완료 판정은 [test-plan.md](test-plan.md)의 증거와
[checklist.md](checklist.md)의 모든 필수 항목이 `VERIFIED`인지 요구사항별로
감사해 결정한다. 부분 성공, 다른 아키텍처의 성공, 과거 Codex App의 성공은
대체 증거가 아니다.
