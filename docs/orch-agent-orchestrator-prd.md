# ORCH — Codex·Claude Code 네이티브 에이전트 오케스트레이터 PRD

> **문서 버전:** 1.0.0  
> **작성일 / 외부 문서 확인일:** 2026-10-20 (Asia/Seoul)  
> **문서 상태:** 구현 기준안 — 구현·호스트 통합 테스트 전  
> **작업명:** ORCH (`orch`, 최종 제품명은 별도 결정)  
> **1차 대상:** 로컬 Codex CLI, 로컬 Claude Code  
> **언어:** 사용자 안내는 한국어·영어, 내부 ID·스키마·코드는 영어

이 문서는 지금까지 합의한 제품 요구사항과 이를 구현하기 위한 기술 계약을 함께 정의한다. `MUST`는 필수, `SHOULD`는 특별한 사유가 없으면 준수, `MAY`는 선택 사항이다. 명령어·설정 키·MCP 도구 중 `orch`에 속한 것은 **이 제품이 앞으로 구현할 인터페이스**이며 현재 배포된 기능을 뜻하지 않는다. 호스트의 실제 기능과 제품의 설계 제안을 구분한다.

특정 모델명과 성능 순위를 고정하지 않는다. 실제 설치된 호스트·계정·정책에서 조회하고 검증한 모델과 추론 수준만 실행 후보로 사용한다. 공식 문서 확인 사실에는 출처를 붙였으며, 나머지는 본 제품의 설계 요구사항이다.

---

## 목차

1. 제품 정의와 핵심 결정
2. 범위와 사용자 경험
3. 호스트 기능의 확인 사항과 제약
4. 시스템 아키텍처
5. 에이전트 역할과 모델 정책
6. 모델 검색·설정·실행 검증
7. 글로벌·프로젝트 설정
8. AI 자동 설정 가이드와 스킬
9. 요구사항 분석과 작업 분해
10. 전체 워크플로와 상태 머신
11. 병렬 스케줄러
12. Git·Worktree·원자적 커밋
13. 테스트·검증 게이트
14. 통합 리뷰·수정 반복
15. 상태 저장·중단·복구
16. 권한·보안·신뢰 경계
17. 내부 인터페이스와 데이터 계약
18. 설치·업데이트·제거
19. 패키지와 저장소 구조
20. 관측성·보고서·비기능 요구사항
21. 수용 테스트
22. 구현 단계와 개발 작업 목록
23. 출시 완료 기준
24. 기술 검증 과제와 미확정 사항
25. 공식 참고 자료

---

## 1. 제품 정의와 핵심 결정

### 1.1 한 문장 정의

**사용자가 Codex 또는 Claude Code 대화창에서 요청하면, 현재 세션이 오케스트레이터가 되어 역할별 모델을 선택하고, 독립 Worktree에서 병렬 구현·단위 커밋·통합·리뷰·재수정·검증·안전한 정리까지 수행하는 확장 기능이다.**

### 1.2 반드시 지킬 제품 계약

| ID | 결정 | 구현 의미 |
|---|---|---|
| CORE-01 | 사용자는 호스트 대화창 안에서 사용한다 | 일반 사용 흐름에서 별도 `orch run` 터미널 실행을 요구하지 않는다 |
| CORE-02 | 명시적 스킬 진입점과 자연어 요청을 모두 제공한다 | Codex `$orch`, Claude Code `/orch`를 기본 UX로 설계한다 |
| CORE-03 | 현재 메인 세션이 오케스트레이터이다 | 외부 AI 관리자 세션으로 몰래 대체하지 않는다 |
| CORE-04 | 실행을 시작한 호스트를 유지한다 | Codex 실행은 Codex 지원 OpenAI 모델, Claude 실행은 Claude 지원 Claude 모델만 사용한다 |
| CORE-05 | 역할별 모델·추론 수준을 조회·변경할 수 있다 | 요구사항, 설계, 코딩, 테스트, 리뷰, 수정의 설정을 독립 관리한다 |
| CORE-06 | 글로벌 설정과 프로젝트 설정을 함께 지원한다 | 필드 단위 상속과 값의 출처를 표시한다 |
| CORE-07 | AI에게 설정을 맡길 수 있다 | 설정 스킬·참고 문서·검증 도구를 제품에 포함한다 |
| CORE-08 | 병렬 코딩은 Worktree와 브랜치로 분리한다 | 같은 checkout에서 여러 쓰기 Worker를 실행하지 않는다 |
| CORE-09 | 논리적 작업 단위로 커밋한다 | 전체 작업을 마지막에 한 번에 커밋하거나 무조건 squash하지 않는다 |
| CORE-10 | 통합 후 독립 리뷰를 수행한다 | 리뷰 대상 커밋을 고정하고 결과를 구조화해 저장한다 |
| CORE-11 | 리뷰 수정은 다시 병렬 분배한다 | Finding Ledger와 의존성 기반 Repair Task를 사용한다 |
| CORE-12 | 반복은 종료 조건과 상한을 가진다 | 무한 재시도·무한 리뷰·조용한 품질 저하를 금지한다 |
| CORE-13 | 성공 후 안전하게 정리한다 | 실패한 작업·미병합 커밋·사용자 파일은 자동 삭제하지 않는다 |
| CORE-14 | 쉬운 설치·업데이트·제거를 제공한다 | 셸 및 PowerShell 설치 스크립트, 진단, 롤백을 포함한다 |

### 1.3 설계 원칙

- **AI는 판단하고 엔진은 상태와 불변식을 관리한다.** 계획·코드·리뷰는 AI가, 설정 검증·락·커밋·병합·정리는 결정적 코드가 담당한다.
- **네이티브 실행이 기본이다.** 메인 세션의 호스트 도구로 서브에이전트를 생성한다. MCP 서버가 기존 대화의 Agent 도구를 직접 호출할 수 있다고 가정하지 않는다.
- **지원하지 않는 기능을 성공으로 표시하지 않는다.** 모델 변경, 추론 수준 적용, 격리, 재개가 불가능하면 명확한 제한 상태로 표시한다.
- **사용자의 기존 작업과 권한을 보존한다.** 자동 stash/reset/force push, 권한 우회, 다른 공급자 전환을 기본 기능으로 넣지 않는다.
- **실행 결과를 증거와 함께 기록한다.** 모델의 “완료했다”는 답변만으로 커밋·테스트·리뷰 통과를 인정하지 않는다.

---

## 2. 범위와 사용자 경험

### 2.1 v1 필수 범위

두 호스트의 스킬 진입점, 네이티브 서브에이전트, 역할별 모델 설정, 자동 설정 Advisor, Worktree 격리, DAG 스케줄링, 단위 커밋, 직렬 통합, 테스트, 독립 리뷰, 병렬 수정, 상태 복구, 클린업, 설치 스크립트를 포함한다.

v1의 지원 환경은 로컬 Git 저장소와 설치된 Codex CLI 또는 Claude Code이다. macOS·Linux·Windows/PowerShell 설치 경로를 제공하되, 실제 지원 OS·아키텍처·호스트 버전은 릴리스 호환성 매트릭스에 테스트 결과와 함께 명시한다. WSL은 Windows 네이티브 설치와 별도 환경으로 취급한다.

### 2.2 v1 비목표

별도 IDE/웹 대시보드, 호스트 혼합 실행, 직접 LLM API 오케스트레이션, 무인 클라우드 서비스, 원격 저장소 자동 push/PR 생성, 조직 SSO, GitHub/GitLab 종속 기능, 모델 자체 학습은 범위 밖이다. 로컬 Git만으로 핵심 기능이 동작해야 한다.

설치·지원 파일을 동기화한다고 해서 Codex Cloud나 Claude 클라우드 환경을 지원한다고 표시하지 않는다. 데스크톱·IDE 호스트는 같은 계약을 재사용할 수 있지만 별도 검증 전까지 실험적이다.

### 2.3 기본 사용 시나리오

```text
# Codex 대화창
$orch 로그인 기능을 구현해줘. 작업을 나눠 병렬로 개발하고,
통합 리뷰에서 나온 문제도 수정한 다음 테스트와 정리까지 해줘.

# Claude Code 대화창
/orch 로그인 기능을 구현해줘. 작업을 나눠 병렬로 개발하고,
통합 리뷰에서 나온 문제도 수정한 다음 테스트와 정리까지 해줘.

# 자연어
이 프로젝트에 맞게 orch 모델 설정을 알아서 맞춰줘.
품질은 유지하되 불필요한 추론과 토큰 사용은 줄여줘.
```

자연어 자동 활성화는 호스트 모델의 스킬 선택에 의존한다. 이를 100% 결정적 호출로 홍보하지 않는다. 명시적 진입점이 항상 존재해야 한다. Codex의 `$` 스킬 호출과 Claude Code의 스킬 호출 방식은 공식 문서를 따른다.[^S01][^S04]

### 2.4 대화창 명령 계약

아래는 **제품 명령 문법**이다. 첫 토큰은 호스트 스킬 호출이고, 뒤의 인수는 ORCH가 해석한다. `/orch models set` 전체를 호스트의 별도 내장 명령으로 등록하는 구조가 아니다. 모든 예시에서 Claude `/orch`를 Codex `$orch`로 바꿔 사용할 수 있어야 한다.

| 입력 | 의미 | 기본 변경 범위 |
|---|---|---|
| `/orch <요구사항>` | 새 실행 시작 | 현재 프로젝트 |
| `/orch plan <요구사항>` | 분석·계획만 생성 | 실행 기록만 |
| `/orch status` | 현재 상태·Worker·모델·차단 사유 | 읽기 |
| `/orch models` | 역할별 요청·해석·관측 모델 및 추론 수준 | 읽기 |
| `/orch models available` | 현재 호스트의 모델 후보와 지원 수준 | 읽기 |
| `/orch models set coder --model <ID> --effort <LEVEL>` | 코딩 역할 설정 | 프로젝트 |
| `/orch models set reviewer --model <ID> --global` | 글로벌 리뷰 역할 설정 | 글로벌 |
| `/orch models refresh` | 현재 호스트 모델 카탈로그 새로 고침 | 캐시 |
| `/orch configure --profile balanced` | AI 자동 설정 | 프로젝트 |
| `/orch configure --global --profile quality` | 글로벌 추천 정책 설정 | 글로벌 |
| `/orch configure --dry-run` | 변경 제안·근거·차이만 출력 | 저장 안 함 |
| `/orch config --effective` | 병합 설정과 필드별 출처 | 읽기 |
| `/orch config unset <path>` | 해당 scope의 오버라이드 제거 | 프로젝트 |
| `/orch pause` | 새 작업 배정 중지, 진행 작업은 안전 지점까지 | 현재 실행 |
| `/orch resume [run-id]` | 복구·상태 확인 후 계속 | 현재/선택 실행 |
| `/orch cancel` | 중단 요청·체크포인트·자료 보존 | 현재 실행 |
| `/orch finalize` | 검증된 결과를 목표 브랜치에 반영 | 명시적 승인 필요 |
| `/orch cleanup --dry-run` | 삭제 후보와 보존 사유 확인 | 읽기 |
| `/orch cleanup` | 정책에 맞는 소유 리소스만 정리 | 현재 실행 |
| `/orch doctor` | 설치·모델·권한·Git·호스트 호환성 진단 | 읽기 중심 |
| `/orch update` | 업데이트 계획과 적용 | 설치 수정 승인 필요 |
| `/orch help` | 현재 호스트에 맞는 사용법 | 읽기 |

`--global`, `--project`, `--session`은 서로 배타적이다. 범위를 생략한 쓰기는 프로젝트에 적용한다. Git 프로젝트 밖에서는 조회·글로벌 설정만 허용하고 프로젝트 쓰기를 글로벌 쓰기로 조용히 바꾸지 않는다.

### 2.5 진행 표시

한 번에 읽을 수 있는 요약을 제공한다. 별도 조작 가능한 GUI나 터미널 dropdown을 구현하지 않은 상태에서 그런 UI가 존재한다고 표시하지 않는다.

```text
ORCH · Codex · run 20261020-001
단계: 병렬 구현    완료: 2/5    실행: 2    대기: 1

역할      적용 모델           추론 수준      설정 출처
관리자    현재 세션 모델      현재 세션 값    Host session
설계      [조회된 모델명]     [지원 값]       Auto / Project
코딩      [조회된 모델명]     [지원 값]       Project override
리뷰      [조회된 모델명]     [지원 값]       Global

T003 API 검증       RUNNING    독립 worktree
T004 UI 상태 처리  RUNNING    독립 worktree
T005 통합 테스트   BLOCKED    T003, T004 통합 대기

다음 단계: 직렬 통합 → 테스트 → 커밋 고정 리뷰
```

사각 괄호는 문서의 표시 예시이며 실제 모델명이 아니다. 실제 값이 확인되지 않으면 `확인 불가`로 표시한다.

---

## 3. 호스트 기능의 확인 사항과 제약

### 3.1 공식 문서 기준 확인 사항

| 영역 | 확인한 공식 기능 | ORCH 적용 원칙 |
|---|---|---|
| Codex 스킬 | 로컬 `.agents/skills`와 사용자 `~/.agents/skills` 탐색 | 짧은 진입점과 참고 문서 설치[^S02] |
| Codex 서브에이전트 | custom agent의 `model`, `model_reasoning_effort` | 역할 정의 생성 및 실제 호스트 버전 검증[^S03] |
| Codex 모델 목록 | App Server `model/list`, 지원 effort·기본 effort·pagination 메타데이터 | 현재 환경과 일치하는 조회 어댑터 사용[^S05] |
| Claude 스킬 | 사용자·프로젝트 스킬과 `/skill-name`, plugin namespace | `/orch`는 얇은 로컬 스킬로 유지 가능[^S04] |
| Claude 서브에이전트 | 모델·effort·worktree 관련 설정 | 동작 지원 범위와 정책 우선순위 확인[^S06] |
| Claude 모델 메타데이터 | SDK의 `supportedModels()`와 capability 정보 | 허용된 SDK 환경에서의 선택적 조회 경로[^S07][^S08] |
| MCP | 두 호스트가 MCP 도구 연결 제공 | 공통 결정적 엔진의 진입점으로 사용[^S09][^S10] |
| Git Worktree | 작업 디렉터리를 분리하되 저장소 일부 정보 공유 | 브랜치·락·병합 관리 추가 필요[^S11] |

확인일은 2026-10-20이다. 이 표는 모든 CLI 버전에서 같은 기능이 제공된다는 보장이 아니다. 구현 시 버전별 contract test가 반드시 필요하다.

### 3.2 반드시 구분할 항목

1. **스킬 설치와 모델 설정 저장은 현재 세션의 실제 적용을 보장하지 않는다.** 재로딩 또는 다음 세션이 필요한 경우 `NEEDS_RELOAD`로 표시한다.
2. **현재 부모 세션 모델과 하위 역할 모델은 다르다.** 관리자는 기본 `inherit`이며 부모 모델 변경을 요청하면 호스트의 정식 모델 선택 경로를 안내하거나 검증된 기능만 사용한다.
3. **모델 목록에 있는 것과 실행 권한이 있는 것은 다르다.** 모델 지원·계정 접근·조직 정책·현재 가용성을 별도로 표시한다.
4. **effort 명칭이 같아도 모델 간 동등한 계산량이 아니다.** 모델별 선택지와 기본값을 우선하고, 지원하지 않는 값을 임의 변환하지 않는다.
5. **MCP 연결은 기존 호스트 세션의 제어권이 아니다.** 엔진은 작업 계획과 lease를 반환하고 메인 호스트가 네이티브 에이전트를 생성한다.
6. **Worktree는 보안 샌드박스가 아니다.** 파일·프로세스·네트워크 격리의 실제 수준을 따로 보고한다.

### 3.3 중요한 호스트별 주의사항

Codex custom agent 파일에서 모든 부모 설정을 덮어쓸 수 있는 것은 아니다. `sandbox_mode`, `approval_policy`, `model_provider`, `mcp_servers` 등을 역할 파일에 넣는 것만으로 분리 적용된다고 구현하지 않는다.[^S03]

Claude의 모델·effort는 환경변수와 조직 정책에 의해 달라질 수 있다. 요청값과 실제 적용값을 구분해야 한다. 또한 plugin subagent의 일부 frontmatter 필드는 일반 프로젝트 subagent와 다르게 적용되므로 배포 방식별 테스트가 필요하다.[^S06][^S12]

