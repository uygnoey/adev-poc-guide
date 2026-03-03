# adev PoC Architecture — 구조 + 의존성 + 실행 흐름

## 프로젝트 구조

```
poc/
├── package.json              ← 의존성: @anthropic-ai/claude-agent-sdk, tsx
├── CLAUDE.md                 ← 이 프로젝트의 Claude Code 지침 (아래 내용 복사)
├── p0-sdk-sanity.ts          ← SDK 기본 동작 확인
├── p2-1-concurrent-query.ts  ← 동시 query() 안정성
├── p2-2-agent-teams-basic.ts ← Agent Teams 라이프사이클 + tool_use 감지
├── p2-3-agent-teams-hooks.ts ← Hooks 감시 가능성
├── p3-disk-ipc.ts            ← 디스크 기반 IPC 확인
└── results/                  ← 결과 JSON 저장 디렉토리
    ├── p0-events.json
    ├── p2-1-concurrent.json
    ├── p2-2-tool-calls.json
    ├── p2-3-hook-logs.json
    └── p3-disk-findings.json
```

## 의존성

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.2.0"
  }
}
```

**전제조건**: Claude Code CLI 설치 필수 (`npm i -g @anthropic-ai/claude-code`)
**이유**: claude-agent-sdk의 query()는 내부적으로 Claude Code subprocess를 spawn한다.

## 인증

```bash
# 방법 1: API Key
export ANTHROPIC_API_KEY=sk-ant-api03-...

# 방법 2: Claude Code 로그인 (Pro/Max)
claude  # 최초 실행 시 로그인
```

## 실행 흐름

```
┌─────────────────────────────────────────────┐
│  P0: SDK 기본 동작                           │
│  npx tsx p0-sdk-sanity.ts                    │
│  → query() 실행 + 이벤트 구조 dump           │
│  → PASS: assistant + result 이벤트 수신      │
└────────────┬────────────────────────────────┘
             │ PASS
┌────────────▼────────────────────────────────┐
│  P2-1: 동시 query()                          │
│  npx tsx p2-1-concurrent-query.ts            │
│  → Promise.all(query×3), Promise.all(query×5) │
│  → PASS: 5개 모두 result 수신                │
└────────────┬────────────────────────────────┘
             │ PASS
┌────────────▼────────────────────────────────┐
│  P2-2: Agent Teams 기본                      │
│  npx tsx p2-2-agent-teams-basic.ts           │
│  → env: AGENT_TEAMS=1 + 팀 생성 프롬프트     │
│  → tool_use에서 TeamCreate 등 감지           │
│  → PASS: TeamCreate 최소 1회 감지            │
└────────────┬────────────────────────────────┘
             │ PASS
┌────────────▼────────────────────────────────┐
│  P2-3: Hooks 감시                            │
│  npx tsx p2-3-agent-teams-hooks.ts           │
│  → PreToolUse/PostToolUse 콜백 등록          │
│  → Agent Teams 도구 이벤트 수신 확인         │
│  → PASS: 훅에서 Agent Teams 이벤트 감지      │
├────────────┬────────────────────────────────┤
│            │ FAIL                            │
│  ┌─────────▼──────────────────────────┐     │
│  │  P3: 디스크 IPC                     │     │
│  │  npx tsx p3-disk-ipc.ts             │     │
│  │  → ~/.claude/teams/ 폴링 감시       │     │
│  │  → inbox JSON 파싱 시도             │     │
│  │  → PASS: 파일 발견 + 파싱 가능      │     │
│  └─────────────────────────────────────┘     │
└──────────────────────────────────────────────┘
```

## 각 파일의 공통 구조

모든 PoC 파일은 동일한 패턴을 따른다:

```typescript
/**
 * [테스트 ID]: [테스트 이름]
 *
 * 검증 항목:
 *   - ...
 *
 * 성공 기준:
 *   - ...
 *
 * 실패 시:
 *   - ...
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";

async function main() {
  console.log("=== [테스트 ID]: [테스트 이름] ===\n");
  const start = Date.now();

  // 1. Setup
  mkdirSync("results", { recursive: true });

  // 2. Execute
  try {
    const q = query({ ... });
    for await (const msg of q) {
      // 이벤트 수집 + 분석
      // 타임아웃 체크
      if (Date.now() - start > TIMEOUT_MS) break;
      if (msg.type === "result") break;
    }
  } catch (err) {
    // 에러 처리 + 다음 단계 안내
  }

  // 3. Analyze
  // 성공 기준 체크

  // 4. Dump
  writeFileSync("results/[id]-[name].json", JSON.stringify(data, null, 2));

  // 5. 결론 출력
  console.log(`\n[테스트 ID]: ${pass ? "✅ PASS" : "❌ FAIL"}`);
}

main();
```

## CLAUDE.md (poc/ 디렉토리에 배치)

아래 내용을 `poc/CLAUDE.md`로 저장하여 Claude Code가 이 프로젝트의 지침을 자동 로드하게 한다.

```markdown
# adev PoC — Claude Code 지침

## 이 프로젝트는
Claude Agent SDK + Agent Teams의 실제 동작을 검증하는 PoC이다.

## 규칙
1. 코드 작성 전 반드시 POC-SPEC.md와 POC-SKILL.md를 읽을 것
2. 추측으로 코드를 짜지 말 것. 불확실하면 SDK 소스를 직접 확인
3. 모든 테스트 결과는 results/ 디렉토리에 JSON으로 dump
4. 각 파일은 독립 실행 가능해야 함 (외부 유틸 의존 최소화)
5. 타임아웃은 반드시 설정 (기본 2분)
6. 에러 시 의미 있는 메시지 + 다음 단계 안내 출력

## SDK 핵심
- query()가 spawn하는 것은 Claude Code subprocess
- Agent Teams 도구는 Claude 모델이 tool_use로 호출 (우리가 호출하는 게 아님)
- msg.type: "assistant" / "result" / "system" / "stream_event"
- assistant 텍스트: msg.message.content.filter(b => b.type === "text")
- tool_use 감지: msg.message.content.filter(b => b.type === "tool_use")

## 실행 순서
P0 → P2-1 → P2-2 → P2-3 → P3
각 단계 PASS 확인 후 다음 진행
```

## 환경 요구사항

| 항목 | 요구 | 비고 |
|------|------|------|
| Node.js | 18+ | Claude Code 전제조건 |
| Claude Code | 설치 + 인증 | `npm i -g @anthropic-ai/claude-code` |
| API 인증 | API Key 또는 Pro/Max | `ANTHROPIC_API_KEY` 환경변수 |
| OS | macOS / Linux | Windows는 미테스트 |
| 디스크 | ~/.claude/ 접근 가능 | P3에서 필요 |

## 주의사항

1. **비용**: 각 PoC가 sonnet API를 호출한다. P2-2/P2-3/P3는 Agent Teams로 여러 세션이 spawn되어 비용이 높을 수 있다.
2. **시간**: Agent Teams 테스트(P2-2~P3)는 각 1~3분 소요될 수 있다.
3. **정리**: Agent Teams가 정상 종료 안 되면 `rm -rf ~/.claude/teams/ ~/.claude/tasks/` 로 수동 정리.
