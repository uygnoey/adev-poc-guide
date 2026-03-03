/**
 * V2-P3: V2 디스크 기반 IPC 확인
 *
 * 검증 항목:
 *   - V2 Session API로 Agent Teams 실행 중 생성되는 파일시스템 구조 확인
 *   - createSession + send + stream과 동시에 파일시스템 폴링
 *
 * 성공 기준:
 *   - 팀 관련 디렉토리 또는 파일 1개 이상 발견
 *   - JSON 파싱하여 메시지 구조 확인 가능
 *
 * 실패 시:
 *   - V2 Session에서 디스크 IPC 미생성 → V1 query() 사용
 *
 * 산출물:
 *   - results/v2-p3-disk-findings.json
 *   - results/v2-p3-report.md
 *
 * 실행: bun run v2-p3-disk-ipc.ts
 */

import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { join, relative } from "path";
import { homedir } from "os";

const TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;

const CLAUDE_DIR = join(homedir(), ".claude");
const WATCH_DIRS = [
  join(CLAUDE_DIR, "teams"),
  join(CLAUDE_DIR, "tasks"),
];

interface FileDiscovery {
  timestamp: string;
  elapsedMs: number;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  size?: number;
  content?: unknown;
  parseError?: string;
}

interface V2P3Report {
  testId: "V2-P3";
  testName: "V2 디스크 기반 IPC 확인";
  timestamp: string;
  durationMs: number;
  result: "PASS" | "FAIL";
  criteria: {
    teamDirectoryFound: boolean;
    anyFileFound: boolean;
    jsonParseable: boolean;
    inboxStructureFound: boolean;
  };
  watchDirs: string[];
  discoveries: FileDiscovery[];
  jsonFiles: Array<{ path: string; content: unknown }>;
  queryResult: Record<string, unknown> | null;
  error: string | null;
  nextStep: string;
}

function generateMarkdown(report: V2P3Report): string {
  const c = report.criteria;

  return `# V2-P3: V2 디스크 기반 IPC 확인 — 결과서

## 개요

| 항목 | 값 |
|------|-----|
| 테스트 ID | V2-P3 |
| 실행 시각 | ${report.timestamp} |
| 소요 시간 | ${report.durationMs}ms |
| **최종 결과** | **${report.result}** |

## 성공 기준 체크

| 기준 | 결과 |
|------|------|
| 팀 디렉토리 발견 | ${c.teamDirectoryFound ? "PASS" : "FAIL"} |
| 파일 발견 (1개 이상) | ${c.anyFileFound ? "PASS" : "FAIL"} |
| JSON 파싱 가능 | ${c.jsonParseable ? "PASS" : "FAIL"} |
| inbox 구조 발견 | ${c.inboxStructureFound ? "PASS" : "FAIL"} |

## 발견된 파일/디렉토리 (${report.discoveries.length}개)

${report.discoveries.length > 0 ? `| 시간(ms) | 타입 | 경로 | 크기 |
|---------|------|------|------|
${report.discoveries.map((d) => `| ${d.elapsedMs} | ${d.type} | \`${d.relativePath}\` | ${d.size !== undefined ? `${d.size}B` : "-"} |`).join("\n")}` : "_발견된 파일 없음_"}

## 파싱된 JSON 내용 (${report.jsonFiles.length}개)

${report.jsonFiles.length > 0 ? report.jsonFiles.map((j) => `### \`${relative(CLAUDE_DIR, j.path)}\`

\`\`\`json
${JSON.stringify(j.content, null, 2).substring(0, 500)}
\`\`\`
`).join("\n") : "_파싱 가능한 JSON 파일 없음_"}

## query() 결과

${report.queryResult ? `\`\`\`json\n${JSON.stringify(report.queryResult, null, 2)}\n\`\`\`` : "_미수신_"}

${report.error ? `## 에러\n\n\`\`\`\n${report.error}\n\`\`\`` : ""}

