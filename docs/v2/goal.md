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
   durable reply delivery를 유지한다. approval callback ACK/control은 즉시 처리하되
   broker 실행은 requester FIFO에서 직렬화하고, 실행 직전 requester/session을
   재검증한다. `ha_change_propose`로 제출된 모든 App-managed broker
   `service_call`/`multi_choice_service_call`/`config_patch`에 고위험 확인과
   exactly-once broker 접수를 강제한다. multi-choice는 최대 31개 사전 검증 선택지 중
   하나만 requester/session/digest/choice/idempotency binding으로 실행한다.
   기본 `request-review`에서는 관리형 runtime rule이 HA service/config 변경을
   `ha_change_propose`, terminal command·bounded script·명령 선택지·유한 질문을
   `telegram_action_propose`로 먼저 등록한다. action은 requester/session/update/
   conversation/digest에 결합된 Telegram 승인 뒤에만 credential-free executor 또는
   HA broker가 실행한다. 사용자가 App option에서 `always-proceed`를 명시적으로 선택한
   경우에는 일반 운영 command/URL과 installed MCP를 자율 관리자 권한으로
   실행할 수 있지만, credential·비밀·정책 경계는 같은 blacklist로 계속 차단한다.
   `strict`와 `proceed-in-sandbox`는 지원하지 않는 legacy 입력으로만 수용하고
   `request-review`로 정규화한다.
   `request-review`의 Playwright는 upstream read-only 네 도구만 auto-allow하고
   mutation-capable 도구는 typed adapter 전까지 fail closed한다. 명시적
   `always-proceed`에서는 current user request 범위의 installed Playwright navigation과
   interaction도 자율 관리자 정책에 포함된다. proposal registration 뒤 approval/card
   sealing 전 crash는 durable로 가장하지 않고 사용자 재시도를 요구한다.
   native `read_file`/`write_file`은 symlink alias로 보호 경계를 우회할 수 있어 두
   mode에서 전역 deny한다. 일반 파일 작업은 confined `ha_files`의
   `ha_files_list`, `ha_files_read_text`, `ha_files_write_text`만 사용하며 허용 root,
   크기·목록 상한, no-link/regular-file, atomic-write·digest 조건을 broker가 강제한다.
5. AppArmor는 항상 활성화된다. `/config`, `/share`, `/media`, Antigravity HOME과
   임시 작업공간의 일반 운영 파일은 기본 허용하고, ordinary system binaries와
   supported Core/Supervisor manager API를 사용할 수 있게 한다. blacklist는
   `secrets.yaml`, `.storage`, raw App·browser·Telegram·SSH·cloud credential,
   App-owned permission/MCP policy, 다른 프로세스의 credential-bearing `/proc` surface와
   Recorder write처럼 직접 노출 또는 손상이 치명적인 경계에 집중한다. 민감정보
   option을 켜도 Recorder 자료는 진단 read-only이며, 공유 native OAuth는 Antigravity
   실행에만 사용하고 model output·로그·Telegram reply로 노출하지 않는다.
6. HA API, 메모리와 브라우저 기능은 raw credential을 반환하지 않는다. Host/Supervisor
   로그는 raw endpoint를 직접 노출하지 않고 exact App token과 알려진 credential-shaped
   line/block을 제거한 bounded 결과만 제공한다. arbitrary unkeyed application text의
   비밀 여부를 완전 판별할 수 있다고 주장하지 않으며 관리자는 출력 공유 전에 다시
   검토한다.
7. amd64와 aarch64가 동일한 numeric tag와 GHCR multi-arch manifest로
   설치된다.
8. 모든 필수 자동 검사와 실제 HAOS/AppArmor E2E에 재현 가능한 증거가 있다.

## 범위 밖

- Home Assistant Core, OS 또는 Supervisor 자체를 fork하지 않는다.
- AppArmor 비활성 옵션이나 보호 모드 해제를 제공하지 않는다.
- Docker socket, host PID namespace, HAOS root filesystem mount, `full_access` 또는
  privileged capability를 제공하지 않는다. Supervisor가 지원하는 mount와 manager API
  밖의 raw host filesystem 접근을 지원한다고 주장하지 않는다.
- Telegram에 raw root TUI를 노출하지 않는다. `request-review`에서는 exact
  command/script를 preview·digest·승인에 결합하는 관리형 action executor를 제공하고,
  `always-proceed`에서는 명시적으로 선택된 자율 관리자 정책을 적용한다.
- 사용자별 Home Assistant 의미 정보를 image나 `AGENTS.md`에 미리 넣지 않는다.
- `.storage`, Recorder DB 또는 credential 파일을 직접 수정하는 기능을 만들지
  않는다.
- 검증 없이 Antigravity 최신 버전으로 자동 업데이트하지 않는다.

## 완료 판정

완료 판정은 [test-plan.md](test-plan.md)의 증거와
[checklist.md](checklist.md)의 모든 필수 항목이 `VERIFIED`인지 요구사항별로
감사해 결정한다. 부분 성공, 다른 아키텍처의 성공, 과거 Codex App의 성공은
대체 증거가 아니다.
