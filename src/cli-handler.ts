import * as child_process from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { WebSocketServer } from "./websocket-server";
import * as vscode from "vscode";
import { CONFIG } from "./config";
import {
  sanitizeMobileAssistantText,
  shouldApplyMobilePrompt,
  wrapPromptForMobileChannel,
} from "./mobile-prompt";
import { resolveCliRunKey } from "./cli-run-key";

function entryTimeMs(entry: ChatHistoryEntry): number {
  const t = Date.parse(entry.timestamp || "");
  if (!Number.isNaN(t)) return t;
  const n = parseInt(String(entry.id).split("-")[0], 10);
  return Number.isNaN(n) ? 0 : n;
}

interface ChatHistoryEntry {
  id: string;
  sessionId: string;
  clientId: string;
  userMessage: string;
  assistantResponse: string;
  timestamp: string;
  agentMode?: string; // 에이전트 모드 (agent, ask, plan, debug, auto)
  relaySessionId?: string; // 릴레이 모드일 때 릴레이 세션 ID
}

interface ChatHistory {
  entries: ChatHistoryEntry[];
  lastUpdated: string;
}

/** Mobil yedek silme isteği — asla geçmişe kaydedilmemeli (eski extension hatası). */
const REMOTE_DELETE_MSG_PREFIX = "__REMOTE_DELETE_SESSION__:";

export class CLIHandler {
  private outputChannel: vscode.OutputChannel | null = null;
  private wsServer: WebSocketServer | null = null;
  private currentProcess: child_process.ChildProcess | null = null;
  /** Oturum başına paralel CLI (runKey → process). */
  private processesByRunKey: Map<string, child_process.ChildProcess> =
    new Map();
  private workspaceRoot: string | null = null;
  private processingOutput: boolean = false;
  private lastChatId: string | null = null; // 마지막 채팅 세션 ID (대화형 모드 테스트용)
  private clientSessions: Map<string, string> = new Map(); // 클라이언트별 세션 ID 관리
  private chatHistoryFile: string | null = null; // 대화 히스토리 파일 경로
  private pendingHistoryIds: Map<string, string> = new Map(); // clientId -> pending sessionId (실제 sessionId로 업데이트용)
  private streamingBuffers: Map<string, string> = new Map(); // clientId -> stdout buffer (스트리밍용)
  private lastStreamedText: Map<string, string> = new Map(); // clientId -> 마지막으로 전송한 텍스트 (중복 제거용)
  private lastPromptByClient: Map<string, string> = new Map(); // clientId -> 마지막으로 실행한 프롬프트 (IME 중복 방지용)
  /** Son gönderilen insert_text hangi mobil sessionId için (cevap yönlendirme). */
  private promptSessionByClient: Map<string, string> = new Map();
  private currentSenderDeviceId: string | null = null; // 유니캐스트 응답용 - 현재 요청을 보낸 모바일 디바이스 ID
  private currentReplyChannel: string | null = null;
  private getRelaySessionId: (() => string | null) | null = null; // 릴레이 세션 ID 조회 (저장 시 사용)

  constructor(
    outputChannel?: vscode.OutputChannel,
    wsServer?: WebSocketServer,
    workspaceRoot?: string
  ) {
    this.outputChannel = outputChannel || null;
    this.wsServer = wsServer || null;
    this.workspaceRoot = workspaceRoot || null;

    // 대화 히스토리 파일 경로 설정 (워크스페이스가 없거나 루트(/)면 스킵 - F5 테스트 시 ENOENT 방지)
    const safeWorkspaceRoot =
      workspaceRoot && workspaceRoot !== "/" && workspaceRoot.length > 1;
    if (safeWorkspaceRoot) {
      const cursorDir = path.join(workspaceRoot, ".cursor");
      if (!fs.existsSync(cursorDir)) {
        fs.mkdirSync(cursorDir, { recursive: true });
      }
      this.chatHistoryFile = path.join(cursorDir, "CHAT_HISTORY.json");
    }
  }

  /** 릴레이 모드일 때 저장되는 히스토리에 relaySessionId를 넣기 위한 getter 설정 */
  setGetRelaySessionId(getter: () => string | null): void {
    this.getRelaySessionId = getter;
  }