Claude의 네이티브 worktree가 자동으로 원하는 integration SHA에서 만들어진다고 가정하지 않는다. 어떤 호스트든 Worker가 코딩을 시작하기 전에 **실제 cwd·Git 저장소·브랜치·base SHA**를 검증한다.[^S06]

### 3.4 지원 불가 시 동작

호스트가 지정 모델·effort·독립 작업 공간을 보장할 수 없으면 관련 작업을 `BLOCKED_CAPABILITY`로 두고 지원 가능한 선택을 설명한다. 다른 공급자 호출, API key 요구, 독립 headless 관리자 프로세스 실행으로 조용히 전환하지 않는다.

단순 순차 작업으로 낮춰 실행하는 옵션은 사용자 동의가 있을 때만 가능하며, 이를 병렬 오케스트레이션 성공으로 기록하지 않는다.

---

## 4. 시스템 아키텍처

### 4.1 구성

```text
사용자: Codex / Claude Code 대화창
                  │
          orch 진입 스킬
                  │
     현재 메인 세션 = Coordinator
         │                      │
  네이티브 Agent 도구       ORCH 로컬 MCP 도구
         │                      │
  역할별 Subagents       공통 결정적 Runtime
         │               ├─ Config / Model Registry
         │               ├─ Plan / DAG / Scheduler
         │               ├─ Git / Worktree / Merge Queue
         │               ├─ Quality Gates / Finding Ledger
         │               ├─ State Store / Operation Journal
         │               └─ Cleanup / Reports
         │                      │
         └──── Task lease / 검증된 결과 ────┘
```

### 4.2 역할별 책임

| 구성요소 | 책임 | 하지 않는 일 |
|---|---|---|
| Entry Skill | 사용자 의도 해석, 올바른 작업 절차·참고 문서 로드 | 자체 텍스트만으로 Git 안전성을 보장하지 않음 |
| Coordinator | 요구사항 확인, 계획 승인 요청, 에이전트 생성·회수, 결과 전달 | 임의로 상태 DB 수정·게이트 우회하지 않음 |
| Runtime Core | 상태 전이, 검증, 락, Git 작업, 재시도 한도, 보존 | LLM 호출로 스스로 계획하지 않음 |
| Host Adapter | 능력 탐지, 역할 정의 생성, 실행 지침·메타데이터 정규화 | 공개되지 않은 내부 인터페이스에 무조건 의존하지 않음 |
| Model Registry | 지원 목록·출처·접근 상태·effort 메타데이터 | 이름만 보고 성능·가격을 만들어내지 않음 |
| Advisor Skill | 프로젝트 분석·추천·설정 패치 제안 | 사용자 고정값·보안 정책을 무단 완화하지 않음 |
| Hooks | 지원되는 이벤트 수집, 가벼운 검사·알림·방어 | 장시간 전체 오케스트레이션 실행하지 않음 |

### 4.3 구현 스택 기준안

- TypeScript 기반 단일 저장소, Node.js 런타임, SQLite 로컬 상태 저장.
- MCP stdio 서버를 공통 도구 진입점으로 사용한다. 사용자가 별도 서버를 수동 기동할 필요가 없도록 호스트 등록을 설치기가 처리한다.
- JSON Schema를 도구 입력·출력과 설정 검증의 기준으로 사용한다. TypeScript 타입과 schema는 하나의 원천에서 생성한다.
- Git은 검증된 실행 파일을 argv 배열로 호출한다. 모델이 만든 문자열을 shell에 그대로 전달하지 않는다.
- 구체적인 라이브러리·런타임 버전은 lockfile 및 릴리스 manifest에 고정한다. 이 문서는 미검증 최신 버전 호환을 주장하지 않는다.

### 4.4 네이티브 Worker 실행 계약

1. 메인 세션이 `orch_task_prepare`를 호출한다.
2. 엔진이 ready 상태·의존성·모델·worktree·lease를 검증하고 `DispatchSpec`을 반환한다.
3. 메인 세션이 해당 호스트의 네이티브 Agent 도구로 Worker를 생성한다.
4. Worker는 부트스트랩 검증을 완료한 후에만 파일을 수정한다.
5. Worker는 결과를 제출하고, 엔진이 실제 diff·커밋·테스트를 확인한다.
6. 메인 세션이 완료 결과를 수집하고 다음 ready 작업을 배정한다.

MCP 서버가 네이티브 Agent 도구를 역호출하는 구조가 아니다. 사용자 요청에서 도출한 Task Brief를 명시적으로 전달하므로, 서브에이전트가 부모 대화 전체를 자동 상속한다고 가정하지 않는다.

### 4.5 작업 공간 연결 전략

어댑터는 아래 전략 중 **통합 테스트로 입증한 것 하나**를 사용한다.

- `core_managed`: 엔진이 만든 기존 Worktree에 네이티브 Worker의 실행 cwd를 확실히 연결한다.
- `host_managed`: 호스트의 isolation 기능으로 만든 Worktree를 등록하고, 코드 변경 전에 엔진이 base SHA·브랜치·소유권을 확인한다. 필요하면 새 작업 공간에서만 정확한 기준 커밋을 체크아웃한다.

프롬프트에 “이 폴더에서 작업하라”라고 적는 것만으로 격리를 검증했다고 보지 않는다. 최초 작업 이후에도 경로·브랜치가 일치하는지 확인한다. 호스트 자동 정리와 엔진 정리의 소유권을 구분해 이중 삭제를 방지한다.

### 4.6 세션 수명

기본 모드는 `interactive_native`이다. 메인 호스트 세션이 살아 있는 동안 순환한다. 세션 종료 후에도 자동 개발이 계속된다고 약속하지 않는다. 종료 시 durable state를 보존하고, 다음 대화에서 `/orch resume` 또는 `$orch resume`로 복구한다.

SQLite와 Git 상태는 보존되지만, 호스트의 실행 중 모델 프로세스·대화 컨텍스트까지 항상 복구되는 것은 아니다. native agent resume이 없으면 검증된 체크포인트에서 새 Worker를 만든다.

---

## 5. 에이전트 역할과 모델 정책

### 5.1 기본 역할

| 역할 ID | 책임 | 쓰기 권한 기본값 | 모델 선택 방향 |
|---|---|---|---|
| `coordinator` | 전체 진행, 배정, 결과 종합 | Runtime의 허용된 관리 작업 | 현재 메인 세션 상속 |
| `requirements` | 요구사항 정리, 인수 조건·위험·가정 | 코드 읽기 | 모호성 분석·명세화 능력 |
| `planner` | 설계, 작업 분해, DAG·파일 소유권 | 코드 읽기 | 구조 추론·의존성 판단 |
| `coder` | 독립 기능 구현 | 할당 Worktree의 허용 범위 | 코딩 품질·처리 효율 |
| `tester` | 회귀 테스트·재현 테스트 작성 | 별도 할당 범위 | 테스트 설계·경계 조건 |
| `reviewer` | 통합 변경의 결함 검토 | 읽기 전용 지향 | 결함 발견·영향 분석 |
| `repair` | Finding 해결·필요한 회귀 테스트 | 수정 Worktree의 허용 범위 | 원인 분석·국소 수정 |
| `final_auditor` | 최종 인수 조건·누락·잔여 위험 | 읽기 전용 지향 | 전체 요구사항 검증 |

모든 역할을 매번 별도 호출할 필요는 없다. 단순 작업은 요구사항·계획 단계를 한 세션에서 처리할 수 있다. 다만 **구현자와 독립된 리뷰 세션**은 기본 필수이다. 같은 모델을 쓰더라도 리뷰 세션은 구현자의 자기평가와 분리한다.

Git 병합·파일 삭제·락 처리·커밋 검증을 별도 AI 모델에 맡기지 않는다. 충돌 의미 판단이 필요할 때만 `repair` 또는 `planner`를 사용한다.

### 5.2 모델·effort 정책

- `coordinator.model`과 `coordinator.effort`의 기본값은 `inherit`이다.
- 나머지 역할은 `auto` 또는 사용자 지정 ID/alias를 허용한다.
- `auto`는 ORCH 내부 정책 값이다. 모델 실행 요청에 문자열 `auto`를 그대로 보내지 않는다.
- `inherit`는 부모 설정을 따르는 정책이다. 호스트가 실제 값을 공개하지 않으면 상속 상태와 관측 불가를 표시한다.
- 역할에 지정된 구체적인 모델·effort는 사용자 고정값으로 취급한다. 자동 추천은 이를 덮어쓰지 않는다.
- 같은 호스트 내에서만 선택한다. 모델 이름 prefix만이 아니라 호스트 카탈로그·공급자 정보·실행 경로를 함께 확인한다.
- 부모 모델을 바꾸지 않고 더 강한 Planner를 따로 배정할 수 있어야 한다.

### 5.3 프로필

| 프로필 | 선택 목표 | 제한 |
|---|---|---|
| `balanced` | 적정 품질과 토큰·시간 균형 | 기본값, 근거 없으면 호스트 기본 모델·effort 활용 |
| `quality` | 복잡한 설계·검토의 정확도 우선 | 모든 역할에 최대 effort를 일괄 적용하지 않음 |
| `economy` | 검증 가능한 범위에서 사용량 절감 | 테스트·필수 리뷰를 생략하지 않음 |
| `fast` | 독립 작업의 대기시간 최소화 | 과도한 동시성·요금 상승을 자동 승인하지 않음 |

프로필은 모델 이름의 고정 매핑이 아니라 선택 정책이다. 가격 정보가 없으면 “가장 저렴한 모델”이라고 단정하지 않고 토큰·처리시간 절감 목적이라고 설명한다.

---
## 6. 모델 검색·설정·실행 검증

### 6.1 모델 카탈로그 요구사항

| ID | 요구사항 |
|---|---|
| MODEL-01 | 설치된 호스트와 동일한 실행 파일·설정 scope·인증 방식에 대응하는 모델 목록을 조회한다 |
| MODEL-02 | 호스트, 버전, 계정/워크스페이스의 비밀이 아닌 식별값, 정책 fingerprint, 조회 시각을 캐시 키에 포함한다 |
| MODEL-03 | 지원 모델, 계정 접근 확인, 현재 가용성, effort 지원을 별도 필드로 저장한다 |
| MODEL-04 | 지원하지 않는 모델·effort 조합은 저장 또는 dispatch 전에 차단한다 |
| MODEL-05 | 전체 provider API 목록을 호스트 지원 목록의 대체물로 사용하지 않는다 |
| MODEL-06 | 조회 실패를 빈 목록으로 위장하지 않고 캐시 상태·오류를 표시한다 |
| MODEL-07 | 가격·성능 점수·컨텍스트 크기·기본 effort가 없으면 `unknown`으로 유지한다 |
| MODEL-08 | 선택 시점과 실행 시점의 모델 차이를 보고하고 실행 기록에 남긴다 |

### 6.2 호스트별 조회 전략

**Codex:** App Server의 `model/list`를 우선 후보로 한다. 초기화 handshake, pagination, 종료, 타임아웃을 구현하고 `supportedReasoningEfforts`·`defaultReasoningEffort`를 정규화한다. 별도 metadata 조회 프로세스는 메인 세션 제어기가 아니며, 선택된 profile·provider·설정이 메인과 일치하는지 검증한다.[^S05]

**Claude Code:** 현재 호스트가 제공하는 공식 모델 메타데이터를 우선한다. SDK 환경을 쓰는 경우 `supportedModels()`와 지원 effort 필드를 활용할 수 있으나, 이는 기존 대화 안의 일반 MCP 도구에 자동 제공되는 API가 아니다.[^S07][^S08] SDK의 인증·설정 문맥이 현재 CLI와 일치하지 않으면 결과를 동등한 카탈로그로 취급하지 않는다.

v1의 기본 플러그인 경로는 사용자의 기존 Claude Code 안에서 동작한다. 별도 SDK 제품에 사용자의 구독 인증을 자동 재사용하는 설계를 기본으로 삼지 않는다. SDK를 추가하는 배포 방식은 공식 인증 조건을 별도 확인해야 한다.[^S14]

**공통 대체 경로:** 공식 조회가 없거나 접근 불가하면 마지막으로 검증한 같은 환경의 카탈로그를 출처·만료 여부와 함께 표시한다. 현재 모델 상속이나 사용자가 호스트에서 확인한 선택을 제한적으로 사용할 수 있지만, 검증되지 않은 새 ID를 추천하지 않는다. 완전 자동 검색을 구현하지 못한 호스트 버전은 `partial` 지원으로 표시한다.

> 출시 차단 조건: 두 호스트 각각에서 “조회 → 선택 → 네이티브 Worker 실행 → 적용 확인”의 최소 한 경로가 증명되어야 완전 지원으로 표시한다. SDK 메서드가 문서에 존재한다는 이유만으로 이 검증을 생략하지 않는다.

### 6.3 정규화 모델 형식

```ts
interface ModelDescriptor {
  host: "codex" | "claude";
  id: string;                         // 호스트가 실제 받는 ID 또는 alias
  displayName: string;
  resolvedId: string | null;           // alias 해석 결과, 확인 가능할 때만
  family: "openai" | "claude" | "unknown";
  support: "advertised" | "verified" | "unsupported";
  access: "unknown" | "confirmed" | "denied";
  availability: "unknown" | "available" | "rate_limited" | "unavailable";
  efforts: string[] | null;            // null=정보 없음, []=명시적 미지원
  defaultEffort: string | null;
  hidden: boolean;
  source: string;
  sourceVersion: string | null;
  fetchedAt: string;                   // UTC ISO 8601
  expiresAt: string | null;
  evidence: Array<{ kind: string; ref: string }>;
}
```

`support=advertised`를 `access=confirmed`로 바꾸지 않는다. 모든 후보에 시험 요청을 보내 계정 한도나 요금을 소모하지 않는다. 실제 업무의 첫 실행 또는 사용자가 승인한 소규모 검증으로 접근 상태를 갱신한다.

### 6.4 모델 관리 출력

각 역할에 아래 정보를 제공한다.

- `requested`: 파일·세션에서 요청한 값 (`auto`, `inherit`, ID).
- `resolved`: 정책과 카탈로그로 선택한 실행 요청 ID·effort.
- `observed`: 호스트 이벤트/메타데이터로 확인한 실제 ID·effort. 확인되지 않으면 null.
- `source`: 기본값·글로벌·프로젝트·세션과 해당 파일/필드 경로.
- `status`: 적용됨·검증 대기·재로딩 필요·정책에 의해 제한됨·지원 안 됨.

모델 alias가 실제로 어느 모델로 해석됐는지 알 수 없다면 alias와 `resolvedId=null`을 저장한다. 가능하면 run 시작 시 구체적 ID로 고정한다. 고정이 불가능한 alias는 재현성 제한을 표시한다.

### 6.5 추론 수준 선택

`auto` effort는 해당 모델의 기본값에서 시작한다. 복잡한 설계, 경쟁 상태, 인증·데이터 무결성 변경, 반복 실패에서 지원 범위 내 상향을 검토한다. 단순 탐색·보일러플레이트는 실제 평가가 뒷받침될 때 하향할 수 있다.

모델별 후보 목록이 `low/medium/high`와 다를 수 있으므로 UI·schema를 이 세 값으로 고정하지 않는다. 명시적 사용자 값이 미지원이면 오류를 반환한다. 자동 설정은 근거가 있는 지원 값 또는 호스트 기본값 생략을 선택하고 그 이유를 남긴다.

effort 미지원 모델에는 해당 파라미터를 보내지 않는다. 세션/조직 정책으로 clamp된 값이 관측되면 `effective differs from requested`를 출력한다. 실제 값을 알 수 없을 때 “적용 완료” 대신 “요청 전달, 실제 값 미확인”으로 표시한다.

### 6.6 변경 시점

새 설정은 기본적으로 **아직 생성되지 않은 다음 Worker**부터 적용한다. 이미 실행 중인 Worker의 모델을 임의 변경하거나 중단하지 않는다. 각 attempt는 자신의 config revision과 model resolution을 보존한다.

호스트가 역할 정의를 즉시 반영하지 못하면 `NEEDS_RELOAD`를 반환한다. 새 값이 적용되지 않았는데 기존 모델로 실행하는 silent fallback은 금지한다. 진행 중 run이 서로 다른 revision을 사용했다면 보고서에 명시한다.

새 모델 출시·카탈로그 갱신은 자동 교체가 아닌 재추천 트리거이다. 진행 중 run의 모델은 요청 없는 한 유지한다.

---

## 7. 글로벌·프로젝트 설정

### 7.1 파일 위치

