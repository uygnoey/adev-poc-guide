/**
 * P3: 디스크 기반 IPC 확인
 *
 * 검증 항목:
 *   - Agent Teams 실행 중 생성되는 파일시스템 구조 확인
 *   - Hooks가 안 될 경우의 대안(디스크 폴링 감시) 가능성 검증
 *
 * 해야 할 것:
 *   - Agent Teams query() 실행과 동시에 파일시스템 폴링 (500ms 간격)
 *   - ~/.claude/teams/ 디렉토리 감시
 *   - ~/.claude/tasks/ 디렉토리 감시
 *   - 새로 생성되는 파일/디렉토리 기록
 *   - JSON 파일 발견 시 내용 파싱 시도
 *
 * 성공 기준:
 *   - 팀 관련 디렉토리 또는 파일 1개 이상 발견
 *   - JSON/JSONL 파싱하여 메시지 구조 확인 가능
 *
 * 실패 시:
 *   - 경로가 다른 경우: find ~/.claude -name "*.json" -newer 로 탐색
 *   - 파일이 아예 없는 경우: Agent Teams 완전 제거 → 독립 query() + LanceDB 통신으로 전환
 *
 * 산출물: results/p3-disk-findings.json (발견된 파일 + 내용)
 *
 * 실행: npx tsx p3-disk-ipc.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
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

const TIMEOUT_MS = 180_000; // 3분
const POLL_INTERVAL_MS = 500;

// 감시 대상 경로
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

interface P3Report {
  testId: "P3";
  testName: "디스크 기반 IPC 확인";
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
  claudeDirExists: boolean;
  claudeDirContents: string[];
  discoveries: FileDiscovery[];
  jsonFiles: Array<{ path: string; content: unknown }>;
  fallbackSearchResults: string[];
  queryResult: Record<string, unknown> | null;
  error: string | null;
  nextStep: string;
}

/**
 * 디렉토리를 재귀적으로 탐색하여 모든 파일/디렉토리 경로를 반환
 */
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
    // 권한 문제 등 무시
  }
  return results;
}

/**
 * JSON/JSONL 파일 파싱 시도
 */
