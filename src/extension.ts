import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { SessionStore } from "./session-store";
import { discoverSessions, isValidSessionId, lookupSessionFileSize, readSessionDisplayInfo, resolveDisplayName } from "./claude-dir";
import type { SessionMapping } from "./types";
import type { DiscoveredSession } from "./claude-dir";

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("TS Recall", { log: true });
  context.subscriptions.push(log);
  const store = SessionStore.fromState(context.globalState);
  const terminalSessionMap = new Map<vscode.Terminal, string>();
  let projectPath = getProjectPath();
  log.info(`activate: projectPath=${projectPath ?? "none"}`);

  // --- Status Bar ---
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "claudeResurrect.showMenu";
  context.subscriptions.push(statusBar);

  const updateStatusBar = (): void => {
    if (!projectPath) {
      statusBar.hide();
      return;
    }
    const tracked = store.getByProject(projectPath);
    const live = tracked.filter((m) => m.status === "active").length;

    statusBar.text = `$(terminal) TS Recall: ${live} live`;
    statusBar.tooltip = "Terminal Session Recall — this extension only tracks sessions it launched";
    statusBar.show();
  };

  updateStatusBar();

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeResurrect.showMenu", async () => {
      if (!projectPath) {
        vscode.window.showWarningMessage(
          "Terminal Session Recall: No workspace folder open.",
        );
        return;
      }
      await showQuickPick(store, projectPath, updateStatusBar, terminalSessionMap);
    }),

    vscode.commands.registerCommand("claudeResurrect.dumpState", () => {
      const channel = vscode.window.createOutputChannel("TS Recall Debug");
      const all = store.getAll();
      channel.appendLine(`=== TS Recall State Dump (${new Date().toISOString()}) ===`);
      channel.appendLine(`Total mappings: ${all.length}`);
      channel.appendLine("");
      for (const m of all) {
        channel.appendLine(`  ${m.status.padEnd(10)} ${m.terminalName}`);
        channel.appendLine(`             session: ${m.sessionId.slice(0, 8)}…`);
        channel.appendLine(`             project: ${m.projectPath}`);
        channel.appendLine(`             pid: ${m.pid ?? "N/A"}  pidCreatedAt: ${m.pidCreatedAt ? new Date(m.pidCreatedAt).toLocaleString() : "N/A"}`);
        channel.appendLine(`             lastSeen: ${new Date(m.lastSeen).toLocaleString()}`);
        channel.appendLine("");
      }
      channel.show();
    }),

    vscode.commands.registerCommand("claudeResurrect.newSession", async () => {
      if (!projectPath) {
        vscode.window.showWarningMessage(
          "Terminal Session Recall: No workspace folder open.",
        );
        return;
      }
      await startNewSession(store, projectPath, updateStatusBar, terminalSessionMap);
    }),
  );

  // --- Terminal lifecycle tracking ---
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (!projectPath) return;

      const reason = terminal.exitStatus?.reason;
      const sessionId = terminalSessionMap.get(terminal);

      if (reason === vscode.TerminalExitReason.Process) {
        if (sessionId) {
          void store.markCompletedBySessionId(sessionId, projectPath);
        } else {
          // Fallback: after reload/restart, Map is empty → use terminalName with active-priority
          void store.markCompleted(terminal.name, projectPath);
        }
      } else {
        if (sessionId) {
          void store.markInactiveBySessionId(sessionId, projectPath);
        } else {
          void store.markInactive(terminal.name, projectPath);
        }
      }

      terminalSessionMap.delete(terminal);
      updateStatusBar();
    }),
  );

  // --- Initialize project-specific features ---
  const initProject = (path: string): void => {
    const config = vscode.workspace.getConfiguration("claudeResurrect");
    const autoRestore = config.get<boolean>("autoRestore", true);

    // 14日（336時間）超過のマッピングを globalState から削除
    void store.pruneExpired(336);

    // dead process を先にクリーンアップしてから autoRestore
    // exit 済みセッションの誤復元を防ぐ
    void store.pruneDeadProcesses(path).then(() => {
      if (autoRestore) {
        void autoRestoreSessions(store, path, updateStatusBar, terminalSessionMap);
      }
      updateStatusBar();
    });
  };

  if (projectPath) {
    initProject(projectPath);
  } else {
    const folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const newPath = getProjectPath();
      if (newPath) {
        projectPath = newPath;
        folderListener.dispose();
        updateStatusBar();
        initProject(newPath);
      }
    });
    context.subscriptions.push(folderListener);
  }
}

export function deactivate(): void {
  // No cleanup needed — state is persisted immediately via globalState
}

// --- Helper functions ---

function getProjectPath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

function getClaudePath(): string {
  return vscode.workspace
    .getConfiguration("claudeResurrect")
    .get<string>("claudePath", "claude");
}