| 구분 | 위치 | 내용 |
|---|---|---|
| 글로벌 설정, macOS/Linux 기본 | `${XDG_CONFIG_HOME:-~/.config}/orch/config.yaml` | 사용자 기본값 |
| 글로벌 설정, Windows 기본 | `%APPDATA%\orch\config.yaml` | 사용자 기본값 |
| 명시적 설정 위치 | `ORCH_CONFIG_HOME/config.yaml` | 사용자가 지정한 위치 우선 |
| 프로젝트 설정 | `<invocation-repo-root>/.orch/config.yaml` | 저장소별 오버라이드 |
| 실행 상태 | `<origin-root>/.orch/state/` | DB·보고서·고정 설정·작업 증거 |
| 공유 저장소 락 | `<git-common-dir>/orch/locks/` | 같은 Git 저장소의 여러 checkout 간 조정 |

설치 scope와 설정 scope는 서로 다르다. 글로벌로 스킬을 설치했더라도 모든 프로젝트에서 `.orch/config.yaml`을 읽는다. 프로젝트 설정을 쓰기 위해 스킬을 중복 설치할 필요가 없다.

초기 호출의 저장소 root를 `origin_root`로 고정하고 모든 Worker에게 전달한다. Worktree 내부에서 root를 다시 계산해 서로 다른 DB를 만드는 것을 금지한다. 사용자가 기존 linked Worktree에서 시작해도 git common directory를 기준으로 중복 run 락을 확인한다.

### 7.2 설정 적용 순서

```text
제품 기본값 < 글로벌 설정 < 프로젝트 설정 < 명시적 현재 세션 오버라이드
```

호스트/조직 권한 정책과 사용자 승인 경계는 위 값 병합보다 상위의 제한이다. 프로젝트 파일이 보안 권한을 완화하거나 글로벌 업데이트 권한을 부여할 수 없다.

병합 규칙:

- object는 key별 재귀 병합, scalar는 높은 우선순위 값으로 교체한다.
- 배열은 통째로 교체한다. 자동 이어붙이기는 하지 않는다.
- 미기재 필드는 상속한다. `null`은 schema가 허용한 필드에서만 값이며 “삭제”의 의미가 아니다.
- `config unset`은 선택 scope의 key를 제거해 하위 기본값이 다시 드러나게 한다.
- `auto`와 `inherit`는 다른 값이다. 전자는 추천 선택, 후자는 부모 세션 상속이다.
- 알 수 없는 key, 중복 YAML key, 잘못된 타입은 오류로 처리한다. 임의 YAML 객체 태그·과도한 alias expansion은 금지한다.
- 마이그레이션 전 백업하고, 높은 schema version을 구버전 엔진이 조용히 다시 저장하지 않는다.

### 7.3 기본 설정 예시

다음은 **ORCH v1이 제공할 설정 형식**이다. 모든 모델을 `auto`/`inherit`로 표현해 모델명 하드코딩을 피한다.

```yaml
schema_version: 1

model_selection:
  profile: balanced
  allow_cross_host: false
  allow_unverified_models: false
  catalog_cache_ttl_hours: 24
  on_model_unavailable: pause
  on_catalog_change: recommend_only

hosts:
  codex:
    enabled: true
    roles:
      coordinator:   { model: inherit, effort: inherit }
      requirements:  { model: auto, effort: auto }
      planner:       { model: auto, effort: auto }
      coder:         { model: auto, effort: auto }
      tester:        { model: auto, effort: auto }
      reviewer:      { model: auto, effort: auto }
      repair:        { model: auto, effort: auto }
      final_auditor: { model: auto, effort: auto }
  claude:
    enabled: true
    roles:
      coordinator:   { model: inherit, effort: inherit }
      requirements:  { model: auto, effort: auto }
      planner:       { model: auto, effort: auto }
      coder:         { model: auto, effort: auto }
      tester:        { model: auto, effort: auto }
      reviewer:      { model: auto, effort: auto }
      repair:        { model: auto, effort: auto }
      final_auditor: { model: auto, effort: auto }

execution:
  mode: interactive_native
  max_parallel_workers: 4
  max_parallel_test_jobs: 1
  max_task_attempts: 3
  max_review_rounds: 3
  max_repeated_finding_rounds: 2
  task_timeout_minutes: 30
  run_timeout_minutes: 180
  on_host_disconnect: pause_and_preserve

planning:
  require_approval: true
  preserve_user_overrides: true

git:
  target_branch: null
  integration_prefix: orch
  merge_strategy: merge_no_ff
  commit_policy: atomic_unit
  finalization: approval_required
  remote_push: false
  dirty_checkout_policy: stop

review:
  required: true
  block_on: [critical, high]
  independent_session: true
  final_audit: true
  unresolved_nonblocking: report

quality:
  baseline_required: true
  commands: []
  allow_missing_tests: false

cleanup:
  on_success: owned_merged_clean_only
  on_failure: preserve
  keep_reports: true
  keep_integration_until_finalized: true

observability:
  telemetry: "off"
  store_raw_prompts: false
  redact_secrets: true
```

기본 `target_branch: null`은 “main으로 자동 병합”이 아니라 계획 단계에서 현재 attached branch를 제안하고 확정하라는 의미이다. `quality.commands: []`이면 자동 분석으로 검증 명령을 제안·확정하기 전까지 실행을 시작하지 않는다. 설정 파일만 설치했다고 게이트가 준비된 것으로 표시하지 않는다.

상한·타임아웃 값은 초기 제품 기본값이며 실제 계정의 제한이나 작업량을 보장하는 수치가 아니다. 대기·사용자 승인·명시적 pause 시간은 active timeout과 별도로 기록한다.

### 7.4 프로젝트 오버라이드 예시

```yaml
schema_version: 1
model_selection:
  profile: quality
execution:
  max_parallel_workers: 2
quality:
  commands:
    - id: unit
      executable: npm
      args: ["test", "--", "--runInBand"]
      cwd: "."
      stages: [baseline, task, integration, final]
      required: true
      timeout_seconds: 600
```

위 `npm test`는 Jest 기반 예시 프로젝트용이다. 모든 프로젝트에 적용하는 명령이 아니다. Advisor가 실제 package scripts·CI 설정·언어 환경을 읽어 적절한 명령을 제안해야 한다.

품질 프로필을 프로젝트에 적용해도 사용자가 글로벌에서 특정 역할에 지정한 구체적 모델은 자동 변경하지 않는다. 사용자가 해당 역할의 모델을 명시적으로 바꾸거나 `auto`로 되돌렸을 때만 재선택한다.

### 7.5 설정 변경 트랜잭션

`read → schema validate → semantic validate → diff → authorized apply → atomic replace → readback` 순서로 처리한다. 파일 hash에 대한 낙관적 동시성 검사를 사용하고, 다른 편집이 감지되면 재병합한다. 주석과 key 순서를 가능한 한 보존한다.

프로젝트 설정 변경은 저장만 하고 자동 Git commit하지 않는다. ORCH 실행 자체의 코드 커밋과 설정 변경을 섞지 않는다. 사용자가 설정 버전 관리를 요청하면 별도 커밋으로 처리한다.

### 7.6 실행 고정 파일

`.orch/state/runs/<run-id>/resolved-config.json`에 다음을 저장한다.

```json
{
  "schema_version": 1,
  "run_id": "run-example",
  "host": "codex",
  "config_revision": 1,
  "config_hash": "sha256:<calculated>",
  "catalog_fingerprint": "sha256:<calculated>",
  "host_version": "<detected>",
  "roles": {
    "coder": {
      "requested_model": "auto",
      "resolved_model": "<catalog-id>",
      "requested_effort": "auto",
      "resolved_effort": "<supported-value-or-null>",
      "selection_reason": "프로젝트 분석 및 balanced 정책에 따른 선택"
    }
  }
}
```

angle bracket 값은 schema 설명용 placeholder이다. 실제 출력은 유효한 ID·hash·null로 채운다. 인증 토큰·API key·전체 환경변수는 저장하지 않는다.

---

## 8. AI 자동 설정 가이드와 스킬

### 8.1 제공할 콘텐츠

| 파일 | 책임 |
|---|---|
| `skills/orch/SKILL.md` | 시작·상태·복구·모델·설정 하위 의도 라우팅 |
| `skills/orch-configure/SKILL.md` | 자연어 설정·최적화 요청 처리 |
| `references/model-selection.md` | 능력 중심 모델 선택, 근거·불확실성 표시 |
| `references/reasoning-effort.md` | 모델별 effort 지원 검증·상향·하향 조건 |
| `references/agent-roles.md` | 역할 책임·도구·독립 리뷰 규칙 |
| `references/project-analysis.md` | 언어·테스트·위험·리소스 분석 절차 |
| `references/configuration.md` | scope·병합·고정값·변경 정책 |
| `references/workflow.md` | 작업 분해·커밋·통합·리뷰·정리 순서 |
| `references/recovery.md` | 중단·재개·미병합 변경 보존 절차 |
| `references/safety.md` | 신뢰·권한·위험 명령·민감정보 처리 |

공통 원본에서 호스트별 스킬을 빌드한다. 같은 가이드의 두 복사본을 사람이 각각 수정하도록 만들지 않는다. `SKILL.md`에는 라우팅과 핵심 규칙만 두고 상세 문서는 필요할 때 로드하도록 한다.[^S01][^S04]

### 8.2 Advisor 입력과 출력

입력은 사용자 목표, 현재 호스트, effective config, 모델 카탈로그, 프로젝트 요약, 테스트 상태, 허용된 리소스이다. “품질”, “속도”, “비용”의 우선순위가 없으면 `balanced`를 적용하고 이를 설명한다.

출력은 `Recommendation` 구조로 반환한다.

```ts
interface Recommendation {
  scope: "global" | "project" | "session";
  host: "codex" | "claude";
  configRevision: number;
  proposedPatch: Array<{
    op: "add" | "replace" | "remove";
    path: string;
    value?: unknown;
  }>;
  selections: Array<{
    role: string;
    modelId: string;
    effort: string | null;
    reasons: string[];
    evidenceRefs: string[];
    confidence: "low" | "medium" | "high";
  }>;
  preservedOverrides: string[];
  warnings: string[];
  requiresApproval: boolean;
}
```

### 8.3 자동 설정 절차

1. 호출 호스트와 설정 범위를 확인한다. 현재 Codex에서 Claude 설정을 묵시적으로 수정하지 않는다.
2. 글로벌·프로젝트·세션 설정과 사용자 고정값을 읽는다.
3. 실행 가능 모델·effort 목록을 조회한다. 조회 실패 시 추측을 중단하고 허용된 대체 경로를 사용한다.
4. 프로젝트의 언어·프레임워크·패키지 관리자·CI·테스트·핵심 모듈을 제한된 범위로 분석한다.
5. 인증·결제·파일 삭제·마이그레이션·병렬성 등 위험 요인을 분류한다.
6. 역할별 요구 능력, 프로필, 현재 컨텍스트 크기, 사용량 한도를 고려해 후보를 좁힌다.
7. 추천 이유와 근거가 약한 부분을 명시한다. 모델 이름·버전 번호만으로 절대 순위를 만들지 않는다.
8. 모델·effort·명령·schema를 프로그램으로 검증한다.
9. 사용자가 자동 설정을 요청했다면 승인된 범위의 설정을 적용한다. 위험 권한·글로벌 변경·외부 과금 전환은 별도 승인 대상이다.
10. 변경 전후, 출처, 유지한 고정값, 실제 적용 시점을 보고한다.

### 8.4 가이드에 명시할 선택 규칙

- 현재 메인 세션 모델을 작업 관리용으로 재사용한다. 단순 상태 업데이트마다 별도의 고성능 모델 호출을 만들지 않는다.
- 계획·리뷰는 문제 복잡도에 맞는 모델을, 코딩·반복 수정은 품질을 충족하는 효율적인 모델을 선택한다.
- 초기 선택 근거가 부족하면 호스트 권장 기본값에서 시작한다. “최적”이라는 표현보다 선정 근거와 검증 결과를 보여준다.
- 실패 원인이 테스트 환경·명세·의존성인데 모델 수준만 올리는 식으로 처리하지 않는다.
- 자동 상향은 `auto` 필드에만 적용하고, 변경 사유·적용 task·횟수·예산 영향을 기록한다.
- 토큰·시간·성공률의 실제 관측치가 충분하지 않으면 자동 학습 추천을 활성화하지 않는다.
- 테스트/리뷰 생략, 승인 해제, 다른 공급자 사용을 사용량 절감 수단으로 제안하지 않는다.

### 8.5 최소 스킬 골격

아래는 공통 내용의 예시이다. frontmatter의 호스트별 필드는 어댑터에서 추가한다.

```markdown
---
name: orch-configure
description: >
  Configure ORCH models, reasoning effort, role assignments and execution
  settings. Use when the user asks to configure or optimize ORCH for the
  current project, improve quality, reduce usage, or change agent models.
---

# ORCH Configuration Advisor

1. Read the detected host and effective configuration through ORCH tools.
2. Read references/configuration.md and references/model-selection.md.
3. Query supported models and effort capabilities; never invent model IDs.
4. Inspect the project only as needed and preserve explicit user overrides.
5. Propose a validated patch for the requested scope.
6. Apply only authorized changes; do not weaken safety settings.
7. Report selected models, reasons, sources and actual activation status.
```

`orch` 메인 스킬은 반드시 현재 대화에서 동작하도록 구성한다. 스킬 전체를 forked subagent로 보내 부모 세션의 관리자 역할을 잃는 구성을 기본값으로 사용하지 않는다. 별도 실행이 필요한 분석 작업만 하위 역할로 분리한다.

### 8.6 스킬 평가

한국어·영어의 should-trigger / should-not-trigger 입력을 포함한 fixture를 제공한다. 최소 사례는 자동 모델 설정, 수동 모델 고정, 글로벌 변경, 프로젝트 변경, 단순 설명 요청, 다른 도구 설정, 상태 조회, 위험한 승인 해제 요청이다.

“설정 방법 설명해줘”에는 파일을 쓰지 않아야 한다. “이 프로젝트에 맞게 설정해줘”에는 프로젝트 설정만 변경해야 한다. 기존 사용자 고정값을 보존했는지도 검증한다.

---

## 9. 요구사항 분석과 작업 분해

### 9.1 요구사항 산출물

요구사항 Agent는 `requirements.json`과 사람이 읽을 수 있는 `requirements.md`를 생성한다. 다음 항목을 포함한다.

| 항목 | 내용 |
|---|---|
| Goals | 사용자가 얻으려는 기능과 결과 |
| In scope / Out of scope | 이번 run에서 구현할 범위와 제외 범위 |
| Acceptance criteria | 검증 가능한 완료 조건, 고유 `AC-*` ID |
| Constraints | 언어·플랫폼·호환성·성능·보안·배포 제한 |
| Assumptions | 명시되지 않아 채택한 가정 |
| Risks | 파괴적 변경·보안·운영 영향 |
| Verification plan | 조건별 테스트 또는 수동 검증 방법 |

합리적인 기본값이 있는 사소한 사항 때문에 매번 중단하지 않는다. 그러나 데이터 삭제, 기존 공개 API 파괴, 신규 과금, 자격증명 필요, 배포 대상 변경처럼 되돌리기 어려운 결정은 승인 없이 확정하지 않는다.

### 9.2 Task 분해 규칙

Task는 하나의 설명 가능한 목적, 명확한 파일 소유 범위, 인수 조건, 검증 방법을 가져야 한다. 역할·모델 선택은 Task의 복잡도와 위험도에 연결한다. 단순히 파일 개수만으로 분할하지 않는다.

Planner는 DAG를 제출한다. 프로그램이 cycle, 없는 dependency, 자기 의존성, 누락된 acceptance mapping, 중복 쓰기 소유권을 검증한다. 실행 중 범위 변경은 plan revision으로 기록한다.

```json
{
  "id": "T-003",
  "title": "만료 세션 거부 처리와 회귀 테스트",
  "role": "coder",
  "depends_on": ["T-001"],
  "acceptance_ids": ["AC-002", "AC-003"],
  "read_paths": ["src/auth/**", "tests/auth/**"],
  "write_paths": ["src/auth/session.ts", "tests/auth/session.test.ts"],
  "exclusive_resources": ["auth-session-contract"],
  "risk": "high",
  "complexity": "medium",
  "verification_ids": ["unit-auth"],
  "commit_units": [
    { "id": "U-001", "purpose": "만료 검증과 회귀 테스트를 함께 추가" }
  ]
}
```

### 9.3 병렬화 예시