## 다음 단계

> ${report.nextStep}

---
_생성: ${report.timestamp}_
`;
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      results.push(fullPath);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath));
      }
    }
  } catch {
    // ignore permission errors
  }
  return results;
}

function tryParseJsonFile(filePath: string): { content: unknown; error?: string } {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return { content: null, error: "empty file" };

    try {
      return { content: JSON.parse(raw) };
    } catch {
      const lines = raw.split("\n").filter((l: string) => l.trim());
      const parsed = lines.map((line: string) => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
      return { content: parsed };
    }
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  console.log("=== V2-P3: V2 디스크 기반 IPC 확인 ===\n");
  const start = Date.now();

  mkdirSync("results", { recursive: true });

  const discoveries: FileDiscovery[] = [];
  const jsonFiles: Array<{ path: string; content: unknown }> = [];
  let queryResult: Record<string, unknown> | null = null;
  let error: string | null = null;

  const baselineFiles = new Set<string>();
  for (const dir of WATCH_DIRS) {
    for (const f of walkDir(dir)) {
      baselineFiles.add(f);
    }
  }

  console.log(`[Setup] 감시 대상: ${WATCH_DIRS.join(", ")}`);
  console.log(`[Setup] 기준 파일 수: ${baselineFiles.size}`);

  const prompt = `너는 Agent Teams 기능을 사용해야 한다.

다음을 순서대로 수행해:
1. "v2-ipc-team"이라는 이름의 팀을 생성해 (TeamCreate)
2. 팀에 "observer"라는 teammate를 추가하고 "Hello라고 답해"라는 태스크를 줘
3. teammate에게 "상태 보고"라는 메시지를 보내
4. 30초 기다린 후 팀을 삭제해 (TeamDelete)