  private log(message: string, sendToClient: boolean = false) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] [CLI] ${message}`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    console.log(logMessage);

    // 중요 로그는 클라이언트에게 전송
    if (sendToClient && this.wsServer) {
      this.wsServer.broadcast(
        JSON.stringify({
          type: "log",
          level: "info",
          message: `[CLI] ${message}`,
          timestamp: new Date().toISOString(),
          source: "cli",
        })
      );
    }
  }

  private logError(message: string, error?: any, sendToClient: boolean = true) {
    const timestamp = new Date().toLocaleTimeString();
    const errorStr =
      error instanceof Error ? error.message : String(error || "");
    const logMessage = `[${timestamp}] [CLI] ERROR: ${message}${
      errorStr ? ` - ${errorStr}` : ""
    }`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    console.error(logMessage);

    // 에러는 기본적으로 클라이언트에게 전송
    if (sendToClient && this.wsServer) {
      this.wsServer.broadcast(
        JSON.stringify({
          type: "log",
          level: "error",
          message: `[CLI] ${message}`,
          timestamp: new Date().toISOString(),
          source: "cli",
          error: errorStr,
        })
      );
    }
  }

  private getCliCandidatePaths(): string[] {
    const homeDir = os.homedir();
    if (process.platform === "win32") {
      const localAppData =
        process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
      return [
        path.join(localAppData, "cursor-agent", "agent.cmd"),
        path.join(localAppData, "cursor-agent", "cursor-agent.cmd"),
        path.join(localAppData, "cursor-agent", "agent.exe"),
        path.join(localAppData, "cursor-agent", "cursor-agent.exe"),
      ];
    }
    return [
      path.join(homeDir, ".local", "bin", "agent"),
      path.join(homeDir, ".local", "bin", "cursor-agent"),
      path.join(
        homeDir,
        "Library",
        "Application Support",
        "Cursor",
        "bin",
        "agent"
      ),
      path.join(
        homeDir,
        "Library",
        "Application Support",
        "Cursor",
        "bin",
        "cursor-agent"
      ),
    ];
  }

  private findExistingCliPath(): string | null {
    for (const cliPath of this.getCliCandidatePaths()) {
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    }
    return null;
  }

  private execWhich(command: string): Promise<string | null> {
    const whichCmd =
      process.platform === "win32" ? `where ${command}` : `which ${command}`;
    return new Promise((resolve) => {
      child_process.exec(whichCmd, (error: Error | null, stdout: string) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        const first = stdout
          .trim()
          .split(/\r?\n/)
          .map((line: string) => line.trim())
          .find((line: string) => line.length > 0);
        resolve(first ?? null);
      });
    });
  }

  /**
   * Cursor CLI가 설치되어 있는지 확인
   */
  private async checkCLIInstalled(): Promise<boolean> {
    if (this.findExistingCliPath()) {
      return true;
    }
    const agent = await this.execWhich("agent");
    if (agent) {
      return true;
    }
    const cursorAgent = await this.execWhich("cursor-agent");
    return cursorAgent !== null;
  }

  /**
   * Cursor CLI 명령어 경로 찾기
   */
  private async findCLICommand(): Promise<string> {
    const existing = this.findExistingCliPath();
    if (existing) {
      return existing;
    }
    const agent = await this.execWhich("agent");
    if (agent) {
      return agent;
    }
    const cursorAgent = await this.execWhich("cursor-agent");
    if (cursorAgent) {
      return cursorAgent;
    }
    return process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA || "",
          "cursor-agent",
          "agent.cmd"
        )
      : "agent";
  }

  /** Windows: .cmd/.bat doğrudan spawn EINVAL verir — cmd.exe /c kullan. */
  private resolveSpawn(
    cliCommand: string,
    args: string[]
  ): { command: string; args: string[]; shell: boolean } {
    if (process.platform === "win32") {
      const ext = path.extname(cliCommand).toLowerCase();
      if (ext === ".cmd" || ext === ".bat") {
        return {
          command: process.env.ComSpec || "cmd.exe",
          args: ["/d", "/c", cliCommand, ...args],
          shell: false,
        };
      }
    }
    return { command: cliCommand, args, shell: false };
  }

  /** Cursor Edit → Fast: composer-2.5-fast vs composer-2.5 */
  private resolveComposerCliModel(composerUseFast?: boolean): string {
    if (composerUseFast === true) {
      return "composer-2.5-fast";
    }
    if (composerUseFast === false) {
      return "composer-2.5";
    }
    const fromConfig = vscode.workspace
      .getConfiguration("cursorRemote")
      .get<boolean>("composerUseFast");
    return fromConfig === true ? "composer-2.5-fast" : "composer-2.5";
  }

  private resolveWorkingDirectory(): string {
    const tryDir = (dir: string | null | undefined): string | null => {
      if (!dir) {
        return null;
      }
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          return dir;
        }
      } catch {
        // ignore
      }
      return null;
    };

    const fromRoot = tryDir(this.workspaceRoot);
    if (fromRoot) {
      return fromRoot;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const fromWorkspace = tryDir(folders[0].uri.fsPath);
      if (fromWorkspace) {
        return fromWorkspace;
      }
    }

    return process.cwd();
  }

  /**
   * Cursor CLI에 프롬프트 전송
   * @param text 프롬프트 텍스트
   * @param execute 실행 여부
   * @param clientId 클라이언트 ID (세션 격리용, 선택사항)
   * @param newSession 새 세션 시작 여부 (클라이언트에서 결정, 기본값: false)
   * @param agentMode 에이전트 모드 (agent, ask, plan, debug, auto)
   * @param senderDeviceId 릴레이 모드에서 요청을 보낸 모바일 디바이스 ID (유니캐스트 응답용)
   * @param resumeSessionId 모바일에서 seçilen agent oturum (--resume)
   */
  async sendPrompt(
    text: string,
    execute: boolean = true,
    clientId?: string,
    newSession: boolean = false,
    agentMode: "agent" | "ask" | "plan" | "debug" | "auto" = "auto",
    senderDeviceId?: string,
    resumeSessionId?: string,
    replyChannel?: string,
    composerUseFast?: boolean
  ): Promise<void> {
    // 유니캐스트 응답용 디바이스 ID 저장
    this.currentSenderDeviceId = senderDeviceId || null;
    this.currentReplyChannel = replyChannel || null;

    this.log(
      `sendPrompt called - textLength: ${
        text.length
      }, execute: ${execute}, clientId: ${
        clientId || "none"
      }, newSession: ${newSession}, senderDeviceId: ${senderDeviceId || "none"}`
    );

    // IME 중복 단일 문자 무시: 이미 실행 중인 프로세스가 있고, 새 프롬프트가 1글자이며
    // 마지막 프롬프트가 그 글자로 끝나면 무시 (릴레이 모드 응답 유지)
    if (this.processesByRunKey.size > 0 && text.length === 1) {
      const key = clientId || "global";
      const lastPrompt = this.lastPromptByClient.get(key);
      if (lastPrompt && lastPrompt.endsWith(text)) {
        this.log(
          `Skipping IME duplicate single character "${text}" to preserve ongoing response`
        );
        return;
      }
    }

    // 에이전트 모드 설정 (히스토리 저장 및 CLI 실행에 사용)
    let selectedMode: string = "agent"; // 기본값
    if (agentMode && agentMode !== "auto") {
      selectedMode = agentMode;
    } else if (agentMode === "auto") {
      // 자동 모드: 텍스트 내용을 분석하여 적절한 모드 선택
      const autoMode = this.detectAgentMode(text);
      selectedMode = autoMode || "agent"; // 기본 Agent 모드
    }

    // Yeni oturum: eski CLI thread id geçmişe ve cevaba karışmasın.
    if (newSession && clientId) {
      this.clientSessions.delete(clientId);
      this.promptSessionByClient.delete(clientId);
      this.pendingHistoryIds.delete(clientId);
      this.log(
        `🆕 newSession — cleared client session maps for ${clientId}`
      );
    }

    // Mobil seçili oturum önce clientSessions'a yazılsın (geçmiş + --resume tutarlı)
    if (!newSession && resumeSessionId && clientId) {
      this.clientSessions.set(clientId, resumeSessionId);
      this.promptSessionByClient.set(clientId, resumeSessionId);
      this.log(
        `Using mobile-selected session for client ${clientId}: ${resumeSessionId}`
      );
    }

    // 대화 히스토리 저장 (사용자 메시지 전송 시)
    // 세션 ID는 나중에 응답에서 받을 수 있으므로, 임시로 저장
    // 주의: newSession이 true면 기존 세션을 무시하므로 히스토리도 새로 시작
    if (clientId) {
      const currentSessionId = newSession
        ? null
        : resumeSessionId || this.clientSessions.get(clientId) || null;
      const pendingId = `pending-${Date.now()}-${Math.random()
        .toString(36)
        .substring(7)}`; // 고유한 임시 ID 사용
      this.log(
        `💾 Saving user message - sessionId: ${
          currentSessionId || pendingId
        }, clientId: ${clientId}, newSession: ${newSession}, agentMode: ${selectedMode}`
      );
      this.log(
        `💾 sendPrompt agentMode param: ${agentMode}, selectedMode: ${selectedMode}`
      );
      const historySid = currentSessionId || pendingId;
      this.saveChatHistoryEntry({
        sessionId: historySid,
        clientId: clientId,
        userMessage: text,
        timestamp: new Date().toISOString(),
        agentMode: selectedMode,
      });
      // Cevap kaydı bu gönderime bağlansın (pending dahil).
      this.promptSessionByClient.set(clientId, historySid);
      // pending ID를 저장하여 나중에 실제 sessionId로 업데이트할 수 있도록
      if (!currentSessionId) {
        this.pendingHistoryIds.set(clientId, pendingId);
        this.log(
          `💾 Saved pending history ID: ${pendingId} for client ${clientId}`
        );
      }
    }

    try {
      // CLI 설치 확인
      const isInstalled = await this.checkCLIInstalled();
      if (!isInstalled) {
        throw new Error(
          "Cursor CLI (agent)가 설치되어 있지 않습니다. https://cursor.com/cli 에서 설치하세요."
        );
      }

      const cliCommand = await this.findCLICommand();
      this.log(`Using CLI command: ${cliCommand}`);

      const runKey = resolveCliRunKey(clientId, resumeSessionId, newSession);
      const previousProcess = this.processesByRunKey.get(runKey);
      if (previousProcess) {
        this.log(`Stopping previous CLI process for run ${runKey}`);
        this.processesByRunKey.delete(runKey);
        this.streamingBuffers.delete(runKey);
        this.lastStreamedText.delete(runKey);
        if (this.currentProcess === previousProcess) {
          this.currentProcess = null;
        }

        previousProcess.kill("SIGTERM");

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (!previousProcess.killed) {
              previousProcess.kill("SIGKILL");
            }
            resolve();
          }, 2000);

          previousProcess.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        this.log(`Previous CLI process stopped (${runKey})`);
      }

      // Cursor CLI 실행
      // 스트리밍을 위해 --output-format stream-json과 --stream-partial-output 사용
      // --force: 자동 실행 (승인 없이)
      const args: string[] = [];

      // 클라이언트에서 새 세션 시작 여부 결정
      if (newSession) {
        // 클라이언트가 명시적으로 새 세션을 요청한 경우
        this.log(
          `Starting new session (client requested) for client ${
            clientId || "global"
          }`
        );
      } else {
        // 기존 세션 재개 시도 (clientSessions sendPrompt başında güncellendi)
        let sessionId: string | null = null;
        if (clientId) {
          sessionId = this.clientSessions.get(clientId) || null;
        } else {
          // clientId가 없으면 전역 세션 사용 (하위 호환성)
          sessionId = this.lastChatId;
        }

        if (sessionId) {
          args.push("--resume", sessionId);
          this.log(
            `Resuming chat session for client ${
              clientId || "global"
            }: ${sessionId}`
          );
        } else {
          // 세션이 없으면 새로 시작
          this.log(
            `Starting new chat session for client ${
              clientId || "global"
            } (no existing session)`
          );
        }
      }

      // CLI에는 plan/ask만 전달. debug는 CLI가 지원하지 않으므로 agent로 대체해 전달하지 않음
      const cliMode = selectedMode === "debug" ? "agent" : selectedMode;
      const cliAllowedModes = ["plan", "ask"];
      if (cliMode && cliAllowedModes.includes(cliMode)) {
        args.push("--mode", cliMode);
        this.log(`Using agent mode for CLI: ${cliMode}`);
      } else {
        this.log(
          `CLI: no --mode (display mode=${selectedMode}, cliMode=${cliMode})`
        );
      }

      const cliModel = this.resolveComposerCliModel(composerUseFast);
      args.push("--model", cliModel);
      this.log(`CLI Composer model: ${cliModel}`, true);

      // 선택된 모드를 사용자에게 알림 (로그를 통해, 표시용으로는 selectedMode 유지)
      const modeDisplayName = this.getModeDisplayName(selectedMode);
      this.log(`🤖 Agent Mode: ${modeDisplayName} (${selectedMode})`, true);

      // 자동 모드로 선택된 경우, 실제 선택된 모드를 모바일 앱에 전송
      if (agentMode === "auto" && this.wsServer) {
        this.wsServer.send(
          JSON.stringify({
            type: "agent_mode_selected",
            requestedMode: "auto",
            actualMode: selectedMode,
            displayName: modeDisplayName,
            timestamp: new Date().toISOString(),
          })
        );
      }

      // 스트리밍 지원: stream-json 형식과 부분 출력 스트리밍 활성화
      // -p: 비대화형 모드 (--stream-partial-output과 함께 사용)
      // --output-format stream-json: 스트리밍 JSON 형식
      // --stream-partial-output: 부분 출력 스트리밍
      const cliPromptText = wrapPromptForMobileChannel(text, replyChannel, {
        newSession,
        clientId,
      });
      if (cliPromptText !== text) {
        this.log(
          `📱 Mobile remote context applied (newSession=${newSession}, clientId=${
            clientId || "none"
          })`
        );
      }

      // Prompt argv'de değil stdin'de: Windows cmd.exe çok satırlı argümanı ilk satırda keser.
      args.push(
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force"
      );

      this.log(`Executing CLI command...`, true);

      const cwd = this.resolveWorkingDirectory();
      const spawnSpec = this.resolveSpawn(cliCommand, args);
      this.log(
        `CLI spawn: ${spawnSpec.command} (cwd: ${cwd}, args: ${spawnSpec.args.length}, promptChars: ${cliPromptText.length})`,
        true
      );

      // stdout 버퍼링 최소화를 위한 환경 변수 설정
      const env = {
        ...process.env,
        PYTHONUNBUFFERED: "1", // Python 스크립트 버퍼링 비활성화 (만약 사용하는 경우)
        NODE_NO_WARNINGS: "1",
      };

      const proc = child_process.spawn(
        spawnSpec.command,
        spawnSpec.args,
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          shell: spawnSpec.shell,
          env: env,
          windowsHide: true,
        }
      );

      this.processesByRunKey.set(runKey, proc);
      this.currentProcess = proc;
      if (proc.stdin) {
        proc.stdin.setDefaultEncoding("utf8");
        proc.stdin.write(cliPromptText);
        proc.stdin.end();
      } else {
        this.logError("CLI stdin unavailable — prompt not delivered");
      }

      this.log(`CLI process started`, true);
      this.log(
        `CLI process stdout: ${this.currentProcess.stdout ? "exists" : "null"}`
      );
      this.log(
        `CLI process stderr: ${this.currentProcess.stderr ? "exists" : "null"}`
      );

      let stdout = "";
      let stderr = "";
      let stdoutEnded = false;
      let stderrEnded = false;
      let processClosed = false;

      const currentClientId = clientId;
      const streamKey = runKey;

      // IME 중복 판별용: 이번에 실행한 프롬프트 저장
      this.lastPromptByClient.set(clientId || "global", text);

      // 디버깅: clientId가 제대로 전달되는지 로그
      if (clientId) {
        this.log(`🔑 Using clientId: ${clientId} for this prompt`);
        const existingSession = this.clientSessions.get(clientId);
        if (existingSession) {
          this.log(
            `🔑 Found existing session for client ${clientId}: ${existingSession}`
          );
        } else {
          this.log(
            `🔑 No existing session for client ${clientId}, will create new session`
          );
        }
      } else {
        this.log(
          `⚠️ No clientId provided, using global session (lastChatId: ${
            this.lastChatId || "none"
          })`
        );
      }

      // stdout 수집 및 실시간 스트리밍
      if (proc.stdout) {
        proc.stdout.setEncoding("utf8");

        this.streamingBuffers.set(streamKey, "");
        this.lastStreamedText.set(streamKey, "");

        proc.stdout.on("data", (data: Buffer | string) => {
          const chunk = typeof data === "string" ? data : data.toString();
          stdout += chunk;
          this.log(
            `CLI stdout chunk (${chunk.length} bytes): ${chunk.substring(
              0,
              200
            )}${chunk.length > 200 ? "..." : ""}`
          );
          if (currentClientId) {
            this.processStreamingChunk(chunk, streamKey, currentClientId);
          }
        });

        proc.stdout.on("end", () => {
          this.log("CLI stdout stream ended");
          stdoutEnded = true;

          if (currentClientId && this.wsServer) {
            const accumulated = this.lastStreamedText.get(streamKey) || "";
            const currentSessionId =
              this.clientSessions.get(currentClientId) || undefined;
            const completeMessage = {
              type: "chat_response_complete",
              text: accumulated,
              fullText: accumulated,
              timestamp: new Date().toISOString(),
              clientId: currentClientId,
              sessionId: currentSessionId,
              source: "cli",
            };
            this.wsServer.send(JSON.stringify(completeMessage));
            this.log(
              `✅ Streaming complete (${accumulated.length} chars) sent`
            );

            this.streamingBuffers.delete(streamKey);
            this.lastStreamedText.delete(streamKey);
          }

          if (processClosed) {
            this.checkAndProcessOutput(stdout, stderr, currentClientId);
          }
        });

        proc.stdout.on("error", (error) => {
          this.logError("CLI stdout stream error", error);
        });
      } else {
        this.logError("⚠️ CLI process stdout is null");
      }

      if (proc.stderr) {
        proc.stderr.setEncoding("utf8");

        proc.stderr.on("data", (data: Buffer | string) => {
          const chunk = typeof data === "string" ? data : data.toString();
          stderr += chunk;
          this.logError(
            `CLI stderr chunk (${chunk.length} bytes): ${chunk.substring(
              0,
              200
            )}${chunk.length > 200 ? "..." : ""}`
          );
        });

        proc.stderr.on("end", () => {
          this.log("CLI stderr stream ended");
          stderrEnded = true;
          if (processClosed) {
            this.checkAndProcessOutput(stdout, stderr, currentClientId);
          }
        });

        proc.stderr.on("error", (error) => {
          this.logError("CLI stderr stream error", error);
        });
      } else {
        this.logError("⚠️ CLI process stderr is null");
      }

      proc.on("error", (error) => {
        this.logError("CLI process spawn error", error);
        this.processesByRunKey.delete(runKey);
        if (this.currentProcess === proc) {
          this.currentProcess = null;
        }

        if (this.wsServer) {
          this.wsServer.send(
            JSON.stringify({
              type: "error",
              message: `CLI 실행 실패: ${error.message}`,
              timestamp: new Date().toISOString(),
            })
          );
        }
      });

      proc.on("close", (code, signal) => {
        this.log(
          `CLI process exited (${runKey}) code ${code}, signal: ${signal || "none"}`
        );
        this.log(
          `Final stdout length: ${stdout.length}, stderr length: ${stderr.length}`
        );
        this.log(`stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);

        processClosed = true;
        this.processesByRunKey.delete(runKey);
        if (this.currentProcess === proc) {
          this.currentProcess = null;
        }

        if (stdout.length === 0 && stderr.length === 0) {
          this.logError("⚠️ No output received from CLI process");
          this.logError(
            "⚠️ This might indicate the process was killed or did not produce output"
          );
        }

        this.checkAndProcessOutput(stdout, stderr, currentClientId);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError(`Error in sendPrompt: ${errorMsg}`);
      throw new Error(`CLI 프롬프트 전송 실패: ${errorMsg}`);
    }
  }

  /**
   * CLI 출력 처리 및 WebSocket으로 전송
   * @param clientId 클라이언트 ID (세션 격리용, 선택사항)
   */
  private checkAndProcessOutput(
    stdout: string,
    stderr: string,
    clientId?: string
  ) {
    // 중복 처리 방지
    if (this.processingOutput) {
      this.log(
        "⚠️ Output processing already in progress, skipping duplicate call"
      );
      return;
    }
    this.processingOutput = true;

    this.log(
      `Processing output - stdout length: ${stdout.length}, stderr length: ${stderr.length}`
    );

    // 일반 텍스트 출력 처리 (JSON 형식 사용 안 함, 스트리밍용)
    try {
      if (stdout.length > 0) {
        this.log(`CLI stdout content: ${stdout.substring(0, 500)}`);
      }

      // stream-json 형식: 여러 JSON 라인이 있을 수 있음
      // 각 라인을 파싱하여 result 타입의 최종 결과 추출
      let responseText = "";
      let extractedSessionId: string | null = null;

      // 각 라인을 파싱하여 result 타입 찾기
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);

      for (const line of lines) {
        try {
          const jsonData = JSON.parse(line.trim());

          // session_id 추출
          const sessionId =
            jsonData.session_id ||
            jsonData.sessionId ||
            jsonData.chatId ||
            jsonData.chat_id;
          if (sessionId && !extractedSessionId) {
            extractedSessionId = sessionId;
          }

          // result 타입: 최종 결과
          if (jsonData.type === "result" && jsonData.result) {
            if (typeof jsonData.result === "string") {
              responseText = jsonData.result;
            }
          }
          // assistant 타입: 스트리밍이 이미 완료되었으므로 무시
          // (스트리밍이 작동했다면 이미 전송됨)
        } catch (e) {
          // JSON 파싱 실패 시 해당 라인 무시
          continue;
        }
      }

      // result 타입을 찾지 못한 경우, 스트리밍된 텍스트 사용
      if (!responseText && clientId) {
        responseText = this.lastStreamedText.get(clientId) || "";
      }

      // 여전히 없으면 전체 stdout 사용 (하위 호환성)
      if (!responseText) {
        responseText = stdout.trim();
      }
      // CLI 에러 시 stderr를 사용자에게 전달 (응답이 비어 있을 때)
      if (!responseText && stderr.trim()) {
        responseText = `[CLI Error]\n${stderr.trim()}`;
        this.log(
          `Using stderr as response (CLI failed): ${stderr.substring(0, 100)}`
        );
      }

      // session_id 저장 (JSON에서 추출한 경우)
      if (extractedSessionId) {
        const mobileBound = clientId
          ? this.promptSessionByClient.get(clientId)
          : undefined;
        if (clientId) {
          if (!mobileBound) {
            this.clientSessions.set(clientId, extractedSessionId);
            this.log(
              `💾 Saved session ID for client ${clientId}: ${extractedSessionId}`
            );
          } else if (mobileBound !== extractedSessionId) {
            this.log(
              `⚠ CLI session ${extractedSessionId} ≠ mobile ${mobileBound} — clientSessions mobilde kalır`
            );
          }
        } else {
          this.lastChatId = extractedSessionId;
          this.log(`💾 Saved global session ID: ${extractedSessionId}`);
        }
      }

      this.log(`Extracted response text length: ${responseText.length}`);
      if (!responseText && clientId === "relay-client") {
        this.log(
          `⚠️ Relay mode: no responseText (stdout length: ${stdout.length}, stderr length: ${stderr.length}) - sending fallback message`
        );
        responseText =
          stdout.length > 0
            ? stdout.trim().substring(0, 2000) || "[CLI 출력이 비어 있습니다.]"
            : stderr.length > 0
            ? `[CLI stderr]\n${stderr.trim().substring(0, 1000)}`
            : "[응답이 비어 있습니다. CLI가 출력을 반환하지 않았을 수 있습니다.]";
      }

      if (
        clientId &&
        shouldApplyMobilePrompt(this.currentReplyChannel || undefined, clientId)
      ) {
        responseText = sanitizeMobileAssistantText(responseText);
      }

      // Mobil seçili oturum öncelikli (CLI thread id geçmişi karıştırmasın).
      const mobilePromptSid = clientId
        ? this.promptSessionByClient.get(clientId)
        : undefined;
      const pendingSid = clientId
        ? this.pendingHistoryIds.get(clientId)
        : undefined;
      const clientSid = clientId ? this.clientSessions.get(clientId) : undefined;
      const currentSessionId =
        mobilePromptSid ||
        pendingSid ||
        clientSid ||
        extractedSessionId ||
        this.lastChatId ||
        null;
      if (
        extractedSessionId &&
        mobilePromptSid &&
        extractedSessionId !== mobilePromptSid
      ) {
        this.log(
          `⚠ session mismatch mobile=${mobilePromptSid} cli=${extractedSessionId} → kayıt mobil`
        );
      }
      if (clientId) {
        const sessionIdToUse =
          currentSessionId ||
          this.pendingHistoryIds.get(clientId) ||
          "unknown";
        this.log(
          `💾 Saving assistant response - sessionId: ${sessionIdToUse}, clientId: ${clientId}, hasPendingId: ${this.pendingHistoryIds.has(
            clientId
          )}`
        );
        this.saveChatHistoryEntry({
          sessionId: sessionIdToUse,
          clientId: clientId,
          assistantResponse: responseText,
          timestamp: new Date().toISOString(),
        });

        // pending ID가 있었고 실제 sessionId를 받았으면 업데이트
        if (extractedSessionId && this.pendingHistoryIds.has(clientId)) {
          const pendingId = this.pendingHistoryIds.get(clientId)!;
          this.log(
            `💾 Updating pending sessionId ${pendingId} to ${extractedSessionId}`
          );
          this.updatePendingSessionId(clientId, pendingId, extractedSessionId);
          this.pendingHistoryIds.delete(clientId);
          this.promptSessionByClient.set(clientId, extractedSessionId);
          this.clientSessions.set(clientId, extractedSessionId);
        }
      }

      // WebSocket으로 최종 응답 전송
      // Relay 모드에서는 chat_response_chunk를 보내지 않으므로, 최종 chat_response는 항상 전송해야 함.
      // 로컬만 쓸 때도 스트리밍 후 최종 메시지를 보내면 앱이 덮어쓰기/완료 처리 가능.
      if (this.wsServer && responseText) {
        const responseMessage = {
          type: "chat_response",
          text: responseText,
          timestamp: new Date().toISOString(),
          source: "cli",
          sessionId: currentSessionId || undefined,
          clientId: clientId || undefined,
          targetDeviceId: this.currentSenderDeviceId || undefined, // 유니캐스트 응답용
        };

        this.log(
          `Sending chat_response: ${JSON.stringify(responseMessage).substring(
            0,
            200
          )}`
        );
        if (currentSessionId) {
          this.log(
            `   Session ID: ${currentSessionId}, Client ID: ${
              clientId || "none"
            }`
          );
        }
        if (clientId === "relay-client") {
          this.log(
            `📤 Relay mode: sending chat_response (${responseText.length} chars) to wsServer`
          );
        }
        this.wsServer.send(JSON.stringify(responseMessage));
        this.log("✅ AI response received", true);
      } else if (this.wsServer && !responseText) {
        this.logError(
          "wsServer is null or responseText is empty (no stdout/stderr to send)"
        );
      }
    } catch (error) {
      // 에러 발생 시 전체 출력을 텍스트로 전송
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError(`Output processing error: ${errorMsg}`);
      this.logError(`stdout: ${stdout.substring(0, 500)}`);

      if (this.wsServer) {
        const fallbackSessionId = clientId
          ? this.promptSessionByClient.get(clientId) ||
            this.pendingHistoryIds.get(clientId) ||
            this.clientSessions.get(clientId) ||
            undefined
          : this.lastChatId || undefined;
        const responseMessage = {
          type: "chat_response",
          text: stdout || stderr || "CLI 실행 완료",
          timestamp: new Date().toISOString(),
          source: "cli",
          sessionId: fallbackSessionId,
          clientId: clientId || undefined,
          targetDeviceId: this.currentSenderDeviceId || undefined, // 유니캐스트 응답용
        };

        this.log(
          `Sending chat_response (fallback): ${JSON.stringify(
            responseMessage
          ).substring(0, 200)}`
        );
        this.wsServer.send(JSON.stringify(responseMessage));
        this.log("✅ Chat response sent to WebSocket (fallback)");
      }
    } finally {
      this.processingOutput = false;
      this.currentSenderDeviceId = null; // 응답 완료 후 초기화
      this.currentReplyChannel = null;
    }
  }

  private isMobileProgressContext(clientId: string): boolean {
    return shouldApplyMobilePrompt(
      this.currentReplyChannel || undefined,
      clientId
    );
  }

  /**
   * 실시간 스트리밍 청크 처리
   * stream-json 형식: 각 델타가 JSON으로 출력됨
   * - thinking 타입: 내부 사고 과정 (스트리밍하지 않음)
   * - assistant 타입: 실제 응답 텍스트 (스트리밍)
   * - result 타입: 최종 결과 (스트리밍 완료 시 사용)
   */
  private lastProgressAtByClient: Map<string, number> = new Map();

  private emitAgentProgress(
    clientId: string,
    phase: string,
    summary: string
  ): void {
    const mobile = this.isMobileProgressContext(clientId);
    // Telefonda yalnızca todo özeti; thinking/tool satırı spam yapar.
    if (mobile && phase !== "todo") {
      return;
    }
    const text = summary.replace(/\s+/g, " ").trim();
    if (!text || !this.wsServer) {
      return;
    }
    const now = Date.now();
    const last = this.lastProgressAtByClient.get(clientId) || 0;
    const minGap = mobile ? 5000 : 800;
    if (now - last < minGap) {
      return;
    }
    this.lastProgressAtByClient.set(clientId, now);
    this.wsServer.send(
      JSON.stringify({
        type: "agent_progress",
        phase,
        summary: text.length > 200 ? `${text.substring(0, 200)}…` : text,
        clientId,
        source: "cli",
      })
    );
  }

  private extractThinkingSnippet(jsonData: any): string {
    const message = jsonData.message;
    if (message?.content && Array.isArray(message.content)) {
      for (const content of message.content) {
        if (content.type === "text" && content.text) {
          return String(content.text);
        }
      }
    }
    if (typeof jsonData.text === "string") {
      return jsonData.text;
    }
    return "";
  }

  private processStreamingChunk(
    buffer: string,
    streamKey: string,
    clientId: string
  ) {
    try {
      // stream-json 형식: 각 라인이 JSON 델타일 수 있음
      // 버퍼를 라인 단위로 분리하여 각 JSON 델타 처리
      const lines = buffer.split("\n").filter((line) => line.trim().length > 0);

      let accumulatedText = this.lastStreamedText.get(streamKey) || "";
      let hasNewData = false;

      for (const line of lines) {
        try {
          // JSON 델타 파싱 시도
          const jsonData = JSON.parse(line.trim());

          // session_id 추출 (있는 경우)
          const extractedSessionId =
            jsonData.session_id ||
            jsonData.sessionId ||
            jsonData.chatId ||
            jsonData.chat_id;
          if (extractedSessionId && clientId) {
            this.clientSessions.set(clientId, extractedSessionId);
          }

          // 타입별 처리
          const messageType = jsonData.type;

          if (messageType === "assistant") {
            // assistant 타입: 실제 응답 텍스트 추출
            const message = jsonData.message;
            if (message && message.content && Array.isArray(message.content)) {
              for (const content of message.content) {
                if (content.type === "text" && content.text) {
                  const text = content.text;
                  // 이전 텍스트와 비교하여 새로운 부분만 추가
                  if (
                    text.length > accumulatedText.length &&
                    text.startsWith(accumulatedText)
                  ) {
                    // 새로운 텍스트가 이전 텍스트로 시작하는 경우 (일반적인 경우)
                    accumulatedText = text;
                    hasNewData = true;
                  } else if (
                    accumulatedText.length > 0 &&
                    text.startsWith(accumulatedText) &&
                    text.length >= accumulatedText.length
                  ) {
                    // 이전 텍스트로 시작하지만 길이가 같거나 더 긴 경우
                    accumulatedText = text;
                    hasNewData = true;
                  } else if (text !== accumulatedText && text.length > 0) {
                    // 텍스트가 완전히 바뀐 경우 또는 처음 시작하는 경우
                    accumulatedText = text;
                    hasNewData = true;
                  }
                }
              }
            }
          } else if (messageType === "result" && jsonData.result) {
            // result 타입: 최종 결과 (전체 텍스트로 교체)
            const resultText = jsonData.result;
            if (typeof resultText === "string" && resultText.length > 0) {
              accumulatedText = resultText;
              hasNewData = true;
            }
          } else if (messageType === "thinking") {
            const snippet = this.extractThinkingSnippet(jsonData);
            if (snippet) {
              this.emitAgentProgress(clientId, "thinking", snippet);
            }
          } else if (
            messageType === "tool_call" ||
            messageType === "tool" ||
            messageType === "function_call"
          ) {
            const label =
              jsonData.tool_name ||
              jsonData.name ||
              jsonData.tool ||
              jsonData.function?.name ||
              "tool";
            this.emitAgentProgress(clientId, "tool", String(label));
          } else if (messageType === "system" && jsonData.subtype === "todo") {
            const todos = jsonData.todos || jsonData.items;
            if (Array.isArray(todos)) {
              const lines = todos
                .slice(0, 8)
                .map((t: any, i: number) => {
                  const title =
                    typeof t === "string"
                      ? t
                      : t?.content || t?.title || t?.text || "";
                  return `${i + 1}. ${title}`.trim();
                })
                .filter((l: string) => l.length > 2);
              if (lines.length > 0) {
                this.emitAgentProgress(clientId, "todo", lines.join(" · "));
              }
            }
          }
          // system, user 타입도 무시
        } catch (parseError) {
          // JSON이 아닌 경우 무시 (stream-json 형식에서는 모든 라인이 JSON이어야 함)
          // 일반 텍스트 출력은 하위 호환성을 위해 지원하지 않음
        }
      }

      // 새로운 데이터가 있으면 전송
      if (hasNewData && this.wsServer) {
        const lastText = this.lastStreamedText.get(streamKey) || "";

        // accumulatedText가 lastText와 다른 경우 전송
        if (accumulatedText !== lastText) {
          const newText =
            accumulatedText.length > lastText.length
              ? accumulatedText.substring(lastText.length)
              : accumulatedText; // 처음 시작하는 경우 전체 텍스트

          if (newText.length > 0 || accumulatedText.length > 0) {
            const currentSessionId =
              this.clientSessions.get(clientId) || undefined;

            const chunkMessage = {
              type: "chat_response_chunk",
              text: newText.length > 0 ? newText : accumulatedText, // newText가 비어있으면 전체 텍스트 사용
              fullText: accumulatedText,
              timestamp: new Date().toISOString(),
              source: "cli",
              sessionId: currentSessionId || undefined,
              clientId: clientId,
              isReplace: newText.length === 0, // 처음 시작하거나 전체 교체인 경우
            };

            this.wsServer?.send(JSON.stringify(chunkMessage));
            this.lastStreamedText.set(streamKey, accumulatedText);
            this.log(
              `📤 Streaming chunk sent (${
                newText.length > 0 ? newText.length : accumulatedText.length
              } chars, total: ${accumulatedText.length})`
            );
          }
        }
      }
    } catch (error) {
      // 에러 발생 시 로그만 남기고 계속 진행
      this.logError("Error processing streaming chunk", error);
    }
  }

  /** Windows: varsayılan kill; diğer: SIGTERM → gerekirse SIGKILL. */
  private killCliProcess(proc: import("child_process").ChildProcess): void {
    try {
      if (process.platform === "win32") {
        proc.kill();
      } else {
        proc.kill("SIGTERM");
      }
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 실행 중인 CLI 프로세스 중지
   */
  async stopPrompt(sessionId?: string): Promise<{ success: boolean }> {
    this.log(`stopPrompt called sessionId=${sessionId || "all"}`);

    const sid = sessionId?.trim();
    if (sid) {
      const runKey = `sid:${sid}`;
      const proc = this.processesByRunKey.get(runKey);
      if (!proc) {
        return { success: true };
      }
      this.processesByRunKey.delete(runKey);
      this.streamingBuffers.delete(runKey);
      this.lastStreamedText.delete(runKey);
      if (this.currentProcess === proc) {
        this.currentProcess = null;
      }
      try {
        this.killCliProcess(proc);
        this.log(`CLI process stopped (${runKey})`);
        return { success: true };
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        this.logError(`Error stopping CLI process: ${errorMsg}`);
        return { success: false };
      }
    }

    for (const [key, proc] of this.processesByRunKey.entries()) {
      try {
        this.killCliProcess(proc);
      } catch (_) {
        /* ignore */
      }
      this.streamingBuffers.delete(key);
      this.lastStreamedText.delete(key);
    }
    this.processesByRunKey.clear();
    this.currentProcess = null;

    return { success: true };
  }

  /**
   * CLI 핸들러 정리
   */
  dispose() {
    for (const proc of this.processesByRunKey.values()) {
      try {
        proc.kill();
      } catch (_) {
        /* ignore */
      }
    }
    this.processesByRunKey.clear();
    this.currentProcess = null;
    this.streamingBuffers.clear();
    this.lastStreamedText.clear();
  }

  private parseChatHistoryJson(parsed: unknown): ChatHistory {
    const empty: ChatHistory = {
      entries: [],
      lastUpdated: new Date().toISOString(),
    };
    if (Array.isArray(parsed)) {
      this.log("🔄 Converting old chat history format to new format");
      return {
        entries: parsed.map((oldEntry: any, index: number) => ({
          id: `${Date.now()}-${index}-${Math.random()
            .toString(36)
            .substring(7)}`,
          sessionId: "unknown",
          clientId: "legacy",
          userMessage: oldEntry.user || oldEntry.userMessage || "",
          assistantResponse:
            oldEntry.assistant || oldEntry.assistantResponse || "",
          timestamp: oldEntry.timestamp || new Date().toISOString(),
          agentMode: oldEntry.agentMode,
        })),
        lastUpdated: new Date().toISOString(),
      };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as ChatHistory).entries)
    ) {
      const h = parsed as ChatHistory;
      return {
        entries: h.entries,
        lastUpdated: h.lastUpdated || new Date().toISOString(),
      };
    }
    this.log("⚠️ Unknown chat history format, resetting");
    return empty;
  }

  private loadChatHistoryFromDisk(): ChatHistory {
    if (!this.chatHistoryFile || !fs.existsSync(this.chatHistoryFile)) {
      return { entries: [], lastUpdated: new Date().toISOString() };
    }
    try {
      const content = fs.readFileSync(this.chatHistoryFile, "utf8");
      return this.parseChatHistoryJson(JSON.parse(content));
    } catch (e) {
      this.logError("Failed to parse chat history", e);
      return { entries: [], lastUpdated: new Date().toISOString() };
    }
  }

  /**
   * 대화 히스토리 저장
   */
  private saveChatHistoryEntry(
    entry: Partial<ChatHistoryEntry> & { clientId: string; timestamp: string }
  ): void {
    if (!this.chatHistoryFile) {
      return;
    }

    try {
      let history = this.loadChatHistoryFromDisk();
      if (!Array.isArray(history.entries)) {
        history.entries = [];
      }

      // 새 엔트리 생성
      const newEntry: ChatHistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
        sessionId: entry.sessionId || "unknown",
        clientId: entry.clientId,
        userMessage: entry.userMessage || "",
        assistantResponse: entry.assistantResponse || "",
        timestamp: entry.timestamp,
        agentMode: entry.agentMode, // 에이전트 모드 추가
      };
      // 릴레이 모드일 때 릴레이 세션 ID 함께 저장
      if (entry.clientId === "relay-client" && this.getRelaySessionId) {
        const rid = this.getRelaySessionId();
        if (rid) newEntry.relaySessionId = rid;
      }

      // 디버깅: agentMode 저장 확인
      if (newEntry.userMessage) {
        this.log(
          `💾 Creating new entry - agentMode: ${
            newEntry.agentMode || "undefined"
          }, userMessage: ${newEntry.userMessage.substring(0, 30)}...`
        );
      }

      // pending sessionId를 실제 sessionId로 업데이트
      if (newEntry.sessionId.startsWith("pending-") && entry.clientId) {
        const actualSessionId = this.clientSessions.get(entry.clientId);
        if (actualSessionId) {
          newEntry.sessionId = actualSessionId;
          // pending ID 제거
          this.pendingHistoryIds.delete(entry.clientId);
        }
      }

      const lastEntry = this.findHistoryEntryToMerge(history.entries, newEntry);

      if (lastEntry) {
        // 기존 엔트리 업데이트
        this.log(
          `💾 Updating existing entry - id: ${
            lastEntry.id
          }, currentAgentMode: ${lastEntry.agentMode || "undefined"}`
        );
        if (newEntry.userMessage) {
          lastEntry.userMessage = newEntry.userMessage;
        }
        if (newEntry.assistantResponse) {
          lastEntry.assistantResponse = newEntry.assistantResponse;
        }
        // agentMode 업데이트 (사용자 메시지가 있고 agentMode가 제공된 경우에만)
        // 응답만 저장하는 경우 agentMode를 덮어쓰지 않도록 주의
        if (newEntry.userMessage && newEntry.agentMode) {
          lastEntry.agentMode = newEntry.agentMode;
          this.log(`💾 Updated agentMode for entry: ${newEntry.agentMode}`);
        } else if (newEntry.userMessage && !newEntry.agentMode) {
          this.log(
            `⚠️ User message saved but agentMode is missing - keeping existing: ${
              lastEntry.agentMode || "undefined"
            }`
          );
        } else if (newEntry.assistantResponse && !newEntry.userMessage) {
          // 응답만 저장하는 경우 기존 agentMode 유지
          this.log(
            `💾 Saving response only - preserving agentMode: ${
              lastEntry.agentMode || "undefined"
            }`
          );
        }
        // sessionId도 업데이트 (pending -> actual)
        if (
          lastEntry.sessionId.startsWith("pending-") &&
          !newEntry.sessionId.startsWith("pending-")
        ) {
          lastEntry.sessionId = newEntry.sessionId;
        }
        // 릴레이 세션 ID 업데이트 (릴레이 모드 응답 저장 시)
        if (newEntry.relaySessionId) {
          lastEntry.relaySessionId = newEntry.relaySessionId;
        }
        // 타임스탬프: geriye gitmesin (cevap kaydında)
        const prevMs = Date.parse(lastEntry.timestamp || "");
        const newMs = Date.parse(newEntry.timestamp || "");
        if (!Number.isNaN(newMs) && (Number.isNaN(prevMs) || newMs >= prevMs)) {
          lastEntry.timestamp = newEntry.timestamp;
        }
        this.log(
          `💾 Entry updated - final agentMode: ${
            lastEntry.agentMode || "undefined"
          }`
        );
      } else {
        // 새 엔트리 추가
        history.entries.push(newEntry);
      }

      // 최대 100개만 유지
      if (history.entries.length > 100) {
        history.entries = history.entries.slice(-100);
      }

      history.lastUpdated = new Date().toISOString();

      // 파일 저장
      fs.writeFileSync(
        this.chatHistoryFile,
        JSON.stringify(history, null, 2),
        "utf8"
      );
      this.log(`💾 Chat history saved (${history.entries.length} entries)`);
    } catch (error) {
      this.logError("Failed to save chat history", error);
    }
  }

  /**
   * pending sessionId를 실제 sessionId로 업데이트
   */
  private updatePendingSessionId(
    clientId: string,
    pendingId: string,
    actualSessionId: string
  ): void {
    if (!this.chatHistoryFile || !fs.existsSync(this.chatHistoryFile)) {
      return;
    }

    try {
      const history = this.loadChatHistoryFromDisk();
      if (!Array.isArray(history.entries)) {
        this.log(
          "⚠️ history.entries is not an array in updatePendingSessionId"
        );
        return;
      }

      // pending ID를 가진 엔트리를 찾아서 실제 sessionId로 업데이트
      history.entries.forEach((entry) => {
        if (entry.clientId === clientId && entry.sessionId === pendingId) {
          entry.sessionId = actualSessionId;
        }
      });

      fs.writeFileSync(
        this.chatHistoryFile,
        JSON.stringify(history, null, 2),
        "utf8"
      );
      this.log(
        `💾 Updated pending sessionId ${pendingId} to ${actualSessionId} in history`
      );
    } catch (error) {
      this.logError("Failed to update pending sessionId", error);
    }
  }

  private readHistoryEntries(): ChatHistoryEntry[] {
    return this.loadChatHistoryFromDisk().entries;
  }

  private writeHistoryEntries(entries: ChatHistoryEntry[]): void {
    if (!this.chatHistoryFile) {
      return;
    }
    const history: ChatHistory = {
      entries,
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(
      this.chatHistoryFile,
      JSON.stringify(history, null, 2),
      "utf8"
    );
  }

  /** Bozuk / yarım kayıtları temizle; parçalı user/assistant birleştir. */
  private migrateHistoryFileIfNeeded(): ChatHistoryEntry[] {
    const raw = this.readHistoryEntries();
    const cleaned = this.cleanHistoryEntries(raw);
    const normalized = this.normalizeHistoryEntries(cleaned);
    const changed =
      normalized.length !== raw.length ||
      JSON.stringify(normalized) !== JSON.stringify(raw);
    if (changed) {
      this.writeHistoryEntries(normalized);
      this.log(
        `🧹 History migrated: ${raw.length} → ${normalized.length} entries`
      );
    }
    return normalized;
  }

  private historySessionsMatch(a: string, b: string): boolean {
    if (a === b) {
      return true;
    }
    if (a.startsWith("pending-") || b.startsWith("pending-")) {
      return true;
    }
    return false;
  }

  /**
   * Yeni kaydı mevcut satıra birleştir (30 sn sınırı yok).
   * Cevap → cevapsız son kullanıcı satırı; pending → gerçek sessionId.
   */
  private findHistoryEntryToMerge(
    entries: ChatHistoryEntry[],
    newEntry: ChatHistoryEntry
  ): ChatHistoryEntry | undefined {
    const newUser = (newEntry.userMessage || "").trim();
    const newAssistant = (newEntry.assistantResponse || "").trim();

    // Yeni kullanıcı turu → her zaman ayrı kayıt
    if (newUser && !newAssistant) {
      return undefined;
    }

    if (!newAssistant) {
      return undefined;
    }

    const pick = (preferSession: boolean): ChatHistoryEntry | undefined => {
      let best: ChatHistoryEntry | undefined;
      let bestMs = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.clientId !== newEntry.clientId) {
          continue;
        }
        const hasUser = !!(entry.userMessage || "").trim();
        const hasAssistant = !!(entry.assistantResponse || "").trim();

        if (!newUser && hasUser && !hasAssistant) {
          if (
            !preferSession ||
            this.historySessionsMatch(entry.sessionId, newEntry.sessionId)
          ) {
            const ms = Date.parse(entry.timestamp || "");
            const score = Number.isNaN(ms) ? i : ms;
            if (score >= bestMs) {
              bestMs = score;
              best = entry;
            }
          }
        }
      }
      if (best) {
        this.log(
          `💾 Merge assistant → user entry ${best.id} (session match=${preferSession}, newest pending user)`
        );
      }
      return best;
    };

    return pick(true) || pick(false);
  }

  /** Boş kullanıcılı cevap kaydını önceki cevapsız kullanıcı kaydına birleştir. */
  normalizeHistoryEntries(entries: ChatHistoryEntry[]): ChatHistoryEntry[] {
    const out: ChatHistoryEntry[] = [];
    for (const entry of entries) {
      const um = (entry.userMessage || "").trim();
      const ar = (entry.assistantResponse || "").trim();

      if (!um && ar && out.length > 0) {
        const prev = out[out.length - 1];
        const prevUm = (prev.userMessage || "").trim();
        const prevAr = (prev.assistantResponse || "").trim();
        if (
          prevUm &&
          !prevAr &&
          this.historySessionsMatch(prev.sessionId, entry.sessionId)
        ) {
          prev.assistantResponse = sanitizeMobileAssistantText(
            entry.assistantResponse || ""
          );
          const prevMs = Date.parse(prev.timestamp || "");
          const newMs = Date.parse(entry.timestamp || "");
          if (
            entry.timestamp &&
            !Number.isNaN(newMs) &&
            (Number.isNaN(prevMs) || newMs >= prevMs)
          ) {
            prev.timestamp = entry.timestamp;
          }
          if (
            prev.sessionId.startsWith("pending-") &&
            !entry.sessionId.startsWith("pending-")
          ) {
            prev.sessionId = entry.sessionId;
          }
          continue;
        }
      }

      if (!um && !ar) {
        continue;
      }

      const copy = { ...entry };
      const arText = (copy.assistantResponse || "").trim();
      if (arText) {
        copy.assistantResponse = sanitizeMobileAssistantText(arText);
      }
      out.push(copy);
    }
    out.sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
    return out;
  }

  private cleanHistoryEntries(
    entries: ChatHistoryEntry[]
  ): ChatHistoryEntry[] {
    return entries.filter((e) => {
      const um = String(e.userMessage ?? "").trim();
      if (um.startsWith(REMOTE_DELETE_MSG_PREFIX)) {
        return false;
      }
      const sid = String(e.sessionId ?? "");
      if (sid.startsWith("pending-")) {
        const assistant = String(e.assistantResponse ?? "").trim();
        if (assistant.length === 0) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * 대화 히스토리 조회
   */
  getChatHistory(
    clientId?: string,
    sessionId?: string,
    relaySessionId?: string,
    limit: number = 5
  ): ChatHistoryEntry[] {
    if (!this.chatHistoryFile) {
      return [];
    }

    try {
      let filtered = this.migrateHistoryFileIfNeeded();

      // Oturum listesi: workspace'teki tüm kayıtlar (telefon her açılışta yeni WS id üretir).
      // Yalnızca sessionId verilmişse ve clientId de verilmişse daralt (ileri uyumluluk).
      if (clientId && sessionId) {
        filtered = filtered.filter((entry) => entry.clientId === clientId);
      }

      // 세션 ID로 필터링 (Cursor CLI 채팅 스레드 ID)
      if (sessionId) {
        filtered = filtered.filter((entry) => entry.sessionId === sessionId);
      }
      // 릴레이 세션 ID로 필터링 (릴레이 모드에서 현재 세션만)
      if (relaySessionId) {
        filtered = filtered.filter(
          (entry) =>
            (entry as ChatHistoryEntry).relaySessionId === relaySessionId
        );
      }

      filtered.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      // Oturum seçiliyse: son N tur (limit), kronolojik sırada dön.
      if (sessionId) {
        const window = filtered.slice(0, limit);
        window.reverse();
        return window;
      }

      // Oturum listesi: tüm kayıtlar (limit yalnızca tek oturum penceresinde).
      return filtered;
    } catch (error) {
      this.logError("Failed to load chat history", error);
      return [];
    }
  }

  /**
   * sessionId'ye ait tüm geçmiş kayıtlarını sil (PC .cursor/CHAT_HISTORY.json).
   * CLI --resume eşlemesi de temizlenir.
   */
  deleteHistoryBySessionId(sessionId: string): {
    deletedCount: number;
    sessionId: string;
  } {
    const sid = sessionId.trim();
    if (!sid || !this.chatHistoryFile) {
      return { deletedCount: 0, sessionId: sid };
    }

    try {
      let entries = this.migrateHistoryFileIfNeeded();
      const before = entries.length;
      entries = entries.filter((e) => {
        const esid = String(e.sessionId ?? "").trim();
        if (esid === sid) {
          return false;
        }
        const um = String(e.userMessage ?? "").trim();
        if (
          um === `${REMOTE_DELETE_MSG_PREFIX}${sid}` ||
          um.startsWith(`${REMOTE_DELETE_MSG_PREFIX}${sid}`)
        ) {
          return false;
        }
        return true;
      });
      const deletedCount = before - entries.length;
      this.writeHistoryEntries(entries);

      for (const [clientId, mappedSid] of this.clientSessions.entries()) {
        if (mappedSid === sid) {
          this.clientSessions.delete(clientId);
        }
      }
      if (this.lastChatId === sid) {
        this.lastChatId = null;
      }

      this.log(
        `🗑️ Deleted ${deletedCount} history entries for session ${sid}`
      );
      return { deletedCount, sessionId: sid };
    } catch (error) {
      this.logError("Failed to delete chat history by sessionId", error);
      return { deletedCount: 0, sessionId: sid };
    }
  }

  clearAllChatHistory(): { deletedCount: number } {
    if (!this.chatHistoryFile) {
      return { deletedCount: 0 };
    }
    try {
      const before = this.readHistoryEntries().length;
      this.writeHistoryEntries([]);
      this.clientSessions.clear();
      this.lastChatId = null;
      this.log(`🗑️ Cleared all ${before} chat history entries`);
      return { deletedCount: before };
    } catch (error) {
      this.logError("Failed to clear chat history", error);
      return { deletedCount: 0 };
    }
  }

  /** Kısa anahtar kelimeler "dialog" içindeki "log" gibi yanlış eşleşmesin. */
  private textMatchesKeyword(text: string, keyword: string): boolean {
    const k = keyword.toLowerCase().trim();
    const t = text.toLowerCase();
    if (!k) return false;
    if (k.length <= 4) {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(
        t
      );
    }
    return t.includes(k);
  }

  /**
   * 텍스트 내용을 분석하여 적절한 에이전트 모드 자동 선택
   */
  private detectAgentMode(
    text: string
  ): "agent" | "ask" | "plan" | "debug" | null {
    const lowerText = text.toLowerCase();
    const hasKeyword = (keywords: string[]) =>
      keywords.some((keyword) => this.textMatchesKeyword(lowerText, keyword));

    // Debug 모드 키워드
    const debugKeywords = [
      "bug",
      "error",
      "hata",
      "fix",
      "düzelt",
      "debug",
      "issue",
      "problem",
      "crash",
      "exception",
      "trace",
      "log",
    ];
    if (hasKeyword(debugKeywords)) {
      // 버그 관련 키워드가 있지만, 단순 질문인지 확인
      if (
        lowerText.includes("why") ||
        lowerText.includes("what") ||
        lowerText.includes("how") ||
        lowerText.includes("?")
      ) {
        // 질문 형태면 Ask 모드
        if (
          lowerText.includes("explain") ||
          lowerText.includes("understand") ||
          lowerText.includes("learn")
        ) {
          return "ask";
        }
      }
      return "debug";
    }

    // Plan 모드 키워드
    const planKeywords = [
      "plan",
      "design",
      "architecture",
      "implement",
      "create",
      "build",
      "feature",
      "refactor",
      "analyze",
      "analysis",
      "project",
      "review",
      "overview",
      "structure",
    ];
    if (hasKeyword(planKeywords)) {
      // 복잡한 작업 키워드 확인
      const complexKeywords = [
        "multiple",
        "several",
        "many",
        "system",
        "module",
        "component",
        "project",
        "전체",
        "모든",
        "전반",
      ];
      if (hasKeyword(complexKeywords)) {
        return "plan";
      }
      // "프로젝트 분석", "전체 분석" 같은 패턴도 Plan 모드
      if (
        hasKeyword(["analyze", "analysis", "분석"])
      ) {
        return "plan";
      }
    }

    // Ask 모드 키워드 (질문, 학습, 탐색)
    const askKeywords = [
      "explain",
      "what is",
      "how does",
      "why",
      "understand",
      "learn",
      "show me",
      "tell me",
    ];
    if (
      hasKeyword(askKeywords) ||
      lowerText.endsWith("?")
    ) {
      return "ask";
    }

    // 기본값: Agent 모드 (코드 작성/수정 작업)
    return null; // null이면 기본 Agent 모드 사용
  }

  /**
   * 모드 이름을 사용자 친화적인 표시 이름으로 변환
   */
  private getModeDisplayName(mode: string): string {
    const modeNames: { [key: string]: string } = {
      agent: "Agent (코딩 작업)",
      ask: "Ask (질문/학습)",
      plan: "Plan (계획 수립)",
      debug: "Debug (버그 수정)",
      auto: "Auto (자동 선택)",
    };
    return modeNames[mode] || mode;
  }
}
