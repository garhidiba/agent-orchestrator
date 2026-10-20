# 구현 진행 상태

기준: [ORCH PRD](orch-agent-orchestrator-prd.md) v1.0.0, 2026-10-20 개발 구현. **v1 출시 완료 또는 두 호스트 완전 지원 상태가 아니다.** 상세 수용 기준은 [acceptance](acceptance.md), 실제 호환성 한계는 [compatibility](compatibility.md)를 따른다.

## 현재 구현

- 프로토콜: 설정·요구사항·Task·결과·gate·review·recommendation의 검증 schema와 JSON Schema 산출물. 인증된 requirements 제출이 canonical JSON/Markdown을 저장하며 plan 수용 기준의 ID·문자열 exact match를 강제한다.
- 설정: 필드별 default/global/project/session 병합 해석, 출처·파일 hash, atomic patch/unset, 충돌·dry-run, CLI 모델/profile 설정. 파일 설정 변경 API는 project/global 범위이며 session API는 MCP 서버 프로세스 수명의 메모리 layer를 제공한다.
- 메타데이터: Codex handshake·전체 paging·deduplication, 호스트별 adapter, TTL·오류·stale fallback을 가진 disk cache. 현재 카탈로그 identity scope는 unknown이며 실제 세션과의 일치를 주장하지 않는다.
- 상태·Git: SQLite event/operation journal, 동일 Git common dir 쓰기 락, 소유 worktree, DAG·ready wave, lease/fencing, 단위 커밋, 직렬 통합, retry 보존, commit/merge crash reconciliation, guarded cleanup.
- 검증·review: 명령/source/environment fingerprint와 제한·redaction된 로그 참조, SHA-bound gate/review, 독립 reviewer 확인, finding/repair 순환 및 최대 round 제한. task self-report와 검증 증거를 구분한다.
- 실행 revision: immutable runtimeRoot로 run 코드를 고정하고, 새 attempt에서 허용된 설정 revision/model 정책을 읽으며 기존 attempt는 보존한다. 모델 requested/resolved/observed와 실제 관측 불가를 분리한다.
- 보고서: 기본 읽기 전용 `orch_report`, 인증된 `persist=true`에서 run별 summary/findings/acceptance/cleanup 파일 저장. 완료 판정은 실제 target SHA·최신 gate/review·수용 증거에 의존하며 unknown usage/cost를 생성하지 않는다.
- 배포 자산: 공통 진입 스킬 2개와 참조 8개, local checksum bundle pack/install/update/rollback/uninstall, 소유권 충돌 보존, 두 호스트별 설치 자산과 immutable runtime 경로. 실제 reload·MCP handshake·인증 실행은 설치 성공과 별개이다.

## 검증 증거와 적용 범위

실행 코드 기준 `d6f73631e6eb875a87e282871cf5a536a5b93638`에서 `npm run check`의 typecheck와 테스트 100개가 통과했다(실패 0, skip 0, 26.756초). JSON Schema 일치 검사도 이 테스트에 포함된다. 독립 검토에서 발견한 저장소 PATH 실행, state symlink 로그 쓰기, 상위 설정에 가려진 모델·effort 검증 우회를 수정하고 각각 재현이 차단됨을 확인했다. 최종 독립 집중 테스트 15개와 타입·diff 검사도 통과했다.

동일 기준의 실제 소스로 생성한 macOS arm64 bundle은 임시 HOME에서 Codex/Claude 설정 설치·멱등 재설치·기존 설정 보존, 설치본 CLI 설정 조회, 양쪽 stdio MCP 연결·27개 도구 조회·설정 읽기, 호스트별 제거와 다른 호스트 자산 보존을 통과했다. 소스 HEAD와 clean 상태는 실행 전후 같았고 임시 자산은 제거했다. 실제 사용자 설정이나 native/model/environment 도구는 호출하지 않았다. 공통 스킬 두 개는 skill-creator validator를 통과했다.

이 증거는 disposable Git 저장소, 임시 설정/설치 경로와 deterministic host fixture에 대한 것이다. 실제 AI Worker·계정 접근·설치된 호스트 discovery·OS별 종단 실행의 증거로 합치지 않는다. `qa-verification`은 비활성 상태라 호출하지 않았다. 외부 설치·로그인·추론·배포도 이 검증에 포함하지 않았다.

## 남은 구현과 출시 차단 조건

