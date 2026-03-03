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

## SDK 타입 확인 결과 (2026-03-03)
- options.env: `{ [envVar: string]: string | undefined }` ✅ 존재
- options.hooks: `Partial<Record<HookEvent, HookCallbackMatcher[]>>` ✅ 존재
- HookCallback: `(input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>`
- allowedTools: `string[]` ✅ 존재
- HookEvent: PreToolUse, PostToolUse, TaskCompleted, TeammateIdle 등 20개

## 실행 순서
P0 → P2-1 → P2-2 → P2-3 → P3
각 단계 PASS 확인 후 다음 진행

## 실행 방법
```bash
cd poc
bun install
bun run p0-sdk-sanity.ts         # P0   → results/p0-events.json + p0-report.md
bun run p2-1-concurrent-query.ts # P2-1 → results/p2-1-concurrent.json + p2-1-report.md
bun run p2-2-agent-teams-basic.ts # P2-2 → results/p2-2-tool-calls.json + p2-2-report.md
bun run p2-3-agent-teams-hooks.ts # P2-3 → results/p2-3-hook-logs.json + p2-3-report.md
bun run p3-disk-ipc.ts            # P3   → results/p3-disk-findings.json + p3-report.md

# 또는 npm scripts로:
bun run p0
bun run p2-1
bun run p2-2
bun run p2-3
bun run p3

# 타입 체크:
bun run typecheck
```