async function startNewSession(
  store: SessionStore,
  projectPath: string,
  onUpdate: () => void,
  terminalSessionMap: Map<vscode.Terminal, string>,
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const active = store.getActive(projectPath);
  const name = `TS Recall #${active.length + 1}`;

  // Save to globalState BEFORE creating terminal (crash-safe)
  const mapping: SessionMapping = {
    terminalName: name,
    sessionId,
    projectPath,
    lastSeen: Date.now(),
    status: "active",
  };
  await store.upsert(mapping);

  const terminal = vscode.window.createTerminal({
    name,
    cwd: projectPath,
    isTransient: true,
  });
  terminal.show();
  sendTextWhenReady(terminal, `${getClaudePath()} --session-id ${sessionId}`);
  terminalSessionMap.set(terminal, sessionId);

  // Record PID for liveness checking on next startup
  const pid = await terminal.processId;
  if (pid != null) {
    await store.upsert({ ...mapping, pid, pidCreatedAt: Date.now() });
  }

  onUpdate();
}

async function resumeSession(
  store: SessionStore,
  sessionId: string,
  displayName: string,
  projectPath: string,
  onUpdate: () => void,
  terminalSessionMap: Map<vscode.Terminal, string>,
): Promise<void> {
  if (!isValidSessionId(sessionId)) {
    log.warn(`resumeSession: invalid session ID rejected: ${sessionId.slice(0, 20)}`);
    return;
  }

  if (lookupSessionFileSize(projectPath, sessionId) === 0) {
    log.warn(`resumeSession: session ${sessionId.slice(0, 8)} has no conversation data, marking inactive`);
    vscode.window.showWarningMessage(
      `Terminal Session Recall: Session ${sessionId.slice(0, 8)} has no conversation data. Skipping.`,
    );
    await store.markInactiveBySessionId(sessionId, projectPath);
    return;
  }

  const terminalName = `TS Recall: ${displayName.slice(0, 30)}`;

  const mapping: SessionMapping = {
    terminalName,
    sessionId,
    projectPath,
    lastSeen: Date.now(),
    status: "active",
  };
  await store.upsert(mapping);

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd: projectPath,
    isTransient: true,
  });
  sendTextWhenReady(terminal, `${getClaudePath()} --resume ${sessionId}`);
  terminal.show();
  terminalSessionMap.set(terminal, sessionId);

  // Record PID for liveness checking on next startup
  const pid = await terminal.processId;
  if (pid != null) {
    await store.upsert({ ...mapping, pid, pidCreatedAt: Date.now() });
  }

  onUpdate();
}

/** Auto-restore sessions that were active when VSCode died */
async function autoRestoreSessions(
  store: SessionStore,
  projectPath: string,
  onUpdate: () => void,
  terminalSessionMap: Map<vscode.Terminal, string>,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("claudeResurrect");
  const maxRestore = config.get<number>("maxAutoRestore", 10);
  const active = store.getActive(projectPath);
  log.info(`autoRestore: ${active.length} active session(s) found`);
  if (active.length === 0) return;

  const toRestore = active.slice(0, maxRestore);
  const skipped = active.length - toRestore.length;

  let restored = 0;
  for (const mapping of toRestore) {
    // Skip if the terminal already exists (e.g. detach → attach from another window)
    const alreadyExists = vscode.window.terminals.some(
      (t) => t.name === mapping.terminalName,
    );
    if (alreadyExists) continue;

    const info = readSessionDisplayInfo(projectPath, mapping.sessionId);
    const displayName = resolveDisplayName(info, mapping.sessionId);
    await resumeSession(store, mapping.sessionId, displayName, projectPath, onUpdate, terminalSessionMap);
    restored++;
  }

  if (restored === 0) return;
  let message = `Terminal Session Recall: Restored ${restored} interrupted session(s).`;
  if (skipped > 0) {
    message += ` ${skipped} older session(s) skipped (limit: ${maxRestore}).`;
  }
  vscode.window.showInformationMessage(message);
}