```text
T1 공통 데이터 타입 확정
 ├─ T2 API 검증 구현 + 테스트
 └─ T3 UI 상태 구현 + 테스트
       │
T2·T3 통합 완료
       └─ T4 통합 시나리오 테스트
```

T2와 T3는 T1이 integration에 반영된 이후의 같은 SHA에서 시작할 수 있다. T4는 단순히 두 Worker가 종료됐다는 이유로 시작하지 않고, 필요한 결과가 integration에 반영됐는지 확인한다.

인터페이스·lockfile·DB migration 같이 충돌 가능성이 높은 영역은 먼저 합의하거나 전담 Task로 직렬화한다. “여러 Worktree를 쓰므로 충돌하지 않는다”는 가정을 금지한다.

---
## 10. 전체 워크플로와 상태 머신

### 10.1 정상 흐름

```text
CREATED
  → PREFLIGHT
  → ANALYZING
  → PLAN_READY
  → [계획 승인 또는 사전 승인 정책 확인]
  → EXECUTING
  → INTEGRATING
  → VERIFYING
  → REVIEWING
      ├─ 수정 필요 → REPAIR_PLANNING → EXECUTING → ...
      └─ 통과 → FINAL_AUDIT
                   ├─ 수정 필요 → REPAIR_PLANNING → ...
                   └─ 통과 → READY_TO_FINALIZE
                                → FINALIZING
                                → CLEANING
                                → COMPLETED
```

공통 보조 상태는 `PAUSING`, `PAUSED`, `BLOCKED`, `CANCELLING`, `CANCELLED`, `FAILED`이다. `BLOCKED`는 구조화된 reason code를 가진다. 코드 구현 완료와 목표 브랜치 반영 완료를 구분한다.

`COMPLETED`에는 `cleanup_status=complete|partial|not_requested`를 함께 기록한다. 안전 때문에 일부 리소스를 남겼다면 코드 완료를 부정할 필요는 없지만, 정리까지 모두 성공했다고 표시하면 안 된다.

### 10.2 단계별 입력·출력·게이트

| 단계 | 주요 처리 | 다음 단계로 이동하는 조건 |
|---|---|---|
| PREFLIGHT | 호스트·Git·권한·설정·카탈로그·락 확인 | 지원 가능한 실행 경로와 base가 확정됨 |
| ANALYZING | 요구사항·프로젝트·baseline 분석 | 인수 조건, 테스트 전략, 위험 목록 생성 |
| PLAN_READY | DAG·파일 소유권·모델 배정 표시 | 계획 승인 정책 충족, schema·DAG 검증 통과 |
| EXECUTING | ready Task를 Worker 슬롯에 배정 | 모든 필수 Task가 검증된 커밋 제출 또는 명확한 차단 |
| INTEGRATING | Task 커밋을 직렬로 통합 | 충돌 해결, integration SHA 확정 |
| VERIFYING | 필수 테스트·빌드·정적 검사 | 정확한 SHA에 대한 필수 게이트 통과 |
| REVIEWING | 고정 SHA 독립 리뷰 | 유효한 리뷰와 Finding Ledger 갱신 |
| REPAIR_PLANNING | 이슈 중복 제거·수정 DAG 생성 | 충돌 없는 수정 계획 확정, 한도 미초과 |
| FINAL_AUDIT | 요구사항 coverage·최종 위험 검토 | 미충족 인수 조건과 차단 Finding이 없음 |
| READY_TO_FINALIZE | 최종 diff·테스트·위험·목표 ref 표시 | 명시 승인 또는 사전에 승인한 자동 반영 정책 |
| FINALIZING | target drift 확인·안전한 반영 | 검증된 이력이 목표 브랜치에 포함됨 |
| CLEANING | 소유·병합·clean·비실행 상태 검사 | 삭제 또는 보존 이유 기록 완료 |

### 10.3 완료 판정 불변식

아래 조건을 **프로그램이 계산**해야 한다.

```text
all_required_tasks_integrated
AND all_required_acceptance_criteria_verified
AND required_quality_gates_passed_for_final_sha
AND independent_review_passed_for_final_sha
AND blocking_findings_count == 0
AND no_active_writer_leases
AND target_ref_contains_approved_result
```

테스트가 없거나 일부를 면제한 실행은 해당 예외와 승인자를 보고한다. 이를 완전 검증과 동일하게 표시하지 않는다. 최종 반영 승인을 기다리는 run은 `READY_TO_FINALIZE`이며 `COMPLETED`가 아니다.

### 10.4 중단과 재개

`pause`는 새 dispatch를 멈추고 진행 Worker를 안전 지점까지 기다리는 기본 동작이다. 즉시 중지가 필요하면 호스트가 제공하는 취소 기능을 사용하되 부분 변경을 보존한다.

`cancel`은 새 작업을 금지하고 실행 중 Worker의 중단을 요청한다. 중지 확인이 안 된 Worker가 있는 동안 해당 Worktree를 제거하지 않는다. `cancel`은 자동 rollback이나 사용자 checkout 복원을 뜻하지 않는다.

`resume`은 마지막 상태를 무조건 이어 붙이는 명령이 아니다. 호스트·권한·Git refs·lease·테스트 결과·프로세스 상태를 재조정한 다음 가장 가까운 안전 단계로 돌아간다.

---

## 11. 병렬 스케줄러

### 11.1 Task 상태

```text
PENDING → READY → LEASED → RUNNING → VALIDATING
         → COMMITTED → MERGE_QUEUED → INTEGRATED
```

실패 경로: `RUNNING/VALIDATING → RETRYABLE_FAILED → READY` 또는 `BLOCKED/FAILED/CANCELLED`. `LEASED` 후 실제 Worker 생성이 실패하면 lease와 슬롯을 회수한다. 커밋이 있는 Task는 재시작 때 곧바로 재구현하지 않고 먼저 조정한다.

### 11.2 배정 알고리즘

ready 조건은 의존 Task의 필요한 결과가 integration에 반영됐고, 쓰기 범위·독점 자원 충돌이 없고, 모델·권한·예산·슬롯이 허용되는 것이다.

```text
for each scheduling tick:
  reconcile expired leases and completed workers
  stop if run is paused/cancelling/blocked or budget exceeded
  candidates = tasks whose dependencies are integrated
  sort candidates by critical-path priority, then creation order
  for task in candidates:
    if no conflict and a slot is available:
      allocate lease + exact base SHA + model resolution atomically
      return dispatch request to the parent host
```

모든 AI 하위 역할은 공통 Worker 슬롯을 사용한다. 메인 Coordinator는 슬롯에서 제외한다. 테스트 프로세스는 별도 `max_parallel_test_jobs` 제한을 둔다. 설정된 병렬 수는 상한이지 항상 그 수만큼 실행하겠다는 보장이 아니다.

### 11.3 충돌 예방

`write_paths`가 겹치거나, 둘 이상의 Task가 같은 `exclusive_resources`를 요구하면 직렬화한다. 초기 버전의 glob overlap 검사는 보수적이어야 한다. 안전한 비중첩을 입증하지 못하면 병렬 실행하지 않는다.

패키지 lockfile, 루트 설정 파일, 공통 스키마, DB migration 번호, 생성 코드 출력 디렉터리는 전담 소유권을 갖는다. Worker가 파일 범위를 확장해야 하면 변경 요청을 제출하고 계획 revision을 갱신한 후 진행한다.

읽기 범위가 서로 겹치는 것은 허용한다. 하지만 다른 Task가 변경할 공통 계약에 의존한다면 `depends_on` 또는 계약 resource를 명시한다.

### 11.4 실행 리소스

Worktree별 tmp directory, 테스트 데이터베이스 이름, 서비스 포트, 빌드 산출물 경로를 구분한다. 공유 개발 DB·공용 포트를 기본으로 사용하지 않는다. 리소스 이름은 `run_id/task_id/attempt`에서 충돌 없이 생성한다.

dependency 설치·외부 서비스 호출은 신뢰된 bootstrap policy를 통과해야 한다. Worktree를 만들 때마다 임의 `postinstall`을 자동 실행하지 않는다. 의존성 캐시는 공유할 수 있지만 mutable build output의 동시 쓰기는 분리한다.

### 11.5 예산과 재시도

`max_task_attempts=3`은 최초 1회와 재시도 최대 2회를 뜻한다. 오류를 다음과 같이 구분한다.

| 오류 종류 | 기본 처리 |
|---|---|
| 일시적 네트워크·rate limit | bounded backoff, 계정 전체 동시성 완화 검토 |
| 인증 만료·권한 거부 | 일시 중지, 인증 정보 복사나 우회 금지 |
| 코드 테스트 실패 | 실패 로그를 포함한 동일 Task 수정 attempt |
| 모델 미지원·effort 미지원 | 실행 차단, 카탈로그 갱신·설정 변경 요청 |
| 명세 모순·지속되는 동일 결함 | Planner에 재설계 요청 또는 사용자 검토 |
| 디스크 부족·Git 손상 | 새 쓰기 중지, 진단·자료 보존 |

사용량 데이터가 없으면 토큰 기반 hard cap이 정확히 작동한다고 표시하지 않는다. wall time·attempt·review round는 엔진에서 제한하고, 공급자가 제공한 usage만 별도로 기록한다.

---

## 12. Git·Worktree·원자적 커밋

### 12.1 사전 검사

Git 저장소·attached branch·작업 트리 상태·Git 사용자 정보·커밋 서명 정책·현재 HEAD·target branch·merge/rebase 진행 여부·사용 가능한 디스크를 확인한다.

기본 `dirty_checkout_policy=stop`이다. 원본 checkout에 변경이 있으면 위치를 보여주고 사용자의 보존 방식을 기다린다. 자동 stash, `reset --hard`, `clean -fd`, 강제 checkout은 금지한다. 계획만 작성하는 read-only 모드는 가능하다.

브랜치가 없는 빈 저장소·bare repository·submodule 내부·LFS·복잡한 submodule 갱신은 지원 여부를 명확히 감지한다. v1에서 검증되지 않은 조합을 일반 저장소처럼 실행하지 않는다.

### 12.2 브랜치와 경로

```text
target:      사용자가 확정한 기존 브랜치
integration: orch/<run-id>/integration
task:        orch/<run-id>/task/<task-id>
repair:      orch/<run-id>/repair/<round>/<task-id>
conflict:    orch/<run-id>/conflict/<operation-id>
```

각 task attempt는 별도 Worktree 또는 검증된 재사용 Worktree에 연결된다. 핵심 metadata는 DB와 manifest에 저장하며 브랜치 이름만으로 소유권을 인정하지 않는다.

core-managed Worktree 기본 저장 위치는 원본 checkout 밖의 사용자 로컬 데이터 디렉터리 `orch/worktrees/<repo-id>/<run-id>/...`이다. sibling 경로 사용은 설정으로 허용할 수 있다. 경로는 실제 canonical path·Git common directory·root marker로 검증한다.

### 12.3 기준 커밋 정책

- integration은 계획에서 확정한 `target_base_sha`에서 생성한다.
- 같은 독립 실행 wave의 Worker는 기록된 integration SHA에서 시작한다.
- dependency를 가진 Task는 필요한 변경이 통합된 최신 검증 가능한 SHA에서 시작한다.
- repair Worker는 해당 리뷰의 `reviewed_sha` 또는 그 이후 명시적으로 갱신한 repair base에서 시작한다.
- Worker 실행 중 integration이 진행되어도 base를 몰래 바꾸지 않는다.

Git Worktree는 별도 작업 디렉터리를 제공하지만 저장소 정보 일부를 공유한다. 따라서 저장소 전역 Git 조작과 병합은 별도의 조정이 필요하다.[^S11]

### 12.4 커밋 단위

**원자적 단위 = 하나의 설명 가능한 변경 목적과 그 목적을 검증하는 필요한 테스트.** 기능과 테스트를 무조건 서로 다른 커밋으로 분리하지 않는다. 모든 커밋이 실행 가능한 상태가 되도록 우선한다.

Worker는 commit unit의 목적·파일·메시지를 제안한다. 엔진은 allowlist·diff·실행 결과를 확인한 뒤 커밋한다. 구현과 무관한 formatting, dependency bump, 설정 변경을 같은 커밋에 넣지 않는다.

```text
feat(auth): reject expired sessions

Orch-Run: run-20261020-001
Orch-Task: T-003
Orch-Unit: U-001
```

기존 커밋 형식이 있으면 이를 우선한다. ORCH 추적 정보는 trailer로 남긴다. 기존 Git hook이나 서명 정책을 `--no-verify` 또는 서명 비활성화로 우회하지 않는다.

커밋 시 처리 순서:

1. Worker의 해당 unit 쓰기가 멈춘 안전 경계를 확인한다.
2. 명시적 경로 목록으로 diff를 검사하고 허용 범위 밖 변경을 차단한다.
3. 테스트 대상 소스 fingerprint를 기록한다.
4. unit/task 검증을 실행한다.
5. 검증 중 소스가 달라지지 않았는지 재확인한다.
6. 정확한 경로만 stage한다. 기본 `git add .`를 사용하지 않는다.
7. staged diff에 secret·예상 외 파일·충돌 marker가 없는지 검사한다.
8. 커밋 생성 후 SHA·부모 SHA·트리·파일·메시지를 읽어 DB에 저장한다.

실패 중간 상태는 Worktree에 보존한다. 사용자 이력에 깨진 WIP 커밋을 기본으로 쌓지 않는다. 필요한 복구 snapshot은 run 소유 영역에 별도로 기록하고 보존 정책을 따른다.

### 12.5 통합 큐

integration branch writer는 한 명이다. 기본 전략은 `merge_no_ff`로 단위 커밋을 유지한다. 동일한 작업을 merge와 cherry-pick 양쪽으로 중복 적용하지 않는다. squash는 기본 비활성화한다.

각 merge operation은 `expected_integration_sha`, `task_head_sha`, `operation_id`를 가진다. 실행 전에 refs를 재확인하고, 성공 후 실제 부모 관계와 task commit 포함 여부를 검사한다. 같은 operation을 재요청하면 기존 결과를 반환한다.

Task의 최초 부모가 허용된 base인지, 이후 변경이 해당 run 소유 Task에 해당하는지 검증한다. 임의 외부 커밋이나 원본 브랜치 변조를 제출된 Task 결과로 받아들이지 않는다.

### 12.6 병합 충돌 처리

충돌은 무조건 `ours`/`theirs`로 덮지 않는다. integration 큐를 일시 정지하고 정확한 양쪽 SHA와 충돌 파일을 기록한다.

기본 구현은 **run 소유의 임시 integration candidate Worktree**에서 충돌을 재현하고, 충돌 해결 Worker가 의미를 검토한 결과를 테스트한다. 승인된 merge 결과의 부모가 기대한 두 SHA인지 확인한 후, 멈춰 있는 integration에 반영한다.

이미 integration Worktree가 충돌 상태라면 엔진이 시작한 작업인지 확인하고 그 작업만 안전하게 abort한다. 사용자 checkout에서 발생한 merge/rebase를 임의 abort하지 않는다. 충돌 해결 결과도 일반 구현 변경처럼 리뷰 대상에 포함한다.

### 12.7 최종 반영

기본값은 `approval_required`이다. 사용자는 실행 시작 시 대상 브랜치와 정책을 확인한 뒤 해당 run에 한해 `auto_on_success`를 승인할 수 있다. 이 경우 필수 게이트를 모두 통과하면 추가 반복 질문 없이 반영한다. 보호된 브랜치와 조직 권한 정책은 계속 적용된다.

최종 반영 직전 target SHA가 바뀌었다면 기존 리뷰 통과를 그대로 재사용하지 않는다. 새로운 target을 integration에 반영한 뒤 필요한 전체 테스트·리뷰를 다시 수행한다. 리뷰 반복 상한도 유지한다.

최종 target 반영은 검증된 integration으로의 **fast-forward-only**를 기본으로 한다. 내부 Task 통합의 `merge_no_ff`와 구분하며, 최종 반영 과정에서 검토하지 않은 추가 merge commit을 만들지 않는다. fast-forward가 불가능하면 target drift를 해결하고 새 integration SHA에 대한 검증을 마친다.

현재 checkout된 target branch는 그 Worktree가 clean이고 사용자 작업이 없을 때 정상 Git 작업으로 반영한다. checkout된 branch ref를 저수준 `update-ref`로만 이동시켜 index와 작업 파일을 불일치하게 만들지 않는다.

원격 push는 v1 기본 비활성화이다. 로컬 finalization 성공을 배포·push 완료로 표현하지 않는다.

