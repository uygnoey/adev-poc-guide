/**
 * P2-1: 동시 query() 안정성
 *
 * 검증 항목:
 *   - 독립 query() 3개를 Promise.all로 동시 실행
 *   - 독립 query() 5개를 Promise.all로 동시 실행
 *   - 각 query의 result 수신 여부 + 소요 시간 측정
 *
 * 성공 기준:
 *   - 5개 query 모두 msg.type === "result" 수신
 *   - 개별 타임아웃 60초 이내
 *
 * 실패 시:
 *   - Promise.all 동시 수를 3개 이하로 제한.
 *
 * 산출물: results/p2-1-concurrent.json
 *
 * 실행: npx tsx p2-1-concurrent-query.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "fs";

const TIMEOUT_MS = 60_000;

interface QueryResult {
  id: string;
  prompt: string;
  success: boolean;
  resultText: string | null;
  durationMs: number;
  eventCount: number;
  eventTypes: string[];
  error: string | null;
}

interface P21Report {
  testId: "P2-1";
  testName: "동시 query() 안정성";
  timestamp: string;
  totalDurationMs: number;
  result: "PASS" | "FAIL";
  phase1: {
    label: "3개 동시 query";
    results: QueryResult[];
    allSuccess: boolean;
    durationMs: number;
  };
  phase2: {
    label: "5개 동시 query";
    results: QueryResult[];
    allSuccess: boolean;
    durationMs: number;
  };
  criteria: {
    phase1AllSuccess: boolean;
    phase2AllSuccess: boolean;
    allWithin60Seconds: boolean;
  };
  nextStep: string;
}

async function runSingleQuery(id: string, prompt: string): Promise<QueryResult> {
  const start = Date.now();
  let resultText: string | null = null;
  let eventCount = 0;
  const eventTypes: string[] = [];
  let error: string | null = null;

  try {
    console.log(`  [${id}] 시작 - "${prompt}"`);

    const q = query({
      prompt,
      options: {
        model: "sonnet",
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        settingSources: [],
      },
    });

    for await (const msg of q) {
      eventCount++;
      const msgType = (msg as Record<string, unknown>).type as string;
      if (!eventTypes.includes(msgType)) eventTypes.push(msgType);

      if (Date.now() - start > TIMEOUT_MS) {
        error = `타임아웃 (${TIMEOUT_MS}ms 초과)`;
        break;
      }

      if (msg.type === "result") {
        resultText = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - start;
  const success = resultText !== null && error === null;

  console.log(`  [${id}] ${success ? "✅" : "❌"} (${durationMs}ms) - ${resultText ?? error ?? "no result"}`);

  return { id, prompt, success, resultText, durationMs, eventCount, eventTypes, error };
}

async function runConcurrent(label: string, count: number): Promise<{
  results: QueryResult[];
  allSuccess: boolean;
  durationMs: number;
}> {
  console.log(`\n--- ${label} ---`);
  const start = Date.now();

  const prompts = Array.from({ length: count }, (_, i) => ({
    id: `coder-${i + 1}`,
    prompt: `너는 coder-${i + 1}이다. "${i + 1} * ${i + 1}"의 결과를 숫자만 답해.`,
  }));

  const results = await Promise.all(
    prompts.map((p) => runSingleQuery(p.id, p.prompt))
  );

  const durationMs = Date.now() - start;
  const allSuccess = results.every((r) => r.success);

  console.log(`  → ${label}: ${allSuccess ? "✅ 전체 성공" : "❌ 일부 실패"} (총 ${durationMs}ms)`);

  return { results, allSuccess, durationMs };
}

async function main() {
  console.log("=== P2-1: 동시 query() 안정성 ===");
  const start = Date.now();

  // 1. Setup
  mkdirSync("results", { recursive: true });

  // 2. Execute Phase 1: 3개 동시
  const phase1 = await runConcurrent("3개 동시 query", 3);

  // 3. Execute Phase 2: 5개 동시
  const phase2 = await runConcurrent("5개 동시 query", 5);

  const totalDurationMs = Date.now() - start;

  // 4. Analyze
  const allResults = [...phase1.results, ...phase2.results];
  const allWithin60Seconds = allResults.every((r) => r.durationMs <= TIMEOUT_MS);

  const criteria = {
    phase1AllSuccess: phase1.allSuccess,
    phase2AllSuccess: phase2.allSuccess,
    allWithin60Seconds,
  };

  const pass = criteria.phase1AllSuccess && criteria.phase2AllSuccess && criteria.allWithin60Seconds;

  // 5. Dump
  const report: P21Report = {
    testId: "P2-1",
    testName: "동시 query() 안정성",
    timestamp: new Date().toISOString(),
    totalDurationMs,
    result: pass ? "PASS" : "FAIL",
    phase1: { label: "3개 동시 query", ...phase1 },
    phase2: { label: "5개 동시 query", ...phase2 },
    criteria,
    nextStep: pass
      ? "P2-1 PASS → P2-2 (Agent Teams 기본 동작) 진행"
      : criteria.phase1AllSuccess
        ? "5개 동시 실패 → 동시 query() 수를 3개 이하로 제한 후 P2-2 진행"
        : "3개 동시도 실패 → query() 동시 실행 근본 문제 조사 필요",
  };

  writeFileSync("results/p2-1-concurrent.json", JSON.stringify(report, null, 2));

  // 6. 결론 출력
  console.log("\n" + "=".repeat(60));
  console.log(`P2-1: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`총 소요 시간: ${totalDurationMs}ms`);
  console.log(`3개 동시: ${criteria.phase1AllSuccess ? "✅" : "❌"} (${phase1.durationMs}ms)`);
  console.log(`5개 동시: ${criteria.phase2AllSuccess ? "✅" : "❌"} (${phase2.durationMs}ms)`);
  console.log(`전체 60초 이내: ${criteria.allWithin60Seconds ? "✅" : "❌"}`);

  // 개별 결과 테이블
  console.log("\n[개별 결과]");
  console.log("ID         | 성공 | 소요(ms) | 결과");
  console.log("-".repeat(55));
  for (const r of allResults) {
    console.log(
      `${r.id.padEnd(10)} | ${r.success ? "✅" : "❌"}   | ${String(r.durationMs).padStart(7)} | ${(r.resultText ?? r.error ?? "-").substring(0, 30)}`
    );
  }

  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과 파일: results/p2-1-concurrent.json`);
}

main();