function tryParseJsonFile(filePath: string): { content: unknown; error?: string } {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return { content: null, error: "empty file" };

    // JSON 시도
    try {
      return { content: JSON.parse(raw) };
    } catch {
      // JSONL 시도
      const lines = raw.split("\n").filter((l: string) => l.trim());
      const parsed = lines.map((line: string) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
      return { content: parsed };
    }
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  console.log("=== P3: 디스크 기반 IPC 확인 ===\n");
  const start = Date.now();

  // 1. Setup
  mkdirSync("results", { recursive: true });

  const discoveries: FileDiscovery[] = [];
  const jsonFiles: Array<{ path: string; content: unknown }> = [];
  const fallbackSearchResults: string[] = [];
  let queryResult: Record<string, unknown> | null = null;
  let error: string | null = null;

  // 초기 상태 캡처
  const claudeDirExists = existsSync(CLAUDE_DIR);
  let claudeDirContents: string[] = [];
  if (claudeDirExists) {
    try {
      claudeDirContents = readdirSync(CLAUDE_DIR);
    } catch {
      // ignore
    }
  }

  // 초기 파일 목록 (비교 기준)
  const baselineFiles = new Set<string>();
  for (const dir of WATCH_DIRS) {
    for (const f of walkDir(dir)) {
      baselineFiles.add(f);
    }
  }
  // ~/.claude 전체도 기준으로 캡처
  const baselineClaudeFiles = new Set(walkDir(CLAUDE_DIR));

  console.log(`[Setup] ~/.claude 존재: ${claudeDirExists}`);
  console.log(`[Setup] ~/.claude 내용: [${claudeDirContents.join(", ")}]`);
  console.log(`[Setup] 감시 대상: ${WATCH_DIRS.join(", ")}`);
  console.log(`[Setup] 기준 파일 수: teams/tasks=${baselineFiles.size}, ~/.claude 전체=${baselineClaudeFiles.size}`);

  // 2. Execute: query()와 폴링을 동시 실행
  const prompt = `너는 Agent Teams 기능을 사용해야 한다.

다음을 순서대로 수행해:
1. "poc-ipc-team"이라는 이름의 팀을 생성해 (TeamCreate)
2. 팀에 "observer"라는 teammate를 추가하고 "Hello라고 답해"라는 태스크를 줘
3. teammate에게 "상태 보고"라는 메시지를 보내
4. 30초 기다린 후 팀을 삭제해 (TeamDelete)

각 단계를 반드시 도구를 사용해서 수행해.`;

  console.log("\n[Execute] query() + 파일시스템 폴링 동시 시작...\n");

  let queryDone = false;
  let pollCount = 0;

  // 폴링 함수
  const pollFilesystem = async () => {
    while (!queryDone && Date.now() - start < TIMEOUT_MS) {
      pollCount++;
      const elapsed = Date.now() - start;

      // 감시 대상 디렉토리 체크
      for (const dir of WATCH_DIRS) {
        const currentFiles = walkDir(dir);
        for (const filePath of currentFiles) {
          if (!baselineFiles.has(filePath)) {
            // 새 파일 발견!
            baselineFiles.add(filePath);
            const isDir = existsSync(filePath) && statSync(filePath).isDirectory();
            const discovery: FileDiscovery = {
              timestamp: new Date().toISOString(),
              elapsedMs: elapsed,
              path: filePath,
              relativePath: relative(CLAUDE_DIR, filePath),
              type: isDir ? "directory" : "file",
            };

            if (!isDir) {
              try {
                discovery.size = statSync(filePath).size;
              } catch {
                // ignore
              }

              // JSON 파싱 시도
              if (filePath.endsWith(".json") || filePath.endsWith(".jsonl")) {
                const { content, error: parseError } = tryParseJsonFile(filePath);
                discovery.content = content;
                discovery.parseError = parseError;
                if (content) {
                  jsonFiles.push({ path: filePath, content });
                }
              }
            }

            discoveries.push(discovery);
            console.log(`[Poll #${pollCount}] 🆕 ${discovery.type} (${elapsed}ms): ${discovery.relativePath}`);
            if (discovery.content) {
              console.log(`  → JSON: ${JSON.stringify(discovery.content).substring(0, 100)}`);
            }
          }
        }
      }

      // ~/.claude 전체에서도 새 파일 체크 (5초 간격으로)
      if (pollCount % 10 === 0) {
        const currentClaudeFiles = walkDir(CLAUDE_DIR);
        for (const filePath of currentClaudeFiles) {
          if (!baselineClaudeFiles.has(filePath)) {
            baselineClaudeFiles.add(filePath);
            const isWatchDir = WATCH_DIRS.some((d) => filePath.startsWith(d));
            if (!isWatchDir) {
              // 감시 대상 외 경로에서 발견
              const relPath = relative(CLAUDE_DIR, filePath);
              console.log(`[Poll #${pollCount}] 📁 ~/.claude 새 파일 (${Date.now() - start}ms): ${relPath}`);
              fallbackSearchResults.push(filePath);
            }
          }
        }
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  // query 실행 함수
  const runQuery = async () => {
    try {
      const q = query({
        prompt,
        options: {
          model: "sonnet",
          maxTurns: 250,
          permissionMode: "bypassPermissions",
          settingSources: [],
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
          },
        },
      });

      for await (const msg of q) {
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
      queryDone = true;
    }
  };

  // 동시 실행
  await Promise.all([runQuery(), pollFilesystem()]);

  // 마지막 한번 더 폴링 (query 종료 직후)
  await new Promise((r) => setTimeout(r, 1000));
  for (const dir of WATCH_DIRS) {
    for (const filePath of walkDir(dir)) {
      if (!baselineFiles.has(filePath)) {
        baselineFiles.add(filePath);
        const isDir = existsSync(filePath) && statSync(filePath).isDirectory();
        const discovery: FileDiscovery = {
          timestamp: new Date().toISOString(),
          elapsedMs: Date.now() - start,
          path: filePath,
          relativePath: relative(CLAUDE_DIR, filePath),
          type: isDir ? "directory" : "file",
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

  // 3. Analyze
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

  // 4. Dump
  const report: P3Report = {
    testId: "P3",
    testName: "디스크 기반 IPC 확인",
    timestamp: new Date().toISOString(),
    durationMs,
    result: pass ? "PASS" : "FAIL",
    criteria,
    watchDirs: WATCH_DIRS,
    claudeDirExists,
    claudeDirContents,
    discoveries,
    jsonFiles,
    fallbackSearchResults,
    queryResult,
    error,
    nextStep: pass
      ? "P3 PASS → 디스크 폴링 감시 가능. P2-3 FAIL 시 대안으로 사용"
      : fallbackSearchResults.length > 0
        ? "감시 경로가 다름. fallbackSearchResults의 경로 확인 후 재시도"
        : "파일 미발견. Agent Teams 완전 제거 → 독립 query() + LanceDB 통신으로 전환",
  };

  writeFileSync("results/p3-disk-findings.json", JSON.stringify(report, null, 2));

  // 5. 결론 출력
  console.log("\n" + "=".repeat(60));
  console.log(`P3: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(60));
  console.log(`소요 시간: ${durationMs}ms`);
  console.log(`폴링 횟수: ${pollCount}`);
  console.log(`발견된 파일/디렉토리: ${discoveries.length}개`);
  console.log(`JSON 파싱 성공: ${jsonFiles.length}개`);
  console.log(`~/.claude 기타 새 파일: ${fallbackSearchResults.length}개`);
  console.log("");
  console.log(`팀 디렉토리 발견: ${criteria.teamDirectoryFound ? "✅" : "❌"}`);
  console.log(`파일 발견: ${criteria.anyFileFound ? "✅" : "❌"}`);
  console.log(`JSON 파싱 가능: ${criteria.jsonParseable ? "✅" : "❌"}`);
  console.log(`inbox 구조 발견: ${criteria.inboxStructureFound ? "✅" : "❌"}`);

  if (discoveries.length > 0) {
    console.log("\n[발견된 항목]");
    for (const d of discoveries) {
      console.log(`  ${d.elapsedMs}ms | ${d.type} | ${d.relativePath}${d.size !== undefined ? ` (${d.size}B)` : ""}`);
    }
  }

  if (jsonFiles.length > 0) {
    console.log("\n[파싱된 JSON 내용]");
    for (const j of jsonFiles) {
      console.log(`  ${relative(CLAUDE_DIR, j.path)}:`);
      console.log(`    ${JSON.stringify(j.content).substring(0, 200)}`);
    }
  }

  if (error) console.log(`\n에러: ${error}`);
  console.log(`\n다음 단계: ${report.nextStep}`);
  console.log(`결과 파일: results/p3-disk-findings.json`);
}

main();
