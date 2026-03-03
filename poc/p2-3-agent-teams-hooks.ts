/**
 * P2-3: Agent Teams Hooks 감시
 *
 * 검증 항목:
 *   - SDK의 hooks 옵션으로 Agent Teams 도구 호출을 실시간 모니터링할 수 있는지 확인
 *   - PreToolUse / PostToolUse 콜백에서 도구 이름과 입력을 로깅
 *   - TaskCompleted / TeammateIdle 콜백에서 Agent Teams 이벤트 수신
 *
 * SDK 타입 확인 결과:
 *   - options.hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
 *   - HookCallbackMatcher: { matcher?: string, hooks: HookCallback[], timeout?: number }
 *   - HookCallback: (input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>
 *   - PreToolUseHookInput: { hook_event_name, tool_name, tool_input, tool_use_id }
 *   - PostToolUseHookInput: { hook_event_name, tool_name, tool_input, tool_response, tool_use_id }
 *   - TaskCompletedHookInput: { hook_event_name, task_id, task_subject, task_description?, teammate_name?, team_name? }
 *   - TeammateIdleHookInput: { hook_event_name, teammate_name, team_name }
 *
 * 성공 기준:
 *   - PreToolUse/PostToolUse 콜백에서 Agent Teams 도구(TeamCreate 등) 이벤트 1개 이상 수신
 *
 * 실패 시:
 *   - hooks가 options에 지원 안 되는 경우: 커맨드 기반 hooks (settings.json)로 시도
 *   - hooks 자체가 Agent Teams 도구를 못 잡는 경우: P3(디스크 IPC)로 감시 전략 전환
 *
 * 산출물:
 *   - results/p2-3-hook-logs.json (훅 이벤트 목록)
 *   - results/p2-3-report.md
 *
 * 실행: bun run p2-3-agent-teams-hooks.ts
 */