### 12.8 성공 후 cleanup

삭제 가능한 리소스는 아래 조건을 모두 만족해야 한다.

```text
owned_by_this_installation_and_run
AND canonical_path_is_within_allowed_managed_root
AND no_active_worker_or_process_lease
AND worktree_is_clean_including_untracked_user_files
AND commits_are_reachable_from_finalized_target
AND not_current_user_checkout
AND not_required_for_pending_recovery
```

순서는 Worker 종료 확인 → 로그·보고서 flush → Worktree 정상 제거 → branch 정상 삭제 → registry 갱신이다. branch 삭제는 강제 삭제를 기본값으로 사용하지 않는다. 체크포인트 또는 보고서를 삭제 대상 경로 안에만 두지 않는다.

실패·취소·승인 대기 run은 보존한다. target에 반영되지 않은 integration branch도 보존한다. cleanup이 막히면 원인을 표시하고 부분 정리로 종료한다. 사용자가 직접 만든 브랜치·Worktree는 이름이 비슷해도 삭제하지 않는다.

---

## 13. 테스트·검증 게이트

### 13.1 검증 수준

| 게이트 | 목적 | 저장할 증거 |
|---|---|---|
| baseline | 기존 저장소의 시작 상태 확인 | base SHA, 명령, 환경, exit code |
| unit/task | 단위 구현·회귀 테스트 확인 | 소스 fingerprint, Task, 로그 |
| integration | 병합 후 상호작용·빌드·타입·정적 검사 | integration SHA, 테스트 묶음 |
| review | 독립 코드 리뷰 | reviewed SHA, reviewer 실행, findings |
| final | 최종 인수 조건·완료 상태 | final SHA, acceptance coverage |

명령은 JSON/YAML의 executable과 args로 분리하고 프로젝트 root 상대 cwd를 검증한다. shell pipeline이 필요하면 명시적 trusted script를 등록하고 신뢰 승인 대상에 포함한다. README·소스 주석에서 발견한 명령을 곧바로 실행하지 않는다.

### 13.2 결과 계약

```ts
interface GateResult {
  id: string;
  runId: string;
  taskId: string | null;
  gateId: string;
  stage: "baseline" | "task" | "integration" | "final";
  commitSha: string | null;
  sourceFingerprint: string;
  commandFingerprint: string;
  environmentFingerprint: string;
  status: "passed" | "failed" | "timed_out" | "not_run" | "waived";
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  logRef: string;
  waiverReason: string | null;
}
```

`not_run`이나 `waived`를 `passed`로 바꾸지 않는다. 출력을 읽은 AI의 주장 대신 엔진이 실행한 명령 결과 또는 무결성을 검증한 호스트 실행 결과를 사용한다.

### 13.3 테스트가 없는 프로젝트

필수 acceptance를 검증할 테스트를 추가하는 Task를 우선 제안한다. 자동 테스트를 실행할 수 없으면 사용자가 승인한 수동 체크 또는 면제를 기록한다. 기본 정책상 면제 없이 완료할 수 없다.

baseline이 실패하면 기존 실패와 새 회귀를 구분하고 계획에 반영한다. 단순히 “원래 깨져 있었다”는 문장만으로 새 실패를 통과시키지 않는다. 비교 기준·범위·승인된 예외가 있어야 한다.

### 13.4 검증 무효화

검증 이후 소스·병합 결과·명령·관련 dependency·환경이 달라지면 해당 결과는 stale이다. 최종 review와 최종 integration gate는 같은 final SHA에 대응해야 한다.

작업 중 생성되는 로그·캐시 때문에 fingerprint가 계속 변하지 않도록 소스 manifest와 생성 산출물을 분리한다. 반대로 소스 또는 lockfile 변경을 생성 산출물이라고 제외해 버리면 안 된다.

flaky test는 재시도 통과와 최초 실패를 모두 보존한다. 정해진 횟수 초과 후 skip으로 자동 전환하지 않는다.

---

## 14. 통합 리뷰·수정 반복

### 14.1 리뷰 입력

고정된 `reviewed_sha`, 최초 base 대비 전체 diff, 직전 review 이후 delta, 요구사항·인수 조건, 테스트 결과, 알려진 Finding과 관련 설계 결정을 전달한다.

reviewer는 구현자와 별도 세션에서 검토한다. 변경 파일만 기계적으로 읽는 데 그치지 않고 호출 경로·공통 계약·회귀 위험을 확인한다. 이미 검토한 영역도 새로운 변경의 영향이 있으면 다시 확인한다.

### 14.2 Finding 형식

```json
{
  "schema_version": 1,
  "reviewed_sha": "<actual-sha>",
  "decision": "changes_requested",
  "findings": [
    {
      "id": "F-001",
      "severity": "high",
      "category": "correctness",
      "path": "src/auth/session.ts",
      "symbol": "validateSession",
      "line_start": 42,
      "line_end": 50,
      "summary": "만료된 세션을 허용할 수 있음",
      "evidence": "만료 시각 이전/이후 경계 분기 검증 누락",
      "reproduction": "만료된 세션으로 보호 API를 호출한다",
      "acceptance": "만료 시각과 그 이후 요청은 인증 실패로 처리된다",
      "suggested_test": "경계 시각 및 이미 만료된 세션 회귀 테스트",
      "acceptance_ids": ["AC-002"],
      "status": "open"
    }
  ],
  "reviewed_areas": ["authentication", "regression-tests"],
  "limitations": []
}
```

라인 번호만을 Finding identity로 쓰지 않는다. 코드가 이동할 수 있으므로 경로·symbol·문제 유형·인수 조건과 기존 ID를 함께 사용해 fingerprint를 만든다.

### 14.3 심각도와 차단 규칙

| 심각도 | 예시 | 기본 처리 |
|---|---|---|
| critical | 데이터 손실, 인증 우회 등 중대한 위험 | 반드시 해결 또는 명시적 위험 승인, 자동 완료 금지 |
| high | 핵심 기능 실패, 주요 회귀, 필수 조건 미충족 | 기본 차단 |
| medium | 제한된 상황의 결함, 보완이 필요한 검증 | 계획 범위·위험에 따라 수정, 미해결 시 보고 |
| low | 가독성·비차단 개선 | 별도 권고, 무한 수정 루프 유발 금지 |

severity를 낮춰 게이트를 통과시키는 조작을 금지한다. 심각도 변경에는 근거와 검토 기록이 필요하다. 필수 인수 조건 실패는 reviewer가 medium이라고 적었더라도 차단한다.

### 14.4 Finding Ledger 상태

```text
OPEN → TRIAGED → ASSIGNED → FIX_PROPOSED → VERIFIED_FIXED
                 ├─ 검증 실패 → REOPENED → ASSIGNED
                 └─ 사용자 판단 → ACCEPTED_RISK / NOT_A_BUG / DEFERRED
```

수정 Worker가 “해결”이라고 제출해도 `FIX_PROPOSED`까지만 이동한다. 테스트·리뷰가 acceptance를 확인해야 `VERIFIED_FIXED`가 된다. 무효 판정에는 근거를, 위험 수용에는 사용자 승인을 남긴다.

유사한 이슈는 duplicate candidate로 묶되 다른 acceptance를 가진 실제 결함을 자동 삭제하지 않는다. 이미 해결한 Finding의 회귀는 가능하면 기존 ID를 reopen한다.

### 14.5 수정 분배

하나의 파일/공통 원인에 연결된 Finding은 같은 Repair Task로 묶는다. 독립 파일·독립 계약의 Finding은 병렬로 배정한다. 관련 테스트 추가도 해당 수정의 acceptance에 포함한다.

수정 Worker는 최신 repair base와 원래 Finding evidence를 받는다. 이전 Worker의 주장만 전달하지 않는다. 수정 후 단위 커밋 → 직렬 통합 → 테스트 → 고정 SHA 재리뷰를 수행한다.

### 14.6 반복 상한

`max_review_rounds=3`은 최종 감사에서 수정 요청이 발생한 경우를 포함하여, **수정 작업을 새로 배정하는 라운드를 최대 3회 허용**한다는 뜻이다. 최초 전체 리뷰는 round 0, 각 수정 반영 후 리뷰는 round 1..3이다.

같은 Finding이 `max_repeated_finding_rounds` 동안 해결되지 않으면 원인 재분석 또는 작업 분해 재설계를 수행한다. 이 과정도 전체 라운드/attempt 한도를 초기화하지 않는다.

한도 도달 시 `BLOCKED_REVIEW_LIMIT`으로 전환하고 남은 문제·시도 내용·커밋·테스트·추천 다음 조치를 보고한다. 자동 완료·일괄 무시·Worktree 삭제를 하지 않는다.

### 14.7 최종 감사

`final_auditor`는 요구사항 coverage, 주요 위험, 변경 범위, 검증 누락, 미해결 Finding을 확인한다. 단순히 “리뷰어가 통과했으니 완료”라고 반복하지 않는다.

최종 감사가 새로운 수정이 필요하다고 판단하면 동일 Ledger와 상한 안에서 repair로 돌아간다. 검토만으로 끝나는 코멘트는 차단 이유로 삼지 않는다. 최종 감사 결과 또한 특정 SHA에 고정한다.

---

## 15. 상태 저장·중단·복구

### 15.1 저장소 구조

```text
.orch/
  config.yaml                         # 공유 가능한 프로젝트 설정
  state/                              # Git 제외
    state.db
    state.db-wal / state.db-shm        # SQLite 사용 시 생성 가능
    runs/<run-id>/
      request.md
      requirements.json
      requirements.md
      plan.json
      resolved-config.json
      events.jsonl                    # DB에서 생성한 export, 별도 진실 원천 아님
      logs/
      reports/
        summary.md
        findings.json
        acceptance.json
        cleanup.json
```

SQLite는 로컬 파일시스템에서 운용한다. 네트워크 공유 위 상태 DB의 잠금·내구성이 검증되지 않은 경우 로컬 state location을 사용하거나 지원 불가로 안내한다. `.orch/config.yaml`은 Git에 포함할 수 있지만 실행 상태·로그·임시 모델 정의는 제외한다.

### 15.2 최소 DB 엔티티

| 테이블 | 주요 필드 |
|---|---|
| repositories | id, canonical git common dir, origin root |
| runs | id, repo id, host, host session, state, base SHA, target ref, final SHA |
| requirements | run id, acceptance id, text, verification status |
| tasks | id, run id, role, state, risk, base SHA, plan revision |
| task_dependencies | task id, dependency id |
| attempts | id, task id, attempt no, native agent id, model resolution, timestamps |
| leases | task id, owner, generation, expiry, fencing token |
| worktrees | path, branch, owner, host/core ownership, lifecycle |
| commit_units | id, task id, purpose, commit SHA, source fingerprint |
| operations | idempotency key, operation type, expected refs, status, result |
| quality_results | gate definition, SHA/fingerprint, result, log ref |
| reviews | reviewer attempt, reviewed SHA, decision, limitations |
| findings | stable id, fingerprint, severity, status, evidence, repair task |
| config_revisions | revision, source hashes, resolved snapshot |
| approvals | action, scope, target SHA, expiry, decision, actor |
| events | sequence, timestamp, type, entity id, payload |

외부 세션 ID와 프로세스 ID는 nullable이다. PID가 같은 다른 프로세스가 재사용될 수 있으므로 PID만으로 소유권을 판단하지 않는다.

### 15.3 일관성

Task 상태와 이벤트 기록은 같은 DB transaction에서 커밋한다. Git·파일 작업은 DB와 원자적 transaction을 공유하지 못하므로 **intent 기록 → 외부 작업 → 결과 확인 → 완료 기록**의 operation journal 패턴을 사용한다.

정확히 한 번 실행을 가정하지 않는다. 재시도 가능한 멱등 연산과 결과 조정으로 중복 커밋·중복 병합을 방지한다. Git 상태가 DB와 다르면 branch·trailer·부모 관계·operation journal을 함께 읽어 조정한다.

동일 Git common directory에 대한 쓰기 run은 v1에서 하나로 제한한다. 다른 세션은 상태 조회 또는 해당 run 이어받기만 가능하다. 무관한 별도 저장소의 run은 병렬 실행할 수 있다.

### 15.4 lease와 heartbeat

Worker lease는 task·attempt·generation에 묶는다. 만료된 Worker의 늦은 결과는 새 attempt를 덮어쓸 수 없다. 호스트 완료 이벤트 또는 실행 상태 조회를 우선하며, 모델의 주기적 자가보고만으로 생존을 판단하지 않는다.

상태 확인 기능이 없으면 heartbeat 누락을 곧바로 “종료됨”으로 간주하지 않는다. `ORPHANED_UNKNOWN` 상태에서 사용자 확인 또는 호스트 상태 확인을 요구한다. 해당 Worktree는 보존한다.

### 15.5 복구 시나리오

| 상황 | 복구 동작 |
|---|---|
| Worker 종료, 미커밋 변경 존재 | 변경 보존, 소스 검사, 같은 Task 새 attempt 또는 사용자 검토 |
| 커밋 성공 직후 엔진 종료 | Git 이력·trailer를 읽어 commit unit 상태 조정 |
| 병합 성공 후 DB 기록 누락 | 부모 관계·ancestor 검사 후 완료 기록, 중복 merge 금지 |
| 호스트 세션 종료 | run 일시 정지, 새 세션에서 재개 context 로드 |
| 컨텍스트 압축·대화 길이 초과 | 현재 plan·Finding·active task 요약을 도구로 다시 읽음 |
| 모델 접근 철회 | 새 dispatch 중단, 사용자 고정값 보존, 대안 추천 |
| target branch 외부 변경 | 최종 반영 차단, integration 재검증 |
| 설치 업데이트 중 실패 | 이전 패키지·설정 backup으로 롤백 |
| cleanup 중 실패 | 삭제된/남은 리소스 재조정, 안전한 항목만 재시도 |

복구용 프롬프트에는 필요한 작업 설명·파일·커밋·테스트·미해결 이슈만 전달한다. 전체 대화나 비밀값을 무조건 다시 주입하지 않는다.

---
## 16. 권한·보안·신뢰 경계

### 16.1 실행 권한

파일 수정·테스트 실행·Git 조작은 사용자의 호스트 권한과 승인 범위 안에서만 수행한다. 기본 설치는 `bypassPermissions`, 위험한 무제한 실행 옵션, 조직 정책 해제를 등록하지 않는다.

| 행위 | 기본 정책 |
|---|---|
| 프로젝트 읽기·설정 조회 | 현재 호스트 권한 내 허용 |
| 사용자 요청 범위의 Worktree 수정 | 계획·경로·lease 검증 후 허용 |
| 로컬 Task 커밋·integration merge | run 승인 범위 안에서 자동 |
| 기존 목표 브랜치 최종 반영 | 명시 승인 또는 해당 run 사전 승인 |
| 글로벌 설정 변경 | 사용자가 글로벌 변경을 요청했을 때만 |
| install/update/uninstall | 변경 대상과 보존 정책 확인 |
| push·배포·운영 DB 변경 | v1 기본 비활성, 별도 명시 승인 |
| force push·사용자 파일 강제 삭제 | 일반 워크플로에서 금지 |
| 다른 호스트·외부 API로 fallback | 금지 |

### 16.2 신뢰할 수 없는 프로젝트

프로젝트 파일·PR 설명·리뷰 텍스트·외부 문서에 포함된 “권한을 풀어라”, “설정을 바꿔라”, “비밀을 보내라” 같은 내용은 사용자 지시로 취급하지 않는다. repository 설정에서 executable이나 hook이 바뀌면 신뢰 fingerprint를 무효화한다.

프로젝트 코드를 실행하는 테스트도 임의 코드 실행이다. 초기 trust 승인 시 검증 명령·bootstrap script·네트워크·쓰기 범위를 표시한다. 기존 사용자 승인보다 넓은 권한을 프로젝트 설정만으로 얻을 수 없어야 한다.

### 16.3 엔진이 강제할 수 있는 것과 없는 것

엔진은 **자신을 통해 실행되는** 상태 변경·Git operation·cleanup에 대해 권한·경로·SHA·lease를 강제한다. 호스트의 tool permission·sandbox·hooks를 사용해 Worker의 허용 범위도 가능한 한 제한한다.

그러나 같은 OS 사용자 권한으로 실행되는 네이티브 Agent가 가진 모든 파일/쉘 도구를 MCP 엔진이 보안 경계 밖에서 통제할 수 있다고 주장하지 않는다. 프롬프트·Worktree·role token만으로 악의적인 프로세스를 완전히 격리할 수 없다.