- **네이티브 모델·호스트 지원 범위:** 현재 대화의 실제 Agent 응답을 인증된 coordinator relay로 연결하며 별도 daemon socket은 요구하지 않는다. 기본 auto/inherit는 호스트 기본값을 상속하고 실제 모델·effort 관측은 null이다. 구체적인 모델·effort 고정값, Claude 실제 Agent 실행과 OS별 동작에는 추가 검증이 필요하다. relay는 호스트 서명 증명이 아닌 신뢰된 부모의 전달이며 각 워커의 실제 Git bootstrap을 별도 대조한다.
- **로컬 API 제한:** checkpoint는 `leaseRenewed=false`이며 heartbeat lease 연장을 제공하지 않는다. session override는 프로세스 수명만 유지하며 서버 재시작 후에는 새 hash로 승인된 설정을 다시 적용해야 한다. 요구사항은 제출·저장 후 plan과 일치해야 하며 실행 시작 후 교체할 수 없다.
- **통합된 정책:** pause 시간을 제외한 active budget, snapshot별 명시 gate/missing-tests waiver, 반복 finding 재분석 제한과 run/target별 finalize preapproval이 로컬 테스트로 검증됐다. waiver는 passed와 구분하며 config 값만으로 사용자 승인을 대신하지 않는다. 실제 호스트 승인·실행 검증과는 별개이다.
- **실제 출시 증거 부족:** Codex/Claude 각각 catalog → selection → native worker → 적용/관측 → 검증·review·finalize·복구·cleanup 경로를 완료해야 한다. Linux, Windows native/PowerShell, WSL 및 실제 두 호스트 설치/update/removal smoke는 미검증이다.
- **추가 로컬 증거:** conflict-resolution과 일부 삭제 실패 후 cleanup 재실행의 전용 acceptance fixture는 현재 문서 기준에서 확인하지 못했다. 상세 잔여 항목과 후속 변경 영향은 acceptance index에서 추적한다.

## 재현 명령

Node.js 24+와 Git이 필요하다. 현재 문서 작업은 macOS 개발 환경에서 수행했다.

```sh
npm run check
node --test tests/unit/skills.test.ts
npm run orch -- --help
npm run orch:manage -- --help
npm run schema
```

`doctor --host codex|claude`는 설치된 실행 파일의 metadata 조회 진단이며 native 실행 가능 판정이 아니다. 대화형 진입은 설치 후 `$orch`/`/orch`를 사용하되, 현재 대화의 네이티브 연결 절차를 자동 수행하며 실제 도구 부재나 작업 공간 불일치는 계속 차단한다.

## 적용한 개발 워크플로

최소 변경과 구현은 `minimal-code`, `ponytail`, 회귀 검증은 `mattpocock-skills:tdd`, `diagnose`, fixture 경계는 `software-engineering-foundations`, 병렬 worktree 통합은 `multi-agent-git-orchestration`을 적용했다. 공식 host API 조사는 `openai-docs`, 설치 스킬 작성은 `skill-creator`와 `mattpocock-skills:writing-for-agents`, README는 `awesome-readme-adaptation`을 적용했다. 독립 검토는 `ponytail-review`, `pr-security-review`, `security-hardening-review`, `dependency-vulnerability-audit`, `security-verification`을 적용했다. 비활성 `qa-verification`은 실행하지 않았다.

## 실제 네이티브 준비 상태 수정과 테스트

2026-10-20: `365e727`에서 항상 null이던 production native 연결과 잘못된 daemon socket 전제조건을 수정했다. 설치는 `installation=READY`, 첫 실행은 실제 부모 호스트 Agent의 read-only challenge 응답을 `orch_host_connect`로 전달한 뒤 `nativeDispatch=READY`가 된다. 저장소/만료/재사용/인증/개별 워커 bootstrap 검사가 유지된다. 코드 typecheck와 102개 테스트가 통과했고 독립 보안 검토 및 집중 테스트 16개도 통과했다.

설치본 `0.1.0-local.16e8bcab654f3cb2`로 임시 Git 저장소에서 실제 native `spawn_agent`를 사용했다. 워커가 지정 worktree에서 read-only bootstrap 후 `result.txt`에 정확한 `ORCH native ready\n` 바이트를 썼다. MCP가 content assertion, 단위 커밋, 통합을 수행했고 별도 네이티브 reviewer와 auditor가 실제 diff/바이트/계보를 확인했다. 최종 target SHA는 `fcbcfae2bd809f2e8eee399a99d79bc4b3ff5f4a`, run은 `run-e131609e-1617-42d6-bdd3-d10e5d909fa2`, 보고서는 `COMPLETED`, `completionVerified=true`, blockers 빈 배열, cleanup complete이다. 원본 프로젝트는 수정하지 않았다.

이는 현재 Codex 대화에서의 단일 태스크 실행 증거다. 실제 모델·effort·계정 권한은 null/unknown을 유지하며 Claude native E2E, 역할별 concrete model/effort, 다른 OS, heartbeat 연장은 이 테스트로 승인하지 않는다. 최신 source에서는 host.executionReady 표시도 실제 연결 상태와 일치시켰으며 관련 MCP/protocol/skill 집중 테스트 17개가 통과했다.