async function showQuickPick(
  store: SessionStore,
  projectPath: string,
  onUpdate: () => void,
  terminalSessionMap: Map<vscode.Terminal, string>,
): Promise<void> {
  const QUICK_PICK_LIMIT = 20;

  const activeItems = store.getActive(projectPath);
  const allByProject = store.getByProject(projectPath);
  const inactiveItems = allByProject
    .filter((m) => m.status === "inactive")
    .sort((a, b) => b.lastSeen - a.lastSeen);
  const completedItems = allByProject
    .filter((m) => m.status === "completed")
    .sort((a, b) => b.lastSeen - a.lastSeen);

  // Discover sessions from history.jsonl that we don't track
  const discovered = discoverSessions(projectPath);
  const trackedIds = new Set(allByProject.map((m) => m.sessionId));
  const untrackedSessions = discovered.filter(
    (d) => !trackedIds.has(d.sessionId) && d.fileSize > 0,
  );

  // Filter out tracked sessions with no conversation data
  const hasFile = (m: SessionMapping): boolean =>
    lookupSessionFileSize(projectPath, m.sessionId) > 0;

  // Merge inactive + untracked into resumable, sorted by lastSeen, limited to N
  const merged = [
    ...inactiveItems.filter(hasFile).map((m) => ({ lastSeen: m.lastSeen, kind: "tracked" as const, mapping: m })),
    ...untrackedSessions.map((d) => ({ lastSeen: d.lastSeen, kind: "discovered" as const, session: d })),
  ].sort((a, b) => b.lastSeen - a.lastSeen);

  interface MenuItem extends vscode.QuickPickItem {
    action: "new" | "continue" | "reset-stale" | "focus" | "resume-tracked" | "resume-discovered";
    mapping?: SessionMapping;
    discovered?: DiscoveredSession;
  }

  const items: MenuItem[] = [];

  // Actions first
  items.push({
    label: "Actions",
    kind: vscode.QuickPickItemKind.Separator,
    action: "new",
  });
  items.push({
    label: "$(add) New Session",
    description: "Start a new Claude CLI session",
    action: "new",
  });
  items.push({
    label: "$(debug-continue) Continue Last",
    description: "Resume the most recent session (claude --continue)",
    action: "continue",
  });

  // Show reset action when stale active sessions exist (terminal gone but status still active)
  const liveTerminalNames = vscode.window.terminals.map((t) => t.name);
  const staleCount = activeItems.filter((m) => !liveTerminalNames.includes(m.terminalName)).length;
  if (staleCount > 0) {
    items.push({
      label: `$(refresh) Reset Stale Sessions`,
      description: `${staleCount} active session(s) with no terminal`,
      action: "reset-stale",
    });
  }

  // Active section
  if (activeItems.length > 0) {
    items.push({
      label: "Active",
      kind: vscode.QuickPickItemKind.Separator,
      action: "new",
    });
    for (const mapping of activeItems) {
      const size = formatSize(lookupSessionFileSize(projectPath, mapping.sessionId));
      const activeInfo = readSessionDisplayInfo(projectPath, mapping.sessionId);
      const activeDisplay = activeInfo.customTitle ?? activeInfo.firstPrompt;
      items.push({
        label: `$(terminal) ${mapping.terminalName}`,
        description: [
          activeDisplay ? `"${activeDisplay.slice(0, 40)}"` : mapping.sessionId.slice(0, 8),
          size,
          formatAge(mapping.lastSeen),
          "$(arrow-right)",
        ].filter(Boolean).join(" · "),
        action: "focus",
        mapping,
      });
    }
  }

  // Resumable section (inactive tracked + untracked, merged and limited)
  let remaining = QUICK_PICK_LIMIT;
  const resumableMenuItems: MenuItem[] = [];
  for (const entry of merged) {
    if (remaining <= 0) break;
    if (entry.kind === "tracked") {
      const size = formatSize(lookupSessionFileSize(projectPath, entry.mapping.sessionId));
      const trackedInfo = readSessionDisplayInfo(projectPath, entry.mapping.sessionId);
      const trackedDisplay = resolveDisplayName(trackedInfo, entry.mapping.sessionId);
      resumableMenuItems.push({
        label: `$(circle-outline) ${trackedDisplay}`,
        description: [size, formatAge(entry.mapping.lastSeen)].filter(Boolean).join(" · "),
        action: "resume-tracked",
        mapping: entry.mapping,
      });
    } else {
      const size = formatSize(entry.session.fileSize);
      const discoveredDisplay = entry.session.customTitle ?? entry.session.firstPrompt.slice(0, 40);
      resumableMenuItems.push({
        label: `$(circle-outline) ${discoveredDisplay}`,
        description: [size, formatAge(entry.session.lastSeen)].filter(Boolean).join(" · "),
        action: "resume-discovered",
        discovered: entry.session,
      });
    }
    remaining--;
  }

  if (resumableMenuItems.length > 0) {
    items.push({
      label: "Resumable",
      kind: vscode.QuickPickItemKind.Separator,
      action: "new",
    });
    items.push(...resumableMenuItems);
  }

  // Completed section (limited to remaining slots)
  const completedMenuItems: MenuItem[] = [];
  for (const mapping of completedItems) {
    if (remaining <= 0) break;
    const size = formatSize(lookupSessionFileSize(projectPath, mapping.sessionId));
    const completedInfo = readSessionDisplayInfo(projectPath, mapping.sessionId);
    const completedDisplay = resolveDisplayName(completedInfo, mapping.sessionId);
    completedMenuItems.push({
      label: `$(check) ${completedDisplay}`,
      description: [size, formatAge(mapping.lastSeen)].filter(Boolean).join(" · "),
      action: "resume-tracked",
      mapping,
    });
    remaining--;
  }

  if (completedMenuItems.length > 0) {
    items.push({
      label: "Completed",
      kind: vscode.QuickPickItemKind.Separator,
      action: "new",
    });
    items.push(...completedMenuItems);
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Terminal Session Recall",
  });

  if (!selected) return;

  switch (selected.action) {
    case "new":
      await startNewSession(store, projectPath, onUpdate, terminalSessionMap);
      break;
    case "reset-stale": {
      const names = vscode.window.terminals.map((t) => t.name);
      log.info(`resetStale: live terminals=[${names.join(", ")}]`);
      const resetCount = await store.resetStale(projectPath, names);
      log.info(`resetStale: ${resetCount} session(s) marked inactive`);
      if (resetCount > 0) {
        vscode.window.showInformationMessage(
          `Terminal Session Recall: Reset ${resetCount} stale session(s).`,
        );
      }
      onUpdate();
      break;
    }
    case "continue": {
      const terminal = vscode.window.createTerminal({
        name: "TS Recall: continue",
        cwd: projectPath,
        isTransient: true,
      });
      sendTextWhenReady(terminal, `${getClaudePath()} --continue`);
      terminal.show();
      break;
    }
    case "focus":
      if (selected.mapping) {
        const target = vscode.window.terminals.find(
          (t) => t.name === selected.mapping!.terminalName,
        );
        if (target) {
          target.show();
        } else {
          vscode.window.showWarningMessage(
            `Terminal Session Recall: Terminal "${selected.mapping.terminalName}" not found. It may have been closed.`,
          );
        }
      }
      break;
    case "resume-tracked":
      if (selected.mapping) {
        const m = selected.mapping;
        const resumeInfo = readSessionDisplayInfo(projectPath, m.sessionId);
        await resumeSession(
          store,
          m.sessionId,
          resolveDisplayName(resumeInfo, m.sessionId),
          projectPath,
          onUpdate,
          terminalSessionMap,
        );
      }
      break;
    case "resume-discovered":
      if (selected.discovered) {
        const d = selected.discovered;
        const displayName = d.customTitle ?? d.firstPrompt;
        await resumeSession(store, d.sessionId, displayName, projectPath, onUpdate, terminalSessionMap);
      }
      break;
  }
}