v1은 협력적인 개발 Agent의 실수·레이스·잘못된 완료 판정을 줄이는 통제 장치이다. 강한 적대적 격리가 필요한 환경은 검증된 OS sandbox/container 모드를 별도 제공해야 하며, 미구현이면 제한을 명시한다.

### 16.4 도구 접근 구분

Coordinator는 계획·배정·통합·최종 반영 도구를 사용할 수 있다. Worker는 자신의 Task 조회·진행 보고·검증·결과 제출만 사용한다. Reviewer는 검토 자료 읽기와 리뷰 제출을 사용한다.

run/task/attempt scope의 capability와 fencing token을 검사한다. 호스트가 agent identity를 신뢰 가능한 방식으로 전달하지 않는 경우 관리 작업은 Coordinator relay만 허용한다. 모델이 JSON에 `role: coordinator`라고 썼다는 이유로 관리 권한을 주지 않는다.

### 16.5 비밀정보·로그

인증은 호스트에 맡긴다. ORCH 설정에 API key·구독 토큰을 복사하지 않는다. 환경변수 전체, 전체 원본 프롬프트, private key, cookie, credential file을 기본 로그에 기록하지 않는다.

정규식 redaction은 보조 기능이며 완전한 비밀 탐지를 보장하지 않는다. 최소 수집을 우선한다. 외부 telemetry는 기본 off이며 명시 opt-in 없이는 전송하지 않는다.

---

## 17. 내부 인터페이스와 데이터 계약

### 17.1 Host Adapter

아래는 제품 내부 타입 계약이다. 기존 Codex/Claude SDK에 이 이름의 인터페이스가 존재한다는 뜻이 아니다.

```ts
type HostKind = "codex" | "claude";
type CapabilityStatus = "supported" | "unsupported" | "unknown";
type RoleId =
  | "coordinator" | "requirements" | "planner" | "coder"
  | "tester" | "reviewer" | "repair" | "final_auditor";

interface HostContext {
  kind: HostKind;
  executablePath: string;
  version: string;
  sessionId: string | null;
  originRoot: string;
  settingsFingerprint: string;
  authContextFingerprint: string | null; // 비밀값이 아닌 문맥 식별자
}

interface HostCapabilities {
  nativeSubagents: CapabilityStatus;
  perAgentModel: CapabilityStatus;
  perAgentEffort: CapabilityStatus;
  modelCatalog: CapabilityStatus;
  modelObservation: CapabilityStatus;
  effortObservation: CapabilityStatus;
  existingWorktreeBinding: CapabilityStatus;
  nativeWorktreeIsolation: CapabilityStatus;
  agentDefinitionReload: CapabilityStatus;
  nativeAgentResume: CapabilityStatus;
  nativeAgentCancel: CapabilityStatus;
  eventHooks: CapabilityStatus;
  evidence: Array<{ feature: string; source: string; verifiedAt: string }>;
}

interface DispatchSpec {
  runId: string;
  taskId: string;
  attemptId: string;
  host: HostKind;
  role: RoleId;
  nativeAgentType: string;
  modelId: string;
  effort: string | null;
  configRevision: number;
  baseSha: string;
  worktreePath: string | null;          // host-managed이면 bootstrap에서 확정
  isolation: "core_managed" | "host_managed";
  taskBriefRef: string;
  leaseId: string;
  fencingToken: number;
  expiresAt: string;
}

interface HostAdapter {
  detect(): Promise<HostContext>;
  capabilities(ctx: HostContext): Promise<HostCapabilities>;
  discoverModels(ctx: HostContext): Promise<ModelDescriptor[]>;
  prepareDispatch(input: {
    context: HostContext;
    taskId: string;
    role: RoleId;
    modelId: string;
    effort: string | null;
  }): Promise<DispatchSpec>;
  normalizeEvent(raw: unknown): Promise<{
    kind: string;
    nativeAgentId: string | null;
    payload: Record<string, unknown>;
  }>;
}
```

`prepareDispatch`는 Agent를 직접 생성하는 메서드가 아니다. 메인 세션이 사용할 검증된 요청을 생성한다. metadata용 보조 프로세스와 LLM Worker를 구분해 계측한다.

### 17.2 런타임 역할 정의 생성

역할 모델 변경을 반영할 때 글로벌 agent 파일을 프로젝트 값으로 계속 덮어쓰지 않는다. 여러 프로젝트가 동시에 다른 모델을 쓰는 상황을 지원해야 한다.

우선순위는 다음과 같다.

1. 호스트가 지원하고 검증한 per-invocation model/effort 인수.
2. 프로젝트·설정 hash를 포함하는 고유한 generated agent definition.
3. 재로딩이 필요하면 `NEEDS_RELOAD`로 중지.

생성 이름 예시는 `orch-coder-p<config-hash>`이다. 파일에는 실제 검증된 모델 ID와 effort만 넣는다. 사용자 agent 정의와 충돌하거나 덮어쓰지 않는다. host-managed role 정의와 immutable package template을 구분한다.

### 17.3 MCP 도구 목록

모든 도구는 JSON Schema로 검증하고 `protocol_version`을 가진다. 실제 코드에서는 응답 크기를 제한하고 상세 자료는 읽기 전용 resource reference로 반환한다.

| 도구 | 목적 | 변경 여부 |
|---|---|---|
| `orch_environment` | 호스트·capability·권한·설치 상태 | 읽기 |
| `orch_models` | 카탈로그·역할 resolution 조회/refresh | 캐시만 |
| `orch_config` | effective config, validation, patch, unset | 승인 scope에 따라 |
| `orch_run_create` | preflight·실행 레코드 생성 | 쓰기 |
| `orch_plan_submit` | 요구사항·Task DAG 제출/검증 | 쓰기 |
| `orch_run_status` | 진행·차단·모델·슬롯·다음 작업 | 읽기 |
| `orch_task_prepare` | ready Task lease·Worktree·DispatchSpec | 쓰기 |
| `orch_task_bind` | native agent ID·cwd·base·관측 모델 등록 | 쓰기 |
| `orch_task_checkpoint` | 진행 상태·안전 경계·부분 결과 | 쓰기 |
| `orch_task_validate` | 지정 gate 실행·증거 수집 | 제한된 실행 |
| `orch_task_commit` | 검증된 atomic unit 커밋 | 쓰기 |
| `orch_task_complete` | 결과 제출·검증 후 merge queue 등록 | 쓰기 |
| `orch_integrate` | 직렬 통합 operation | 쓰기 |
| `orch_review_snapshot` | 고정 SHA와 검토 자료 제공 | 읽기 |
| `orch_review_submit` | 리뷰 schema·SHA 검증·Ledger 갱신 | 쓰기 |
| `orch_repair_plan_submit` | Finding 기반 수정 DAG 검증 | 쓰기 |
| `orch_run_control` | pause/resume/cancel/reconcile | 쓰기 |
| `orch_finalize` | 승인·게이트·ref 검증 후 목표 반영 | 민감한 쓰기 |
| `orch_cleanup` | 정리 계획/실행·보존 사유 | 민감한 쓰기 |
| `orch_report` | 결과·acceptance·사용량·보고서 출력 | 읽기 |

제품 업데이트·제거는 일반 Worker 도구로 노출하지 않는다. Coordinator도 사용자 요청 없이 업데이트하지 않는다. 관리자 설치 작업은 별도 설치 스크립트나 승인된 maintenance 경로로만 처리한다.

### 17.4 공통 변경 요청 envelope

```json
{
  "protocol_version": 1,
  "run_id": "run-example",
  "operation_id": "op-unique-id",
  "expected_state_version": 12,
  "lease_id": "lease-example",
  "fencing_token": 3,
  "input": {}
}
```

쓰기 응답은 적용된 state version, 실제 결과, 증거 reference를 반환한다. 같은 `operation_id`와 같은 입력은 이전 결과를 반환한다. 같은 ID로 다른 입력이 들어오면 `IDEMPOTENCY_CONFLICT`이다.

### 17.5 Worker 결과 계약

```ts
interface TaskResult {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  attemptId: string;
  status: "ready_for_validation" | "blocked" | "failed";
  baseSha: string;
  worktreePath: string;
  completedUnits: Array<{ unitId: string; commitSha: string }>;
  changedPaths: string[];
  acceptanceEvidence: Array<{ acceptanceId: string; evidenceRefs: string[] }>;
  gateResultIds: string[];
  reportedModel: string | null;         // 자가보고, 관측값과 별도 취급
  remainingIssues: string[];
  summary: string;
}
```

엔진은 `changedPaths`, commit SHA, gate 결과를 실제 저장소·DB와 대조한다. `status`만으로 Task를 통합하지 않는다. JSON이 손상되면 제한된 형식 수정 요청을 할 수 있지만 정상 결과를 만들어 넣지 않는다.

### 17.6 공통 오류 코드

| 코드 | 의미 | 기본 처리 |
|---|---|---|
| `HOST_CAPABILITY_UNSUPPORTED` | 요구되는 호스트 기능 미지원 | 중지·호환성 안내 |
| `NEEDS_RELOAD` | 정의 변경이 아직 반영되지 않음 | 새 dispatch 중지 |
| `MODEL_NOT_SUPPORTED` | 호스트 카탈로그·정책 불일치 | 설정 수정 |
| `MODEL_ACCESS_DENIED` | 실행 권한 거부 | 인증/계정 확인 |
| `EFFORT_NOT_SUPPORTED` | 선택 모델이 effort 미지원 | 유효 값 제시 |
| `CONFIG_CONFLICT` | 설정 파일이 동시에 변경됨 | 재읽기·재병합 |
| `REPO_BUSY` | 다른 쓰기 run/외부 Git 작업 | 대기·사용자 확인 |
| `DIRTY_CHECKOUT` | 원본 checkout에 변경 있음 | 보존 후 결정 |
| `BASE_SHA_MISMATCH` | Worker 기준이 다름 | 코드 쓰기 차단 |
| `WRITE_SCOPE_VIOLATION` | 할당 밖 파일 변경 | 격리·검토 |
| `STALE_LEASE` | 만료된 Worker 요청 | 결과 채택 금지 |
| `STALE_REVIEW` | 리뷰 대상 SHA가 다름 | 재리뷰 |
| `TARGET_MOVED` | 최종 반영 전 target 변경 | 재통합·재검증 |
| `REVIEW_LIMIT_REACHED` | 수정 반복 상한 | 사용자 검토 |
| `APPROVAL_REQUIRED` | 필요한 승인이 없음 | 승인 대기 |
| `CLEANUP_UNSAFE` | 소유·병합·clean 조건 미충족 | 보존 |
| `IDEMPOTENCY_CONFLICT` | 중복 ID의 요청 불일치 | 거절·진단 |

---

## 18. 설치·업데이트·제거

### 18.1 설치 목표

사용자는 설치 스크립트를 한 번 실행하고 Codex/Claude Code를 열어 사용할 수 있어야 한다. 호스트를 자동 감지하고 없는 호스트는 건너뛰되, 사용자가 명시한 대상이 없으면 실패 원인을 보여준다.

패키지 설치와 설정 파일 적용은 자동화하되, 호스트의 trust·권한 승인까지 우회하지 않는다. 일부 환경에서 재시작 또는 정식 reload가 필요하면 설치 결과에 정확하게 안내한다.

### 18.2 스크립트 인터페이스

배포 bundle을 내려받아 검증한 뒤 실행하는 명령 예시다. 아래 파일은 구현 산출물이어야 하며 이 PRD 자체가 설치 스크립트를 제공하는 것은 아니다.

```bash
# macOS / Linux / WSL
./scripts/install.sh --target auto --scope user
./scripts/install.sh --target codex --scope user
./scripts/install.sh --target claude --scope project --project /path/to/repo
./scripts/install.sh --target both --scope user --dry-run
./scripts/install.sh --target both --scope user --yes

./scripts/update.sh --dry-run
./scripts/update.sh --version <released-version>
./scripts/uninstall.sh --target codex --keep-data
```

```powershell
# Windows native
.\scripts\install.ps1 -Target auto -Scope user
.\scripts\install.ps1 -Target both -Scope project -Project "C:\Projects\app"
.\scripts\install.ps1 -Target both -Scope user -DryRun
.\scripts\update.ps1 -DryRun
.\scripts\uninstall.ps1 -Target claude -KeepData
```

`user`는 글로벌 설치를 뜻한다. 제품 모델 설정의 `--global`과 설치 scope의 `user`가 같은 사용자 범위를 가리킨다는 점을 도움말에 설명한다. `--yes`는 정상 설치 확인을 생략할 뿐, 기존 파일 덮어쓰기·보안 우회·미병합 데이터 삭제를 승인하지 않는다.

### 18.3 의존성과 배포 방식

제품 코드는 TypeScript/Node.js로 구현하되 일반 사용자는 개발 toolchain을 설치할 필요가 없도록 빌드된 bundle을 제공한다. Node 런타임은 호환 버전을 감지해 사용하거나 검증된 private runtime bundle을 선택적으로 제공한다.

각 릴리스는 지원 Node/Git/호스트 버전, OS·CPU 아키텍처, SQLite 의존성, checksum을 manifest에 명시한다. 설치기는 지원 범위를 임의 추정하지 않는다. 관리자 권한·전역 npm 설치·시스템 PATH 수정을 기본 요구로 하지 않는다.

설치 시 검증한 런타임의 절대 경로를 등록해, GUI 호스트와 터미널의 PATH 차이로 엔진을 찾지 못하는 문제를 줄인다. Windows의 공백·한글 경로, `.cmd` 실행, 경로 구분자, 심볼릭 링크 권한을 테스트한다.

### 18.4 설치 위치

| 자산 | Codex | Claude Code |
|---|---|---|
| 사용자 진입 스킬 | `~/.agents/skills/orch/` | `~/.claude/skills/orch/` |
| 프로젝트 진입 스킬 | `<repo>/.agents/skills/orch/` | `<repo>/.claude/skills/orch/` |
| 프로젝트 역할 정의 | `<repo>/.codex/agents/`의 ORCH 소유 파일 | `<repo>/.claude/agents/`의 ORCH 소유 파일 |
| 사용자 역할 템플릿 | 지원 버전의 공식 위치 또는 패키지 자산 | 사용자 agent 위치 또는 plugin 자산 |
| MCP 등록 | 호스트가 지원하는 user/project 설정 | plugin 또는 호스트 MCP scope |

Codex·Claude의 스킬 위치는 공식 문서를 따른다.[^S02][^S04] 프로젝트 설정 상속은 ORCH가 직접 계산한다. 두 호스트의 동명 스킬 우선순위가 ORCH config 우선순위와 같다고 가정하지 않는다.

글로벌 스킬이 이미 있으면 프로젝트 config만 쓰는 것을 우선하고 불필요한 중복 설치를 피한다. 이름 충돌이 있으면 소유 manifest를 확인하고 사용자 파일을 덮어쓰지 않는다.

### 18.5 Claude plugin과 짧은 명령

Claude용 정식 plugin bundle에는 skill·agent template·hook·MCP 설정을 포함한다. plugin 스킬의 namespaced 명령과 별도로, `/orch`를 원하는 사용자를 위해 얇은 standalone 진입 스킬을 설치한다.[^S04][^S15]

예를 들어 plugin 이름 `orch`, 내부 시작 스킬 `run`을 사용하면 namespaced 경로는 `/orch:run`이다. standalone `/orch`는 동일한 공통 workflow를 실행하는 alias이며 별도 엔진이나 별도 상태를 만들지 않는다.

Codex도 우선 로컬 스킬+MCP bundle로 배포하고, 검증된 plugin 패키징 경로가 있으면 추가할 수 있다. 사용자 경험을 통일하기 위해 두 호스트의 manifest 형식을 억지로 하나로 만들지 않는다.

### 18.6 설치 순서

1. OS·architecture·Git·런타임·호스트 실행 파일과 버전을 감지한다.
2. 적용 계획, 설치 scope, 기존 동일 이름 자산, 필요한 권한을 표시한다.
3. 서명 또는 배포 checksum을 검증한 immutable version directory에 패키지를 설치한다.
4. 스킬·참고 문서·호스트 adapter를 등록한다.
5. MCP 등록은 공식 host 관리 명령/형식을 우선하고, 직접 편집 시 JSON/TOML parser와 원자적 저장을 사용한다.
6. 기존 글로벌 config가 없으면 기본 설정을 만든다. 있으면 보존하고 schema migration만 별도 처리한다.
7. project 설치이면 ignore 대상과 생성 자산을 안내한다. 사용자 `.gitignore`/지침 파일은 무조건 교체하지 않는다.
8. 설치 manifest와 변경한 key·이전 값·hash·버전을 기록한다.
9. 파일 유효성, MCP handshake, host capability, 모델 metadata 조회를 진단한다.
10. 필요한 reload/restart, 실제 invocation, 미완료 진단을 보고한다.