각 단계를 반드시 도구를 사용해서 수행해.`;

  console.log("\n[Execute] V2 session + 파일시스템 폴링 동시 시작...\n");

  let queryDone = false;
  let pollCount = 0;

  const pollFilesystem = async () => {
    while (!queryDone && Date.now() - start < TIMEOUT_MS) {
      pollCount++;
      const elapsed = Date.now() - start;

      for (const dir of WATCH_DIRS) {
        const currentFiles = walkDir(dir);
        for (const filePath of currentFiles) {
          if (!baselineFiles.has(filePath)) {
            baselineFiles.add(filePath);
            let isDir = false;
            let fileSize: number | undefined;
            try {
              const stat = statSync(filePath);
              isDir = stat.isDirectory();
              if (!isDir) fileSize = stat.size;
            } catch {
              continue;
            }
            const discovery: FileDiscovery = {
              timestamp: new Date().toISOString(),
              elapsedMs: elapsed,
              path: filePath,
              relativePath: relative(CLAUDE_DIR, filePath),
              type: isDir ? "directory" : "file",
              size: fileSize,
            };

            if (!isDir && (filePath.endsWith(".json") || filePath.endsWith(".jsonl"))) {
              const { content, error: parseError } = tryParseJsonFile(filePath);
              discovery.content = content;
              discovery.parseError = parseError;
              if (content) jsonFiles.push({ path: filePath, content });
            }

            discoveries.push(discovery);
            console.log(`[Poll #${pollCount}] 🆕 ${discovery.type} (${elapsed}ms): ${discovery.relativePath}`);
          }
        }
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  const runQuery = async () => {
    let session: ReturnType<typeof unstable_v2_createSession> | null = null;
    try {
      session = unstable_v2_createSession({
        model: "sonnet",
        permissionMode: "bypassPermissions",
        env: {
          ...process.env,
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        },
      });

      await session.send(prompt);

      for await (const msg of session.stream()) {
        const elapsed = Date.now() - start;

        if (elapsed > TIMEOUT_MS) {
          console.log(`[Timeout] ${TIMEOUT_MS}ms 초과.`);
          break;
        }

        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              console.log(`[Query] tool_use (${elapsed}ms): ${block.name}`);
            }
          }
        }

        if (msg.type === "result") {
          const resultText = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
          queryResult = {
            subtype: msg.subtype,
            result: typeof resultText === "string" ? resultText.substring(0, 200) : resultText,
            total_cost_usd: msg.total_cost_usd,
            num_turns: msg.num_turns,
          };
          console.log(`[Query] result (${elapsed}ms): ${msg.subtype}`);
          break;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[Query Error] ${error}`);
    } finally {
      session?.close();
      console.log("[Session] close() 완료");
      queryDone = true;
    }
  };

  await Promise.all([runQuery(), pollFilesystem()]);

  // 마지막 폴링
  await new Promise((r) => setTimeout(r, 1000));
  for (const dir of WATCH_DIRS) {
    for (const filePath of walkDir(dir)) {
      if (!baselineFiles.has(filePath)) {
        baselineFiles.add(filePath);
        let isDir = false;
        let fileSize: number | undefined;
        try {
          const stat = statSync(filePath);
          isDir = stat.isDirectory();
          if (!isDir) fileSize = stat.size;
        } catch { continue; }
        const discovery: FileDiscovery = {
          timestamp: new Date().toISOString(),
          elapsedMs: Date.now() - start,
          path: filePath,
          relativePath: relative(CLAUDE_DIR, filePath),
          type: isDir ? "directory" : "file",
          size: fileSize,
        };
        if (!isDir && (filePath.endsWith(".json") || filePath.endsWith(".jsonl"))) {
          const { content, error: parseError } = tryParseJsonFile(filePath);
          discovery.content = content;
          discovery.parseError = parseError;
          if (content) jsonFiles.push({ path: filePath, content });
        }
        discoveries.push(discovery);
        console.log(`[Final] 🆕 ${discovery.type}: ${discovery.relativePath}`);
      }
    }
  }

  const durationMs = Date.now() - start;

  const criteria = {
    teamDirectoryFound: discoveries.some(
      (d) => d.type === "directory" && (d.relativePath.includes("teams") || d.relativePath.includes("tasks"))
    ),
    anyFileFound: discoveries.length > 0,
    jsonParseable: jsonFiles.length > 0,
    inboxStructureFound: discoveries.some(
      (d) => d.relativePath.includes("inbox") || d.relativePath.includes("message")
    ),
  };

  const pass = criteria.anyFileFound && (criteria.jsonParseable || criteria.teamDirectoryFound);

  const report: V2P3Report = {
    testId: "V2-P3",
    testName: "V2 디스크 기반 IPC 확인",
    timestamp: new Date().toISOString(),
    durationMs,
    result: pass ? "PASS" : "FAIL",
    criteria,
    watchDirs: WATCH_DIRS,
    discoveries,
    jsonFiles,
    queryResult,
    error,
    nextStep: pass
      ? "V2-P3 PASS → V2 Session API에서도 디스크 폴링 감시 가능"
      : "V2에서 디스크 IPC 미생성 → V1 query() 사용 권장",
  };

  writeFileSync("results/v2-p3-disk-findings.json", JSON.stringify(report, null, 2));
  writeFileSync("results/v2-p3-report.md", generateMarkdown(report));

  console.log("\n" + "=".repeat(60));
  console.log(`V2-P3: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`소요 시간: ${durationMs}ms`);
  console.log(`폴링 횟수: ${pollCount}`);
  console.log(`발견 파일/디렉토리: ${discoveries.length}개`);
  console.log(`JSON 파싱: ${jsonFiles.length}개`);
  console.log(`팀 디렉토리: ${criteria.teamDirectoryFound ? "✅" : "❌"}`);
  console.log(`inbox 구조: ${criteria.inboxStructureFound ? "✅" : "❌"}`);
  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과: results/v2-p3-disk-findings.json + results/v2-p3-report.md`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
