# 구현 진행 상태

기준: [ORCH PRD](orch-agent-orchestrator-prd.md) v1.0.0.

## 슬라이스 1 — M0 진단 진입점

- 범위: Node/TypeScript 실행 기반, 선택한 호스트의 `--version` 진단, 오류·타임아웃, Git 제외 규칙.
- 비목표: 모델 추론, 네이티브 Worker 생성, 호스트 설정 수정, 설치, 실행 가능 판정.
- 검증: `npm run check`, `npm run orch -- doctor --host codex`, `npm run orch -- doctor --host claude`.
- 체크포인트 조건: 타입 검사·진단 회귀 테스트 통과, 생성물 제외와 PRD 보존 확인.
- 결과: macOS arm64 / Node v26.4.0에서 Codex 0.163.0, Claude Code 2.1.304 설치 확인.
- 제한: 버전 탐지는 호스트 identity·계정 접근·기능 지원의 증명이 아니다. 모든 native capability는 `unknown`, `executionReady=false`로 유지한다. `doctor`의 exit 0은 버전 조회 성공만 의미한다.

## M0 잔여 출시 게이트

PRD POC-01~08의 실제 native model/effort 적용, 카탈로그와 인증·설정 문맥 일치, Worktree binding, reload, resume/cancel, 역할 경계, Windows 통합은 미검증이다. M0 완료 또는 호스트 완전 지원을 주장하지 않는다.

참고: [공식 Codex App Server 문서](https://learn.chatgpt.com/docs/app-server)의 initialize → initialized → model/list 계약을 확인했다. 실제 adapter 및 현재 세션과의 문맥 일치는 아직 구현하지 않았다.

## 슬라이스 2 — M1 설정 읽기·검증·상속 기반

- 범위: PRD 7장의 기본 설정, 설정·역할 타입과 JSON Schema, YAML 검증, default → global → project → session 필드별 병합, 출처, 읽기 전용 CLI.
- 비목표: 설정 저장·unset·동시성 트랜잭션, 모델 카탈로그/effort 의미 검증, SQLite, MCP, Worker dispatch.
- 인터페이스: `parseConfig`, `resolveConfig`, `globalConfigPath`, `loadConfig`, `npm run orch -- config --effective`.
- 검증: `npm run check` (타입 검사 + 테스트 12개), `npm run schema`, `git diff --check`.
- 체크포인트 조건: AT-007의 모델·effort 독립 상속과 출처, 배열 교체, null 보존, 잘못된 설정 거부, 원본 파일 보존, CLI 오류 종료를 검증한다.
- RED → GREEN: AT-007에서 예상 `{model: verified-example, effort: high}` 대신 기본 `{model: auto, effort: auto}`를 반환하는 실패를 확인하고 병합 구현 후 통과했다.
- 안전 경계: 알 수 없는 키·미지원 schema version·중복 YAML 키·임의 태그·alias를 거부한다. YAML 원문은 오류에 포함하지 않는다. 명령은 실행하지 않는다.
- `sources`는 필드별 scope, `files`는 scope별 실제 설정 경로를 제공한다. 세션 오버라이드는 해석 API에서만 지원하며 CLI 세션 저장은 없다.
- JSON Schema와 TypeScript 타입의 원천은 `packages/protocol/src/config.ts`이다. 스키마 변경 후 `npm run schema`로 `packages/protocol/schemas/`를 갱신한다. 기본값 원천은 `templates/defaults/config.yaml`이다.
- Windows 경로 규칙은 순수 함수 테스트만 수행했다. 실제 Windows/PowerShell 실행 지원 증거는 없다.

## 개발 명령

Node.js 24 이상이 필요하다. 현재 검증한 런타임은 macOS arm64 / Node.js 26.4.0이다.

```sh
npm ci --ignore-scripts
npm run check
npm run orch -- --help
npm run orch -- doctor --host codex
npm run orch -- doctor --host claude
npm run orch -- config --effective
npm run schema
```

이 CLI는 내부 개발·진단 진입점이다. PRD의 대화형 `$orch`/`/orch` 스킬이나 MCP 서버가 설치된 것은 아니다. 글로벌 설정은 `ORCH_CONFIG_HOME`, OS별 기본 경로 순서로 읽는다. 프로젝트 설정은 호출한 Git 저장소 root의 `.orch/config.yaml`에서 읽는다. `loadConfig`의 호출자는 최초 origin root를 유지해야 한다.

## 다음 슬라이스

1. M0: 실제 호스트별 catalog와 현재 세션의 인증·설정 문맥 일치 확인, native model/effort·Worktree bootstrap 증거 확보. 검증 전에는 dispatch를 허용하지 않는다.
2. DEV-001/002: 공통 오류·요청·Task·Review 계약, 설정 의미 검증·승인된 patch/unset·atomic write 및 충돌 검증.
3. DEV-003: SQLite migration·transaction·event·operation journal 기반.

이번 초기 변경은 공통 기반의 독립 개발이며 M0 출시 게이트를 통과한 것으로 취급하지 않는다. `qa-verification`은 비활성 상태라 호출하지 않았다. 실제 호스트 추론·네이티브 Worker·E2E·Linux/Windows 실행·배포는 수행하지 않았다.

적용 스킬: `minimal-code` (최소 소유 범위), `ponytail` (기존 런타임·표준 테스트 러너 활용), `OpenAI Docs` (공식 호스트 계약 확인), `mattpocock-skills:tdd` (공개 인터페이스 회귀 테스트).
