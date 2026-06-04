/**
 * Command routing module for handling WebSocket commands
 */

import * as vscode from "vscode";
import { CommandHandler } from "./command-handler";
import { materializeRemoteAttachments } from "./remote-attachments";
import { WebSocketServer } from "./websocket-server";
import { CommandMessage, CommandResult } from "./types";

export class CommandRouter {
  private commandHandler: CommandHandler;
  private wsServer: WebSocketServer;
  private outputChannel: vscode.OutputChannel;

  constructor(
    commandHandler: CommandHandler,
    wsServer: WebSocketServer,
    outputChannel: vscode.OutputChannel
  ) {
    this.commandHandler = commandHandler;
    this.wsServer = wsServer;
    this.outputChannel = outputChannel;
  }

  private log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    this.outputChannel.appendLine(logMessage);
    console.log(logMessage);
  }

  private logError(message: string, error?: any) {
    const timestamp = new Date().toLocaleTimeString();
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    const logMessage = `[${timestamp}] ❌ ${message}: ${errorMsg}`;
    this.outputChannel.appendLine(logMessage);
    console.error(logMessage);
  }

  private extractExitCode(payload: Record<string, any>): number | null {
    const candidates = [
      payload.exit_code,
      payload.exitCode,
      payload.result?.exit_code,
      payload.result?.exitCode,
    ];
    for (const value of candidates) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

  /** WS payload type normalizasyonu (mobil / eski istemciler). */
  private resolveCommandType(command: CommandMessage): string {
    const raw =
      command.type ??
      (command as { command_type?: string }).command_type ??
      "";
    return String(raw).trim().toLowerCase();
  }

  /**
   * Handle incoming command
   */
  async handleCommand(command: CommandMessage): Promise<void> {
    if (!this.commandHandler || !this.wsServer) {
      return;
    }

    const commandId = command.id || Date.now().toString();
    const commandType = this.resolveCommandType(command);
    this.log(
      `HandleCommand: type=${commandType}, clientId=${
        command.clientId || "none"
      }`
    );

    const startedAt = Date.now();
    try {
      let result: CommandResult | null = null;

      switch (commandType) {
        case "insert_text":
          result = await this.handleInsertText(command);
          break;
        case "execute_command":
          result = {
            success: false,
            error:
              "execute_command is disabled for security. Use insert_text (prompt) only.",
          };
          break;
        case "get_ai_response":
          result = await this.handleGetAIResponse();
          break;
        case "get_session_info":
          result = await this.handleGetSessionInfo(command);
          break;
        case "get_chat_history":
          result = await this.handleGetChatHistory(command);
          break;
        case "delete_session":
        case "remove_session":
        case "delete-session":
          result = await this.handleDeleteSession(command);
          break;
        case "clear_chat_history":
          result = await this.handleClearChatHistory();
          break;
        case "get_active_file":
          result = await this.handleGetActiveFile();
          break;
        case "save_file":
          result = await this.handleSaveFile();
          break;
        case "stop_prompt":
          result = await this.handleStopPrompt(command);
          break;
        case "execute_action":
          result = await this.handleExecuteAction(command);
          break;
        default:
          const errorMsg = `Unknown command type: ${commandType}`;
          this.log(errorMsg);
          console.warn("Unknown command type:", command.type);
          this.wsServer.send(
            JSON.stringify({
              id: commandId,
              type: "command_result",
              success: false,
              command_type: commandType,
              duration_ms: Date.now() - startedAt,
              exit_code: 1,
              error_message: errorMsg,
              error: errorMsg,
            })
          );
          return;
      }

      // result.success를 실제 응답 success에 반영
      const { success: resultSuccess = true, ...resultWithoutSuccess } =
        result || { success: true };

      if (!resultSuccess) {
        const fallbackError =
          resultWithoutSuccess.error ||
          resultWithoutSuccess.message ||
          `Command ${command.type} failed`;
        const exitCode =
          this.extractExitCode(resultWithoutSuccess as Record<string, any>) ?? 1;
        const durationMs =
          typeof (resultWithoutSuccess as any).duration_ms === "number"
            ? ((resultWithoutSuccess as any).duration_ms as number)
            : Date.now() - startedAt;
        this.log(`Command ${command.type} failed: ${fallbackError}`);
        this.wsServer.send(
          JSON.stringify({
            id: commandId,
            type: "command_result",
            success: false,
            command_type: commandType,
            ...resultWithoutSuccess,
            duration_ms: durationMs,
            exit_code: exitCode,
            error_message: String(fallbackError),
            ...(resultWithoutSuccess.error
              ? {}
              : { error: String(fallbackError) }),
          })
        );
        return;
      }

      // Send success response
      const successMsg = `Command ${command.type} executed successfully`;
      const durationMs =
        typeof (resultWithoutSuccess as any).duration_ms === "number"
          ? ((resultWithoutSuccess as any).duration_ms as number)
          : Date.now() - startedAt;
      const exitCode = this.extractExitCode(
        resultWithoutSuccess as Record<string, any>
      );
      this.log(successMsg);
      this.wsServer.send(
        JSON.stringify({
          id: commandId,
          type: "command_result",
          success: true,
          command_type: commandType,
          ...resultWithoutSuccess,
          duration_ms: durationMs,
          exit_code: exitCode,
          error_message: null,
        })
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError("Error handling command", error);
      console.error("Error handling command:", error);
      this.wsServer.send(
        JSON.stringify({
          id: commandId,
          type: "command_result",
          success: false,
          command_type: commandType,
          duration_ms: Date.now() - startedAt,
          exit_code: 1,
          error_message: errorMsg,
          error: errorMsg,
        })
      );
    }
  }

  /**
   * Cursor 스트림 JSON(시스템/유저 라인)이 그대로 text로 오면 사용자 발화만 추출
   */
  private normalizePromptText(raw: string): string {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return trimmed;
    // 한 줄에 하나의 JSON인 스트림 형식: {"type":"system",...}\n{"type":"user","message":{...}}
    const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line.trim()) as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (obj.type === "user" && obj.message?.content?.length) {
          for (const c of obj.message.content) {
            if (c.type === "text" && typeof c.text === "string" && c.text) {
              return c.text.trim();
            }
          }
        }
      } catch {
        // JSON이 아니면 무시
      }
    }
    // 단일 JSON 객체로 전체가 감싸진 경우 (예: message.content[0].text)
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (obj.type === "user" && obj.message?.content?.length) {
        for (const c of obj.message.content) {
          if (c.type === "text" && typeof c.text === "string" && c.text) {
            return c.text.trim();
          }
        }
      }
    } catch {
      // 전체가 JSON이 아니면 원문 그대로 사용
    }
    return trimmed;
  }

  /**
   * Handle insert_text command
   */
  /** Eski extension sürümleri için: insert_text ile oturum silme (mobil yedek). */
  private static readonly DELETE_SESSION_PREFIX = "__REMOTE_DELETE_SESSION__:";

  private async handleInsertText(
    command: CommandMessage
  ): Promise<CommandResult> {
    try {
      const rawText = command.text ?? "";
      const text = this.normalizePromptText(rawText);
      if (text.startsWith(CommandRouter.DELETE_SESSION_PREFIX)) {
        const sessionId = text
          .slice(CommandRouter.DELETE_SESSION_PREFIX.length)
          .trim();
        this.log(`delete_session via insert_text fallback: ${sessionId}`);
        return this.handleDeleteSession({
          ...command,
          sessionId,
        } as CommandMessage);
      }
      if (rawText !== text && text) {
        this.log(
          `insert_text: extracted user text from stream JSON (length ${rawText.length} -> ${text.length})`
        );
      }
      this.log(
        `insert_text command - terminal: ${command.terminal}, prompt: ${
          command.prompt
        }, text length: ${text.length}, clientId: ${command.clientId || "none"}`
      );

      const isTerminal =
        command.terminal === true || command.terminal === "true";
      const isPrompt = command.prompt === true || command.prompt === "true";
      const execute = command.execute === true;

      if (isTerminal) {
        this.log("Routing to terminal");
        await this.commandHandler.insertToTerminal(text, execute);
        return {
          success: true,
          message: execute
            ? "Text sent to terminal and executed"
            : "Text sent to terminal",
        };
      } else if (isPrompt) {
        this.log("Routing to prompt");
        const newSession = command.newSession === true;
        const agentMode = command.agentMode || "auto";
        let promptText = text;
        const attCount = command.attachments?.length ?? 0;
        if (attCount > 0) {
          const workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
            process.cwd();
          const block = materializeRemoteAttachments(
            command.attachments,
            workspaceRoot,
            (m) => this.log(m)
          );
          if (block) {
            promptText = text.trim()
              ? `${block}\n${text.trim()}`
              : block.trimEnd();
          }
          this.log(
            `insert_text: ${attCount} attachment(s) materialized, prompt length ${promptText.length}`
          );
        }
        await this.commandHandler.insertToPrompt(
          promptText,
          execute,
          command.clientId,
          newSession,
          agentMode,
          command.senderDeviceId,
          command.sessionId,
          command.replyChannel,
          command.composerUseFast
        );
        return {
          success: true,
          message: execute
            ? "Text inserted to prompt and executed"
            : "Text inserted to prompt",
        };
      } else {
        this.log("Routing to editor (fallback)");
        await this.commandHandler.insertText(text);
        return { success: true, message: "Text inserted" };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError("Error in insert_text", error);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Handle execute_command
   */
  private async handleExecuteCommand(
    command: CommandMessage
  ): Promise<CommandResult> {
    const result = await this.commandHandler.executeCommand(
      command.command || "",
      ...(command.args || [])
    );
    return { success: true, result: result };
  }

  /**
   * Handle get_ai_response
   */
  private async handleGetAIResponse(): Promise<CommandResult> {
    const response = await this.commandHandler.getAIResponse();
    return { success: true, data: response };
  }

  /**
   * Handle get_session_info
   */
  private async handleGetSessionInfo(
    command: CommandMessage
  ): Promise<CommandResult> {
    const clientId = command.clientId;
    const sessionInfo = await this.commandHandler.getSessionInfo(clientId);
    return { success: true, data: sessionInfo };
  }

  /**
   * Handle get_chat_history
   */
  private async handleClearChatHistory(): Promise<CommandResult> {
    const data = await this.commandHandler.clearAllChatSessions();
    const deletedCount =
      typeof data.deletedCount === "number" ? data.deletedCount : 0;
    return {
      success: true,
      data,
      message: `Cleared ${deletedCount} entries`,
    };
  }

  private async handleDeleteSession(
    command: CommandMessage
  ): Promise<CommandResult> {
    const sessionId = (command as any).sessionId as string | undefined;
    if (!sessionId || !String(sessionId).trim()) {
      return {
        success: false,
        error: "sessionId is required for delete_session",
      };
    }
    const data = await this.commandHandler.deleteChatSession(
      String(sessionId).trim()
    );
    const deletedCount =
      typeof data.deletedCount === "number" ? data.deletedCount : 0;
    const ok = deletedCount > 0;
    return {
      success: ok,
      data,
      error: ok
        ? undefined
        : `PC geçmişinde bu sessionId yok: ${String(sessionId).trim()}`,
      message: ok
        ? `Deleted ${deletedCount} entries`
        : "No entries found for session",
    };
  }

  private async handleGetChatHistory(
    command: CommandMessage
  ): Promise<CommandResult> {
    const clientId = command.clientId;
    const sessionId = (command as any).sessionId as string | undefined;
    const relaySessionId = (command as any).relaySessionId as
      | string
      | undefined;
    const limit = ((command as any).limit as number | undefined) || 5;
    const history = await this.commandHandler.getChatHistory(
      clientId,
      sessionId,
      relaySessionId,
      limit
    );
    return { success: true, data: history };
  }

  /**
   * Handle get_active_file
   */
  private async handleGetActiveFile(): Promise<CommandResult> {
    const result = await this.commandHandler.getActiveFile();
    if (result) {
      return { success: true, ...result };
    }
    return { success: false, error: "No active file" };
  }

  /**
   * Handle save_file
   */
  private async handleSaveFile(): Promise<CommandResult> {
    const result = await this.commandHandler.saveFile();
    return result;
  }

  /**
   * Handle stop_prompt
   */
  private async handleStopPrompt(
    command: CommandMessage
  ): Promise<CommandResult> {
    const result = await this.commandHandler.stopPrompt(command.sessionId);
    return result;
  }

  /**
   * Handle execute_action
   */
  private async handleExecuteAction(
    command: CommandMessage
  ): Promise<CommandResult> {
    const result = await this.commandHandler.executeAction(
      command.action || ""
    );
    return result;
  }
}