import { query, type HookInput, type HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";

const TIMEOUT_MS = 180_000; // 3분

const AGENT_TEAMS_TOOLS = [
  "TeamCreate", "team_create",
  "Task", "TaskCreate", "task_create",
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
  toolResponse?: unknown;
  taskId?: string;
  taskSubject?: string;
  teammateName?: string;
  teamName?: string;
  toolUseId?: string;
  isAgentTeams: boolean;
  rawInput: unknown;
}

interface P23Report {
  testId: "P2-3";
  testName: "Agent Teams Hooks 감시";
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

function generateMarkdown(report: P23Report): string {
  const c = report.criteria;

  return `# P2-3: Agent Teams Hooks 감시 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | P2-3 |
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

## Hook 이벤트 상세 (전체)

| 시간(ms) | Hook 이벤트 | 도구명 | Agent Teams? |
|---------|------------|--------|-------------|
${report.hookLogs.length > 0 ? report.hookLogs.map((h) => `| ${h.elapsedMs} | ${h.hookEvent} | ${h.toolName ?? h.taskId ?? h.teammateName ?? "-"} | ${h.isAgentTeams ? "YES" : "no"} |`).join("\n") : "| - | _없음_ | - | - |"}

## Agent Teams Hook 상세

${report.agentTeamsHookLogs.length > 0 ? report.agentTeamsHookLogs.map((h) => `- **${h.hookEvent}** (${h.elapsedMs}ms): tool=\`${h.toolName ?? "-"}\` task=\`${h.taskId ?? "-"}\` teammate=\`${h.teammateName ?? "-"}\``).join("\n") : "_Agent Teams 관련 Hook 이벤트 미감지_"}

## Stream tool_use vs Hook 비교

| 소스 | 감지 수 | 도구 목록 |
|------|--------|----------|
| Stream (tool_use) | ${report.toolCallsFromStream.length} | ${report.toolCallsFromStream.map((t) => t.name).join(", ") || "-"} |
| Hook (Pre/PostToolUse) | ${report.hookLogs.filter((h) => h.toolName).length} | ${report.hookLogs.filter((h) => h.toolName).map((h) => h.toolName).join(", ") || "-"} |

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
  console.log("=== P2-3: Agent Teams Hooks 감시 ===\n");
  const start = Date.now();

  // 1. Setup
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

        if ("tool_response" in input) {
          entry.toolResponse = input.tool_response;
        }

        const marker = entry.isAgentTeams ? "🎯 AT-HOOK" : "🔧 HOOK";
        console.log(`[${marker}] ${eventName} (${elapsed}ms) tool: ${input.tool_name}`);
      }

      if ("task_id" in input) {
        entry.taskId = input.task_id;
        entry.taskSubject = input.task_subject;
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
      return { continue: true };
    };
  }

  const prompt = `너는 Agent Teams 기능을 사용해야 한다.

다음을 순서대로 수행해:
1. "poc-hook-team"이라는 이름의 팀을 생성해 (TeamCreate)
2. 팀에 "worker"라는 teammate를 추가하고 "안녕이라고 답해"라는 태스크를 줘
3. teammate에게 "작업 완료 보고해"라는 메시지를 보내
4. 팀을 삭제해 (TeamDelete)

각 단계를 반드시 도구를 사용해서 수행해.`;

  // 2. Execute
  try {
    console.log("[Setup] hooks 등록: PreToolUse, PostToolUse, TaskCompleted, TeammateIdle");
    console.log("[Setup] env: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
    console.log("[Setup] model: sonnet, permissionMode: bypassPermissions\n");

    const q = query({
      prompt,
      options: {
        model: "sonnet",
        maxTurns: 250,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        env: {
          ...process.env,
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [createHookCallback("PreToolUse")],
              timeout: 10,
            },
          ],
          PostToolUse: [
            {
              hooks: [createHookCallback("PostToolUse")],
              timeout: 10,
            },
          ],
          TaskCompleted: [
            {
              hooks: [createHookCallback("TaskCompleted")],
              timeout: 10,
            },
          ],
          TeammateIdle: [
            {
              hooks: [createHookCallback("TeammateIdle")],
              timeout: 10,
            },
          ],
        },
      },
    });

    for await (const msg of q) {
      const elapsed = Date.now() - start;

      if (elapsed > TIMEOUT_MS) {
        console.log(`\n[Timeout] ${TIMEOUT_MS}ms 초과. 스트림 중단.`);
        break;
      }

      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            toolCallsFromStream.push({ name: block.name, elapsedMs: elapsed });
            console.log(`[Stream] tool_use (${elapsed}ms) ${block.name}`);
          }
          if (block.type === "text") {
            console.log(`[Text] (${elapsed}ms) ${block.text.substring(0, 80)}`);
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
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`\n[Error] ${error}`);
  }

  const durationMs = Date.now() - start;

  // 3. Analyze
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

  // 4. Dump
  const report: P23Report = {
    testId: "P2-3",
    testName: "Agent Teams Hooks 감시",
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
      ? "P2-3 PASS → 아키텍처 확정: Hooks 기반 stream-monitor"
      : criteria.preToolUseHookFired
        ? "Hooks는 동작하나 Agent Teams 도구 미감지 → P3 (디스크 IPC) 시도"
        : "Hooks 자체 미동작 → P3 (디스크 IPC)로 감시 전략 전환",
  };

  writeFileSync("results/p2-3-hook-logs.json", JSON.stringify(report, null, 2));
  writeFileSync("results/p2-3-report.md", generateMarkdown(report));

  // 5. 결론 출력
  console.log("\n" + "=".repeat(60));
  console.log(`P2-3: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`소요 시간: ${durationMs}ms`);
  console.log(`총 Hook 이벤트 수: ${hookLogs.length}`);
  console.log(`Agent Teams Hook 이벤트 수: ${agentTeamsHookLogs.length}`);
  console.log(`Hook 이벤트 카운트: ${JSON.stringify(hookEventCounts)}`);
  console.log("");
  console.log(`PreToolUse 발생: ${criteria.preToolUseHookFired ? "✅" : "❌"}`);
  console.log(`PostToolUse 발생: ${criteria.postToolUseHookFired ? "✅" : "❌"}`);
  console.log(`Agent Teams 도구 in Hooks: ${criteria.agentTeamsToolInHooks ? "✅" : "❌"}`);
  console.log(`TaskCompleted 발생: ${criteria.taskCompletedFired ? "✅" : "❌"}`);
  console.log(`TeammateIdle 발생: ${criteria.teammateIdleFired ? "✅" : "❌"}`);

  console.log("\n[Stream tool_use vs Hook 비교]");
  console.log(`Stream에서 감지: ${toolCallsFromStream.length}개 [${toolCallsFromStream.map((t) => t.name).join(", ")}]`);
  console.log(`Hook에서 감지: ${hookLogs.filter((h) => h.toolName).length}개 [${hookLogs.filter((h) => h.toolName).map((h) => `${h.hookEvent}:${h.toolName}`).join(", ")}]`);

  if (agentTeamsHookLogs.length > 0) {
    console.log("\n[Agent Teams Hook 상세]");
    for (const h of agentTeamsHookLogs) {
      console.log(`  ${h.elapsedMs}ms | ${h.hookEvent} | ${h.toolName ?? h.taskId ?? h.teammateName} | ${JSON.stringify(h.toolInput ?? h.rawInput).substring(0, 80)}`);
    }
  }

  if (error) console.log(`\n에러: ${error}`);
  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과: results/p2-3-hook-logs.json + results/p2-3-report.md`);
}

main();