/**
 * Wait for shell readiness, then send text.
 *
 * 3-tier fallback for WSL2 compatibility:
 *   1. Shell integration ready → send immediately
 *   2. Shell type detected (onDidChangeTerminalState) → send after short delay
 *      for .bashrc initialization to complete
 *   3. Final timeout fallback (15s)
 */
function sendTextWhenReady(
  terminal: vscode.Terminal,
  text: string,
  timeoutMs = 15000,
): void {
  const name = terminal.name;
  log.debug(`sendTextWhenReady[${name}]: start`);

  if (terminal.shellIntegration) {
    log.debug(`sendTextWhenReady[${name}]: shellIntegration already ready, sending immediately`);
    terminal.sendText(text);
    return;
  }

  log.debug(`sendTextWhenReady[${name}]: waiting for shell readiness (timeout=${timeoutMs}ms)`);
  let sent = false;
  let shellDelayTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (tier: string): void => {
    if (sent) return;
    sent = true;
    log.info(`sendTextWhenReady[${name}]: sent via ${tier}`);
    clearTimeout(fallbackTimer);
    if (shellDelayTimer) clearTimeout(shellDelayTimer);
    shellIntDisposable.dispose();
    stateDisposable.dispose();
    terminal.sendText(text);
  };

  // Tier 1: Shell integration becomes ready → send immediately
  const shellIntDisposable = vscode.window.onDidChangeTerminalShellIntegration(
    ({ terminal: readyTerminal }) => {
      if (readyTerminal === terminal) send("tier1:shellIntegration");
    },
  );

  // Tier 2: Shell type detected → send after delay for init completion
  const stateDisposable = vscode.window.onDidChangeTerminalState((t) => {
    if (t === terminal && t.state.shell != null) {
      log.debug(`sendTextWhenReady[${name}]: tier2 shell type detected: ${t.state.shell}, delaying 2s`);
      stateDisposable.dispose();
      shellDelayTimer = setTimeout(() => send("tier2:shellDetected"), 2000);
    }
  });

  // Tier 3: Final fallback timeout
  const fallbackTimer = setTimeout(() => send("tier3:timeout"), timeoutMs);
}

function formatAge(timestamp: number): string {
  const hours = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60));
  if (hours < 1) {
    return "just now";
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}
