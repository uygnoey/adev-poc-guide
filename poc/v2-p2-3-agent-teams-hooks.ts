/**
 * V2-P2-3: V2 Agent Teams Hooks 감시
 *
 * 검증 항목:
 *   - V2 Session API의 hooks 옵션으로 Agent Teams 도구 호출을 실시간 모니터링
 *   - createSession에 hooks 전달 → send + stream에서 hook 콜백 발화 확인
 *
 * 성공 기준:
 *   - PreToolUse/PostToolUse 콜백에서 Agent Teams 도구 이벤트 1개 이상 수신
 *
 * 실패 시:
 *   - V2에서 hooks 미지원 → V1 query() API 사용
 *   - hooks는 되나 Agent Teams 미감지 → V2-P3 (디스크 IPC) 시도
 *
 * 산출물:
 *   - results/v2-p2-3-hook-logs.json
 *   - results/v2-p2-3-report.md
 *
 * 실행: bun run v2-p2-3-agent-teams-hooks.ts
 */

import {
  unstable_v2_createSession,
  type HookInput,
  type HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";

const TIMEOUT_MS = 180_000;

const AGENT_TEAMS_TOOLS = [
  "TeamCreate", "team_create",
  "TaskCreate", "task_create",
  "TaskList", "TaskUpdate", "TaskGet",
  "SendMessage", "send_message",
  "TeamDelete", "team_delete",
  "Agent",
];

interface HookLogEntry {
  timestamp: string;
  elapsedMs: number;
  hookEvent: string;
  toolName?: string;
  toolInput?: unknown;
  teammateName?: string;
  teamName?: string;
  toolUseId?: string;
  isAgentTeams: boolean;
  rawInput: unknown;
}

interface V2P23Report {
  testId: "V2-P2-3";
  testName: "V2 Agent Teams Hooks 감시";
  timestamp: string;
  durationMs: number;
  result: "PASS" | "FAIL";
  criteria: {
    preToolUseHookFired: boolean;
    postToolUseHookFired: boolean;
    agentTeamsToolInHooks: boolean;
    taskCompletedFired: boolean;
    teammateIdleFired: boolean;
  };
  hookLogs: HookLogEntry[];
  agentTeamsHookLogs: HookLogEntry[];
  hookEventCounts: Record<string, number>;
  toolCallsFromStream: Array<{ name: string; elapsedMs: number }>;
  resultEvent: Record<string, unknown> | null;
  error: string | null;
  nextStep: string;
}

function generateMarkdown(report: V2P23Report): string {
  const c = report.criteria;

  return `# V2-P2-3: V2 Agent Teams Hooks 감시 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | V2-P2-3 |
| 실행 시각 | ${report.timestamp} |
| 소요 시간 | ${report.durationMs}ms |
| **최종 결과** | **${report.result}** |

## 성공 기준 체크

| 기준 | 결과 |
|------|------|
| PreToolUse 훅 발생 | ${c.preToolUseHookFired ? "PASS" : "FAIL"} |
| PostToolUse 훅 발생 | ${c.postToolUseHookFired ? "PASS" : "FAIL"} |
| **Agent Teams 도구 in Hooks** | **${c.agentTeamsToolInHooks ? "PASS" : "FAIL"}** |
| TaskCompleted 훅 발생 | ${c.taskCompletedFired ? "PASS" : "FAIL"} |
| TeammateIdle 훅 발생 | ${c.teammateIdleFired ? "PASS" : "FAIL"} |

## Hook 이벤트 통계

| 이벤트 | 발생 횟수 |
|--------|----------|
${Object.entries(report.hookEventCounts).map(([k, v]) => `| ${k} | ${v} |`).join("\n") || "| _없음_ | 0 |"}

**총 Hook 이벤트:** ${report.hookLogs.length}개
**Agent Teams Hook:** ${report.agentTeamsHookLogs.length}개

## Hook 이벤트 상세

| 시간(ms) | Hook 이벤트 | 도구명 | Agent Teams? |
|---------|------------|--------|-------------|
${report.hookLogs.length > 0 ? report.hookLogs.map((h) => `| ${h.elapsedMs} | ${h.hookEvent} | ${h.toolName ?? h.teammateName ?? "-"} | ${h.isAgentTeams ? "YES" : "no"} |`).join("\n") : "| - | _없음_ | - | - |"}

## Stream tool_use vs Hook 비교

| 소스 | 감지 수 |
|------|--------|
| Stream (tool_use) | ${report.toolCallsFromStream.length} |
| Hook (Pre/PostToolUse) | ${report.hookLogs.filter((h) => h.toolName).length} |

## result 이벤트

${report.resultEvent ? `\`\`\`json\n${JSON.stringify(report.resultEvent, null, 2)}\n\`\`\`` : "_미수신_"}

${report.error ? `## 에러\n\n\`\`\`\n${report.error}\n\`\`\`` : ""}

## 다음 단계

> ${report.nextStep}

---
_생성: ${report.timestamp}_
`;
}

async function main() {
  console.log("=== V2-P2-3: V2 Agent Teams Hooks 감시 ===\n");
  const start = Date.now();

  mkdirSync("results", { recursive: true });

  const hookLogs: HookLogEntry[] = [];
  const toolCallsFromStream: Array<{ name: string; elapsedMs: number }> = [];
  let resultEvent: Record<string, unknown> | null = null;
  let error: string | null = null;

  function createHookCallback(eventName: string) {
    return async (
      input: HookInput,
      toolUseID: string | undefined,
      _options: { signal: AbortSignal }
    ): Promise<HookJSONOutput> => {
      const elapsed = Date.now() - start;

      try {
        const rawInput = JSON.parse(JSON.stringify(input));

        const entry: HookLogEntry = {
          timestamp: new Date().toISOString(),
          elapsedMs: elapsed,
          hookEvent: eventName,
          toolUseId: toolUseID,
          isAgentTeams: false,
          rawInput,
        };

        if ("tool_name" in input) {
          entry.toolName = input.tool_name;
          entry.toolInput = input.tool_input;
          entry.isAgentTeams = AGENT_TEAMS_TOOLS.includes(input.tool_name);

          const marker = entry.isAgentTeams ? "🎯 AT-HOOK" : "🔧 HOOK";
          console.log(`[${marker}] ${eventName} (${elapsed}ms) tool: ${input.tool_name}`);
        }

        if ("task_id" in input) {
          entry.teammateName = input.teammate_name;
          entry.teamName = input.team_name;
          entry.isAgentTeams = true;
          console.log(`[🎯 AT-HOOK] ${eventName} (${elapsed}ms) task: ${input.task_subject}`);
        }

        if ("teammate_name" in input && !("task_id" in input)) {
          entry.teammateName = input.teammate_name;
          entry.teamName = input.team_name;
          entry.isAgentTeams = true;
          console.log(`[🎯 AT-HOOK] ${eventName} (${elapsed}ms) teammate: ${input.teammate_name}`);
        }

        hookLogs.push(entry);
      } catch (err) {
        console.error(`[Hook Error] ${eventName} (${elapsed}ms): ${err}`);
      }

      return { continue: true };
    };
  }

  const prompt = `너는 Agent Teams 기능을 사용해야 한다.

다음을 순서대로 수행해:
1. "v2-hook-team"이라는 이름의 팀을 생성해 (TeamCreate)
2. 팀에 "worker"라는 teammate를 추가하고 "안녕이라고 답해"라는 태스크를 줘
3. teammate에게 "작업 완료 보고해"라는 메시지를 보내
4. 팀을 삭제해 (TeamDelete)

각 단계를 반드시 도구를 사용해서 수행해.`;

  try {
    console.log("[Setup] V2 createSession + hooks + Agent Teams");
    console.log("[Setup] hooks: PreToolUse, PostToolUse, TaskCompleted, TeammateIdle\n");

    const session = unstable_v2_createSession({
      model: "sonnet",
      permissionMode: "bypassPermissions",
      env: {
        ...process.env,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      },
      hooks: {
        PreToolUse: [{ hooks: [createHookCallback("PreToolUse")], timeout: 10 }],
        PostToolUse: [{ hooks: [createHookCallback("PostToolUse")], timeout: 10 }],
        TaskCompleted: [{ hooks: [createHookCallback("TaskCompleted")], timeout: 10 }],
        TeammateIdle: [{ hooks: [createHookCallback("TeammateIdle")], timeout: 10 }],
      },
    });

    await session.send(prompt);

    for await (const msg of session.stream()) {
      const elapsed = Date.now() - start;

      if (elapsed > TIMEOUT_MS) {
        console.log(`\n[Timeout] ${TIMEOUT_MS}ms 초과.`);
        break;
      }

      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            toolCallsFromStream.push({ name: block.name, elapsedMs: elapsed });
            console.log(`[Stream] tool_use (${elapsed}ms) ${block.name}`);
          }
        }
      }

      if (msg.type === "result") {
        const resultText = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
        resultEvent = {
          subtype: msg.subtype,
          result: typeof resultText === "string" ? resultText.substring(0, 200) : resultText,
          total_cost_usd: msg.total_cost_usd,
          duration_ms: msg.duration_ms,
          num_turns: msg.num_turns,
        };
        console.log(`\n[Result] (${elapsed}ms) subtype: ${msg.subtype}, cost: $${msg.total_cost_usd}`);
        break;
      }
    }

    session.close();
    console.log("[Session] close() 완료");
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`\n[Error] ${error}`);
  }

  const durationMs = Date.now() - start;

  const agentTeamsHookLogs = hookLogs.filter((h) => h.isAgentTeams);
  const hookEventCounts: Record<string, number> = {};
  for (const h of hookLogs) {
    hookEventCounts[h.hookEvent] = (hookEventCounts[h.hookEvent] || 0) + 1;
  }

  const criteria = {
    preToolUseHookFired: hookLogs.some((h) => h.hookEvent === "PreToolUse"),
    postToolUseHookFired: hookLogs.some((h) => h.hookEvent === "PostToolUse"),
    agentTeamsToolInHooks: agentTeamsHookLogs.some(
      (h) => h.hookEvent === "PreToolUse" || h.hookEvent === "PostToolUse"
    ),
    taskCompletedFired: hookLogs.some((h) => h.hookEvent === "TaskCompleted"),
    teammateIdleFired: hookLogs.some((h) => h.hookEvent === "TeammateIdle"),
  };

  const pass = criteria.agentTeamsToolInHooks;

  const report: V2P23Report = {
    testId: "V2-P2-3",
    testName: "V2 Agent Teams Hooks 감시",
    timestamp: new Date().toISOString(),
    durationMs,
    result: pass ? "PASS" : "FAIL",
    criteria,
    hookLogs,
    agentTeamsHookLogs,
    hookEventCounts,
    toolCallsFromStream,
    resultEvent,
    error,
    nextStep: pass
      ? "V2-P2-3 PASS → V2 Session API에서도 Hooks 기반 stream-monitor 가능"
      : criteria.preToolUseHookFired
        ? "Hooks 동작하나 Agent Teams 미감지 → V2-P3 (디스크 IPC) 시도"
        : "V2에서 Hooks 미동작 → V1 query() 사용 권장",
  };

  writeFileSync("results/v2-p2-3-hook-logs.json", JSON.stringify(report, null, 2));
  writeFileSync("results/v2-p2-3-report.md", generateMarkdown(report));

  console.log("\n" + "=".repeat(60));
  console.log(`V2-P2-3: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`소요 시간: ${durationMs}ms`);
  console.log(`총 Hook 이벤트: ${hookLogs.length}개`);
  console.log(`Agent Teams Hook: ${agentTeamsHookLogs.length}개`);
  console.log(`PreToolUse: ${criteria.preToolUseHookFired ? "✅" : "❌"}`);
  console.log(`PostToolUse: ${criteria.postToolUseHookFired ? "✅" : "❌"}`);
  console.log(`Agent Teams in Hooks: ${criteria.agentTeamsToolInHooks ? "✅" : "❌"}`);
  console.log(`TeammateIdle: ${criteria.teammateIdleFired ? "✅" : "❌"}`);
  console.log(`Stream vs Hook: ${toolCallsFromStream.length} vs ${hookLogs.filter((h) => h.toolName).length}`);
  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과: results/v2-p2-3-hook-logs.json + results/v2-p2-3-report.md`);
}

main();