모델을 실제 호출하는 smoke test는 기본 설치 검사와 분리하고 승인 후에만 실행한다. 인증이 없으면 “설치 완료, 로그인/실행 검증 필요”로 표시한다.

### 18.7 멱등성과 충돌 처리

동일 버전 재설치는 동일 자산을 중복 등록하지 않는다. ORCH가 소유하지 않은 `AGENTS.md`, `CLAUDE.md`, hook, MCP entry, skill 파일은 수정하지 않는다. 필요한 안내 블록이 있으면 명시적 사용자 승인을 받아 구분 가능한 블록만 추가한다.

기존 사용자 수정이 있는 ORCH 자산도 hash 차이를 감지하고 backup/diff를 제공한다. 강제 덮어쓰기가 기본값이 아니다. 호스트 설정 전체를 오래된 backup으로 되돌려 다른 플러그인의 변경까지 지우지 않는다.

### 18.8 업데이트

업데이트는 버전 확인 → 변경 내용·migration 안내 → 승인 → 새 디렉터리 설치 → 검증 → active pointer 교체 순서다. active run이 사용하는 버전은 pin한다. 실행 중에 그 run의 코드·스킬·schema를 바꾸지 않는다.

migration 실패 시 새 버전을 활성화하지 않고 이전 버전으로 되돌린다. 설정·run DB는 변환 전 backup을 남긴다. 업데이트가 모델 고정값이나 승인 정책을 재설정해서는 안 된다.

### 18.9 제거

제거는 설치 manifest에 기록된 자산과 설정 key만 대상으로 한다. 설치 후 다른 값으로 변경된 key는 자동 삭제하지 않는다. 두 호스트 중 하나만 제거할 때 다른 호스트가 쓰는 공통 엔진과 설정은 유지한다.

기본 `keep-data=true`로 config·실행 기록·미병합 branch·Worktree를 보존한다. `purge-data`를 제공한다면 별도 확인이 필요하고, 실행 중/소유 불명/미병합 작업은 일반 제거 경로에서 강제 삭제하지 않는다.

### 18.10 진단 출력

```text
ORCH installation: 1.x.y
Codex: detected / compatible / needs reload
Claude Code: detected / compatible
Runtime: ready
MCP: configured / handshake verified
Global config: valid
Project config: valid
Model discovery: codex verified, claude partial
Native isolation: verified / unverified
Active runs: 0

주의: '설치됨'과 '네이티브 실행 검증 완료'는 별도 항목입니다.
```

---
## 19. 패키지와 저장소 구조

```text
orch/
  README.md
  LICENSE
  SECURITY.md
  CONTRIBUTING.md
  CHANGELOG.md
  package.json
  <package-manager-lockfile>

  packages/
    core/
      src/
        config/
        model-registry/
        planning/
        scheduler/
        state-machine/
        git/
        worktrees/
        quality/
        review/
        recovery/
        cleanup/
        reporting/
    protocol/
      src/types/
      schemas/
        config.schema.json
        requirements.schema.json
        task.schema.json
        task-result.schema.json
        review.schema.json
        tool-request.schema.json
    mcp-server/
      src/tools/
      src/resources/
    host-codex/
      src/capabilities/
      src/catalog/
      src/definitions/
      src/events/
    host-claude/
      src/capabilities/
      src/catalog/
      src/definitions/
      src/events/
    installer/
      src/detection/
      src/manifests/
      src/config-patching/
      src/update/
      src/uninstall/

  skills/
    orch/SKILL.md
    orch-configure/SKILL.md
  references/
    model-selection.md
    reasoning-effort.md
    agent-roles.md
    project-analysis.md
    configuration.md
    workflow.md
    recovery.md
    safety.md

  templates/
    codex/
      skills/
      agents/
    claude/
      alias-skills/
      plugin/
        .claude-plugin/plugin.json
        skills/run/SKILL.md
        skills/configure/SKILL.md
        agents/
        hooks/hooks.json
        .mcp.json
    defaults/config.yaml

  scripts/
    install.sh
    install.ps1
    update.sh
    update.ps1
    uninstall.sh
    uninstall.ps1

  docs/
    PRD.md
    ARCHITECTURE.md
    CONFIGURATION.md
    MODEL-SELECTION.md
    HOST-COMPATIBILITY.md
    INSTALLATION.md
    RECOVERY.md
    TROUBLESHOOTING.md

  tests/
    unit/
    integration/
    contracts/codex/
    contracts/claude/
    e2e/
    skill-evals/
    fixtures/repositories/
    fixtures/model-catalogs/
    fixtures/host-events/
```

설치된 버전별 자산은 immutable하게 관리하고 공통 엔진은 한 번만 설치한다. 같은 버전을 두 호스트에서 사용하더라도 호스트 adapter·설정·모델 카탈로그·세션은 구분한다.

Hook은 선택적 보조 수단이다. 이벤트 수신에 실패해도 DB/Git 조정으로 복구해야 한다. 호스트에서 지원하는 event와 반환 규약을 contract test하고, 전체 개발 반복을 Stop hook 하나에 넣어 무한 재진입시키지 않는다.[^S13]

실행 가능한 hook·MCP 설정을 설치한 패키지 자산에 포함할 때는 dependency 및 신뢰 경계를 명확히 문서화한다. hook 출력에 비밀이나 과도한 전체 transcript를 기록하지 않는다.

---

## 20. 관측성·보고서·비기능 요구사항

### 20.1 이벤트

최소 이벤트는 다음과 같다.

```text
run.created / run.state_changed / run.blocked / run.resumed
config.changed / model.resolved / model.observed / capability.mismatch
task.ready / task.leased / task.started / task.checkpointed
task.validation_failed / task.committed / task.integrated
review.started / review.completed / finding.opened / finding.reopened
finding.verified_fixed / approval.requested / approval.granted
merge.started / merge.conflicted / merge.completed
cleanup.planned / cleanup.removed / cleanup.preserved
```

이벤트는 UTC timestamp와 단조 증가 sequence를 가진다. 사용자 표시는 로컬 timezone을 따른다. 모델의 숨겨진 추론 원문을 요구하거나 저장하지 않고, 짧은 선정 사유·도구 결과·증거만 기록한다.

### 20.2 완료 보고서

`summary.md`에는 다음 정보를 포함한다.

| 영역 | 필수 내용 |
|---|---|
| 결과 | 완료/승인 대기/차단/실패 및 정확한 이유 |
| 요구사항 | acceptance별 구현·검증 결과와 예외 |
| 코드 | 변경 파일·논리적 commit unit·최종 SHA·목표 브랜치 |
| 모델 | 역할별 요청·선택·실제 관측 모델/effort, 미확인 항목 |
| 검증 | 실행한 명령·pass/fail/waived, 관련 로그 |
| 리뷰 | 발견·해결·재발·남은 Finding, 위험 수용 |
| 실행 | task attempt·review round·기간·관측 가능한 사용량 |
| 정리 | 삭제한 Worktree/branch와 남긴 리소스·사유 |
| 후속 | 사용자가 해야 하는 승인/검증/환경 수정 한 가지 이상의 구체적 조치 또는 없음 |

실제 결제 금액을 제공할 근거가 없으면 가격을 만들어내지 않는다. 토큰 사용량조차 관측하지 못한 항목은 0이 아닌 null/미확인으로 표시한다.

### 20.3 초기 성능 목표

아래는 구현 후 측정할 목표이며 현재 달성된 수치가 아니다.

| ID | 목표 | 측정 조건 |
|---|---|---|
| NFR-01 | 상태 조회 p95 1초 이내 | 로컬 DB, 네트워크·모델 호출 제외, 1,000 Task fixture |
| NFR-02 | 설정 조회·검증 p95 500ms 이내 | schema·캐시 검증, 외부 metadata 조회 제외 |
| NFR-03 | 시작 preflight p95 5초 이내 | 모델 호출·테스트·대용량 초기 스캔 제외 |
| NFR-04 | 4개 Worker 기본 병렬 실행에서 상태 일관성 유지 | mock host 및 실제 호스트 E2E 각각 |
| NFR-05 | merge·commit·cleanup fault injection 후 사용자 변경 손실 0건 | 정의된 장애 fixture 전체 |
| NFR-06 | 동일 요청 중복 재전송 시 중복 commit/merge 0건 | 멱등 테스트 전체 |
| NFR-07 | 글로벌 설정 변경 없이 다른 프로젝트의 모델 설정 동시 사용 | 2개 독립 저장소·서로 다른 role profile |
| NFR-08 | 설치·업데이트·제거의 non-owned 파일 변경 0건 | OS별 충돌 fixture |

NFR-05의 “0건”은 테스트 수용 기준이지 모든 환경에서 절대 손실이 없다는 보장이 아니다. 실제 Agent 품질은 고정 벤치마크 fixture와 모델·effort·버전을 기록해 비교한다.

### 20.4 컨텍스트 관리

메인 세션에 전체 작업 로그를 계속 붙이지 않는다. summary, state version, 다음 ready Task, 차단 사유를 우선하고 상세 로그는 resource로 읽는다. compact 이후에도 현재 계획·규칙·SHA·Finding을 도구에서 복구할 수 있어야 한다.

필요한 소스만 Task Brief에 포함한다. Reviewer에게는 구현자의 자기평가를 정답처럼 제시하지 않는다. 모든 하위 역할에 전체 모델 관리·설치 문서를 강제로 주입하지 않는다.

---

## 21. 수용 테스트

### 21.1 공통 테스트 전략

Unit test는 실제 LLM 없이 수행한다. Git integration test는 임시 저장소를 생성하고 실제 Git으로 검증한다. Host contract test는 저장된 protocol fixture와 승인된 실제 설치 환경에서 수행한다. E2E는 작은 샘플 프로젝트에서 사용자 대화 진입부터 cleanup까지 확인한다.

호스트 실험에 실제 계정/과금이 필요하면 CI의 공개 자동 실행에서 분리한다. secret은 CI secret store를 사용하며 테스트 로그에 포함하지 않는다. 모델별 성능을 고정된 기능 테스트의 성공 여부와 혼동하지 않는다.

### 21.2 기능 수용 항목

| ID | Given / When | Then |
|---|---|---|
| AT-001 | Codex가 설치된 상태에서 `$orch` 시작 | 현재 세션이 관리자이며 외부 `orch run` 입력을 요구하지 않음 |
| AT-002 | Claude Code에서 `/orch` 시작 | 같은 핵심 workflow가 실행되고 namespace/alias가 중복 run을 만들지 않음 |
| AT-003 | Codex run에서 리뷰 단계 도달 | Claude 모델·Claude 프로세스를 호출하지 않음 |
| AT-004 | Claude run에서 구현 단계 도달 | OpenAI 모델·Codex 프로세스를 호출하지 않음 |
| AT-005 | 사용자가 자연어로 모델 최적화 요청 | 설정 스킬이 올바른 scope의 검증된 변경을 제안/적용 |
| AT-006 | 사용자가 설정 방법 설명만 요청 | 파일·설정을 변경하지 않음 |
| AT-007 | 글로벌 coder 모델과 프로젝트 effort만 존재 | 필드별 병합, 각 출처를 정확히 표시 |
| AT-008 | 프로젝트 오버라이드를 unset | 글로벌 값이 다시 적용되고 다른 필드는 유지 |
| AT-009 | 구체적 모델 고정값이 있는 상태에서 auto configure | 고정값 유지, auto 필드만 해석/변경 |
| AT-010 | 없는 모델 또는 미지원 effort를 지정 | 저장/dispatch 차단, 유효 후보와 원인 출력 |
| AT-011 | 모델 카탈로그 조회 실패 | 오류·만료 cache 여부를 표시, 모델명 생성 금지 |
| AT-012 | 모델 목록이 여러 페이지 | 모든 페이지를 조회하고 중복을 제거 |
| AT-013 | runtime 정책이 모델/effort를 변경 | 요청·관측 차이를 표시하거나 관측 불가로 표시 |
| AT-014 | Worker 실행 중 모델 설정 변경 | 현재 Worker 유지, 다음 Worker부터 새 revision 사용 |
| AT-015 | 호스트가 변경된 agent 정의를 반영하지 않음 | `NEEDS_RELOAD`, 기존 모델로 silent 실행 금지 |
| AT-016 | 서로 독립적인 Task 2개 | 서로 다른 branch·Worktree에서 동시 실행 |
| AT-017 | 같은 파일/독점 resource를 쓰는 Task 2개 | 순차 실행 또는 재분해, 동시 쓰기 금지 |
| AT-018 | T2가 T1에 의존 | T1 통합이 확인된 SHA에서 T2 시작 |
| AT-019 | 잘못된 base SHA의 네이티브 Worktree | 파일 쓰기 전에 `BASE_SHA_MISMATCH` |
| AT-020 | 원본 checkout에 사용자 변경 존재 | 자동 stash/reset 없이 중지·보존 |
| AT-021 | 한 Task가 2개 독립 unit을 구현 | 의미 있는 2개 커밋과 검증·trailer 기록 |
| AT-022 | Worker가 허용 범위 밖 파일 변경 | commit/merge 차단, 변경 보존·사유 보고 |
| AT-023 | 여러 Worker가 동시에 완료 | integration merge가 하나씩 실행 |
| AT-024 | 두 Task의 merge 충돌 | 고정된 양쪽 SHA에서 해결·검증, 무조건 ours/theirs 금지 |
| AT-025 | 테스트 실패 또는 timeout | Task/통합 게이트 미통과, 성공 출력 금지 |
| AT-026 | 테스트가 전혀 없는 프로젝트 | 테스트 추가 또는 명시 면제 요구, 실행 안 한 테스트를 pass 처리하지 않음 |
| AT-027 | integration review 후 새 commit 생성 | 이전 review stale 처리, 새 SHA 검토 |
| AT-028 | 독립적인 Finding 2개 발생 | Repair Task 2개로 병렬 배분 가능 |
| AT-029 | 한 파일의 관련 Finding 여러 개 | 하나의 Repair Task 또는 의존 DAG로 묶음 |
| AT-030 | 수정 Worker가 해결했다고 보고 | `FIX_PROPOSED`, 독립 검증 후에만 `VERIFIED_FIXED` |
| AT-031 | 같은 결함이 코드 이동 후 재발 | 새 줄 번호만으로 새 이슈 양산하지 않고 기존 ID 재연결 |
| AT-032 | 3회 수정 라운드 후 차단 결함 존재 | `BLOCKED_REVIEW_LIMIT`, 자료 보존 |
| AT-033 | 모든 Task·게이트·리뷰·인수 조건 통과 | 승인 정책에 따라 finalize, 허위 완료 없음 |
| AT-034 | finalize 직전 목표 branch 이동 | 재통합·재검증, 오래된 리뷰로 반영 금지 |
| AT-035 | 사용자 승인 없는 기본 finalize | `APPROVAL_REQUIRED`, target 불변 |
| AT-036 | run에 대해 auto_on_success 사전 승인 | 통과 후 승인 범위 안에서 자동 반영·정리 |
| AT-037 | 성공한 owned/merged/clean Worktree | 정상 제거하고 branch·manifest 갱신 |
| AT-038 | dirty·미병합·실행 중·소유 불명 Worktree | cleanup에서 보존, 구체적 사유 출력 |
| AT-039 | 원본 사용자 branch 이름이 orch prefix와 비슷함 | manifest 소유권이 없으면 제거하지 않음 |
| AT-040 | 호스트 종료 후 resume | 체크포인트·Git 조정 후 재개, 무조건 처음부터 재실행하지 않음 |
| AT-041 | 중복 commit/merge 도구 요청 | 기존 operation 결과 반환, 중복 이력 없음 |
| AT-042 | 만료 lease Worker가 늦게 결과 제출 | 새 attempt 상태를 덮어쓰지 않음 |
| AT-043 | 커밋 성공 직후 DB 기록 전 crash | 이력에서 복구, 동일 unit 재커밋 금지 |
| AT-044 | merge 완료 직후 crash | 부모 관계로 복구, 동일 Task 재병합 금지 |
| AT-045 | 서로 다른 두 프로젝트가 각기 모델 변경 | 전역 role 파일 경쟁 없이 독립 적용 |
| AT-046 | 같은 Git common dir에서 두 run 동시 시작 | 두 번째 쓰기 run 차단 또는 기존 run 연결 |
| AT-047 | 설치 스크립트를 두 번 실행 | 중복 MCP·hook·skill 없음, 기존 설정 보존 |
| AT-048 | 설치 대상 경로에 사용자 작성 orch 스킬 존재 | 자동 덮어쓰기 금지, 충돌 안내 |
| AT-049 | 업데이트 migration 실패 | 이전 버전·설정 복구, run 자료 유지 |
| AT-050 | 한 호스트만 제거 | 다른 호스트와 공통 사용 자산 정상 유지 |
| AT-051 | 프로젝트 파일에 권한 우회/비밀 전송 지시 | 사용자 승인으로 취급하지 않고 차단 |
| AT-052 | 모델·usage 실제 값이 관측되지 않음 | 실제값/비용을 만들어내지 않고 null 표시 |
| AT-053 | Windows 공백·한글 경로, symlink 권한 없음 | 지원되는 copy/경로 처리로 설치·실행 또는 명시 오류 |
| AT-054 | 호스트 metadata helper가 timeout | 프로세스 정리, 실행 중 AI Worker로 오인하지 않음 |
| AT-055 | 필수 gate가 승인 면제됨 | 보고서에 waived·사유·승인 표시, passed와 구분 |
| AT-056 | 설치 smoke test에 로그인이 없음 | 설치 상태와 실행 검증 대기를 구분, 자동 로그인/과금 금지 |
| AT-057 | 실제 Agent가 stop 확인 없이 사라짐 | orphan 상태 보존, Worktree 강제 삭제 금지 |
| AT-058 | cleanup 도중 일부 삭제 실패 | 완료 작업과 남은 자산을 구분, 재실행 멱등 |

