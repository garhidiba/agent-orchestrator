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