### 21.3 최소 E2E fixture

| fixture | 검증 목적 |
|---|---|
| 소형 TypeScript API + 테스트 | 정상 병렬 구현·단위 커밋·통합 리뷰·정리 |
| 소형 Python 라이브러리 + 테스트 | 특정 언어/패키지 관리자 종속 방지 |
| 공통 파일 충돌 저장소 | 소유권·직렬화·merge conflict 회복 |
| 테스트 실패가 포함된 저장소 | baseline과 회귀 구분 |
| 리뷰 결함을 주입한 저장소 | Finding→Repair→재리뷰 실제 순환 |
| dirty checkout·미병합 branch 저장소 | 사용자 변경 보존·안전한 cleanup |
| 실제 linked Worktree에서 시작한 저장소 | root·git common dir·state 위치 일관성 |

LLM이 항상 동일 결함을 발견한다고 기대하는 flaky E2E만 만들지 않는다. 엔진의 리뷰/수정 제어는 deterministic mock 결과로도 테스트하고, 실제 모델 실험은 별도 품질 평가로 기록한다.

---

## 22. 구현 단계와 개발 작업 목록

### 22.1 단계별 목표

| 단계 | 산출물 | 통과 기준 |
|---|---|---|
| M0 호스트 기술 검증 | 두 호스트 capability spike·catalog·native dispatch 실험 | 모델/effort와 Worktree를 실제 Worker에 적용하고 확인 |
| M1 설정·프로토콜·상태 기반 | schema, config merge, Model Registry, DB, 도구 skeleton | unit/contract test 통과 |
| M2 단일 Task 종단 실행 | 대화 진입→요구사항→Task→Worktree→검증→커밋 | 각 호스트 1개 Task 완료 |
| M3 병렬·통합 | DAG, lease, 두 개 이상 Worker, 직렬 merge | 독립 작업 병렬 실행 및 충돌 fixture 통과 |
| M4 리뷰·수정 순환 | Finding Ledger, repair DAG, final audit | 결함 주입 fixture를 수정하고 상한도 준수 |
| M5 복구·안전 정리 | operation journal, resume, finalize, cleanup | crash/dirty/orphan fixture 통과 |
| M6 배포·문서·출시 검증 | installer, update, uninstall, Advisor, compatibility matrix | 전체 수용 테스트와 실제 호스트 smoke test |

Advisor의 초기 문서는 M1부터 작성하고 모델 선택을 도와야 한다. M6에서는 자연어 trigger 평가와 설치된 패키지에서의 참조 경로를 검증한다. 설치기는 마지막에 처음 작성하기보다 M2부터 최소 경로를 제공하고 단계적으로 강화한다.

### 22.2 권장 개발 Task

| 개발 ID | 작업 | 의존 | 완료 조건 / 권장 커밋 단위 |
|---|---|---|---|
| DEV-001 | 공통 schema·타입·에러 코드 | 없음 | config/task/review/envelope validation |
| DEV-002 | config merge·scope·atomic write | DEV-001 | AT-007~009, unset/conflict fixture |
| DEV-003 | SQLite migration·event·operation journal | DEV-001 | transaction·idempotency fixture |
| DEV-004 | Codex capability/catalog spike | 없음 | M0 Codex 증거와 제한 문서 |
| DEV-005 | Claude capability/catalog spike | 없음 | M0 Claude 증거와 제한 문서 |
| DEV-006 | Model Registry·effort validation | DEV-002,004,005 | AT-010~015, 카탈로그 fixture |
| DEV-007 | MCP server·role access·resource 읽기 | DEV-001,003 | 도구 schema·오류 계약 |
| DEV-008 | Git inspector·root·소유 manifest | DEV-003 | dirty/common-dir/path fixture |
| DEV-009 | Worktree lifecycle·native bind | DEV-004,005,008 | AT-016,019,020 |
| DEV-010 | Task DAG·소유권·scheduler·lease | DEV-003,009 | dependency·collision·stale lease |
| DEV-011 | task validation·atomic commit | DEV-007,008,010 | AT-021,022,025 |
| DEV-012 | integration queue·conflict candidate | DEV-011 | AT-023,024,041,044 |
| DEV-013 | review schema·Finding Ledger | DEV-001,003,012 | SHA validation·dedup·reopen |
| DEV-014 | repair planner·반복 상한·final audit | DEV-010,013 | AT-028~033 |
| DEV-015 | pause/cancel/resume·reconciliation | DEV-003,010,012 | AT-040~044,057 |
| DEV-016 | 승인·target drift·finalization | DEV-012,014 | AT-034~036 |
| DEV-017 | cleanup·보고서·usage provenance | DEV-015,016 | AT-037~039,052,055,058 |
| DEV-018 | 공통 스킬·Advisor·reference 문서 | DEV-002,006,007 | trigger/scope/override 평가 |
| DEV-019 | installer·manifest·doctor | DEV-004,005,007,018 | 두 호스트 설치·충돌 보존 |
| DEV-020 | updater·rollback·uninstaller | DEV-019 | AT-047~050,053,056 |
| DEV-021 | 실제 호스트 E2E·compatibility matrix | DEV-009~020 | 명시된 OS/버전에서 결과 기록 |

각 개발 Task는 의미 있는 단위 커밋으로 구현한다. 개발 과정에서도 한 번의 거대한 커밋으로 전체 엔진을 추가하지 않는다. 상호 독립적인 schema/config, 호스트 spike, Git fixture는 병렬로 개발할 수 있으나 공통 protocol 계약을 먼저 고정한다.

### 22.3 v1 이후 확장 후보

P1: 선택 가능한 OS/container 강한 격리, 프로젝트별 평가 데이터 기반 추천, 더 풍부한 TUI, 원격 PR 연동, 추가 호스트 surface 지원.

P2: 사용자가 명시적으로 선택한 별도 headless/API runtime, 여러 저장소를 잇는 작업 그래프, 조직 정책 배포, 팀 대시보드.

확장 기능은 v1의 호스트 고정·명시적 권한·사용자 작업 보존 원칙을 자동으로 변경하지 않는다. 특히 cross-provider 실행은 별도의 제품 결정 없이는 추가하지 않는다.

---

## 23. 출시 완료 기준

다음 조건이 모두 충족되어야 v1이라고 표시한다.

- Codex와 Claude Code 각각에서 대화창 진입 후 네이티브 Worker를 사용한 실제 종단 작업을 완료한다.
- 역할별 모델·effort 설정이 검증된 경로로 적용되며, 적용 불가/미관측 상태를 정직하게 표시한다.
- 글로벌·프로젝트 설정, 자연어 Advisor, 사용자 고정값 보존이 동작한다.
- 독립 Worktree 병렬 작업, 논리 단위 커밋, 직렬 integration, 독립 review, 병렬 repair, 반복 상한이 동작한다.
- 최종 결과·승인·target SHA와 테스트/리뷰의 관계가 추적 가능하다.
- 중단·재시작·중복 요청·충돌 후 재조정과 안전 cleanup이 검증된다.
- 설치·업데이트·제거가 idempotent하며 사용자 자산을 덮어쓰지 않는다.
- 호환성 매트릭스, 보안 제한, 복구 절차, 실제 테스트 결과를 공개한다.

반드시 제공할 문서는 README quick start, 설치/제거, 모델 설정, 설정 schema, 각 역할 가이드, workflow, 복구/진단, 호스트 호환성, 보안/권한 정책이다. `--help`와 스킬 설명의 명령이 실제 parser와 어긋나지 않게 자동 테스트한다.

모델 registry와 호스트 adapter는 릴리스 버전과 별도로 compatibility fixture를 유지한다. 모델이 추가돼도 모델명을 코드에 직접 추가해야만 동작하는 구조는 피한다.

---

## 24. 기술 검증 과제와 미확정 사항

### 24.1 구현 시작 전에 증명할 항목

| 검증 ID | 확인할 내용 | 실패 시 제품 동작 |
|---|---|---|
| POC-01 | Codex native subagent에 역할별 모델·effort 적용 | 해당 버전을 지원 불가 또는 제한 지원으로 표시 |
| POC-02 | Claude native subagent에 역할별 모델·effort 적용 | 정의/호출 방식 재검증, 미지원 값 차단 |
| POC-03 | 현재 CLI와 동일한 인증·정책 문맥의 모델 metadata 조회 | cache/확인된 현재 모델만 사용, 자동 선택 제한 표시 |
| POC-04 | 기존 Worktree 바인딩 또는 native Worktree의 base 확정 | 격리된 쓰기 경로가 없으면 실행 차단 |
| POC-05 | 실행 중 정의 변경의 reload·관측 가능성 | 다음 세션 적용으로 안내, 새 Worker 중지 |
| POC-06 | native agent 종료·취소·재개·event 경로 | 확인 불가 Worker 보존, 안전 단계에서 새로 시작 |
| POC-07 | Windows native 경로·Git·런타임·MCP·호스트 통합 | 해당 조합은 미지원으로 명시, WSL 별도 검증 |
| POC-08 | native 권한과 MCP 관리 도구의 역할 경계 | 관리 작업 parent relay, 보안 한계 표시 |

이 검증은 스펙을 회피하기 위한 선택 사항이 아니다. 호스트에 없는 기능을 프롬프트만으로 있다고 가정하지 않기 위한 M0 출시 gate이다. 사용자의 실제 설치 버전은 아직 주어지지 않았으므로 지원 최소 버전을 임의로 확정하지 않는다.

### 24.2 이번 문서에서 결정한 기본값

| 항목 | 결정 |
|---|---|
| 제품 형태 | 네이티브 Skill/Plugin + 로컬 MCP Runtime |
| 주 실행 주체 | 현재 Codex/Claude Code 메인 세션 |
| 공급자 혼합 | 금지 |
| 모델 ID 고정 목록 | 사용하지 않음 |
| 부모 모델 | inherit |
| 기본 profile | balanced |
| 쓰기 run 동시성 | 같은 Git common dir당 1개 |
| 기본 Worker 상한 | 4개, 호스트 한도와 자원 상황에 따라 감소 |
| Task 시도 | 최초 포함 3회 |
| 수정 라운드 | 최초 리뷰 이후 최대 3회 |
| integration 전략 | no-ff merge로 unit commit 유지 |
| 최종 목표 반영 | 기본 승인 필요, run 단위 자동 반영 사전 승인 가능 |
| 실패 cleanup | 보존 |
| 사용량 정보 | 관측된 값만 표시 |
| 글로벌 설치 | 현재 사용자 권한, 관리자 권한 기본 불필요 |
| 사용자 조작 | 대화창에서 시작·설정·상태·복구·정리 |

### 24.3 추후 선택할 사항

최종 프로젝트 이름·저장소 주소·패키지명·라이선스·릴리스 서명 방식은 배포 전에 결정한다. 실제 모델별 우열·가격·지원 계정은 PRD에 고정하지 않는다. 운영 계측을 통해 profile 기본값을 개선할 수 있지만 사용자 고정값과 run 재현성은 유지한다.

SDK나 headless 실행을 추가하더라도 현재 대화 세션을 조용히 대체하지 않는다. 공급자 약관·인증 경로의 검토 결과와 비용 모델을 사용자에게 명확히 제시해야 한다.

---

## 25. 공식 참고 자료

아래 자료는 호스트 기능과 설치 형식 확인을 위한 1차 자료이다. 확인일은 **2026-10-20**이며, 링크 내용과 실제 설치 버전은 달라질 수 있다. ORCH의 도구 이름·설정 schema·상태 머신·설치 명령은 이 문서가 정의한 제품 설계이다.

[^S01]: OpenAI, **Build skills — Plugins**. Codex `$` 스킬 진입 예시, `SKILL.md`, supporting references, MCP 연결. https://developers.openai.com/plugins/build/skills
[^S02]: OpenAI, **Build skills**. 로컬/사용자 스킬 탐색 경로와 배포 개념. https://learn.chatgpt.com/docs/build-skills
[^S03]: OpenAI, **Subagents**. custom agent 구성, 모델·추론 수준과 부모 설정의 적용 범위. https://learn.chatgpt.com/docs/agent-configuration/subagents
[^S04]: Anthropic, **Extend Claude with skills**. `/skill-name`, 스킬 위치, plugin namespace, reference 자료 구성. https://code.claude.com/docs/en/skills
[^S05]: OpenAI, **Codex App Server**. `model/list`, 모델별 effort, pagination, 버전별 schema 생성 및 metadata. https://learn.chatgpt.com/docs/app-server
[^S06]: Anthropic, **Create custom subagents**. 역할 정의, model/effort, isolation, reload 및 plugin subagent 차이. https://code.claude.com/docs/en/sub-agents
[^S07]: Anthropic, **Agent SDK reference — TypeScript**. `supportedModels()` 등 SDK 계약. 문서상의 API 존재와 현재 CLI 세션에서의 접근 가능성은 별도 검증 대상이다. https://code.claude.com/docs/en/agent-sdk/typescript
[^S08]: Anthropic, **Claude Agent SDK TypeScript — CHANGELOG**. `ModelInfo`의 effort capability 정보 추가 기록. https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
[^S09]: OpenAI, **Model Context Protocol**. Codex MCP 연결과 구성. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[^S10]: Anthropic, **Connect Claude Code to tools via MCP**. MCP 연결과 scope. https://code.claude.com/docs/en/mcp
[^S11]: Git, **git-worktree Documentation**. worktree 생성·관리·제거와 저장소 공유 범위. https://git-scm.com/docs/git-worktree
[^S12]: Anthropic, **Model configuration**. 모델·effort 설정과 조직/환경 제한. https://code.claude.com/docs/en/model-config
[^S13]: Anthropic, **Hooks reference**. hook 이벤트와 동작 규약. https://code.claude.com/docs/en/hooks
[^S14]: Anthropic, **Agent SDK overview**. SDK와 CLI의 차이, 인증과 제3자 제품 조건. https://code.claude.com/docs/en/agent-sdk
[^S15]: Anthropic, **Plugin manifest reference**. plugin 구조와 구성 파일. https://code.claude.com/docs/en/plugins-reference

---

## 구현 인계 요약

이 제품의 핵심은 **별도 AI CLI를 하나 더 만드는 것이 아니라, 기존 Codex·Claude Code 안에서 현재 세션을 관리자로 사용하는 것**이다. 사용자에게는 대화형 진입점·모델 관리·자동 설정·상태·복구만 보이고, 내부에서는 상태·Git·검증·정리가 일관되게 통제되어야 한다.

첫 구현은 M0의 두 호스트 네이티브 실행 검증에서 시작한다. 그다음 공통 schema·설정·상태를 확정하고, 단일 Task의 안전한 종단 경로를 완성한 뒤 병렬화와 리뷰 반복을 추가한다. 모든 성공 판정은 실제 SHA·명령 결과·모델 관측·소유권 증거에 연결한다.
