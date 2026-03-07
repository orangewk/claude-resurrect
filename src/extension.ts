import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { SessionStore } from "./session-store";
import { discoverSessions, isValidSessionId, lookupSessionFileSize, readSessionDisplayInfo, resolveDisplayName } from "./claude-dir";
import type { SessionMapping } from "./types";
import type { DiscoveredSession } from "./claude-dir";

export function activate(context: vscode.ExtensionContext): void {
  const store = SessionStore.fromState(context.globalState);
  let projectPath = getProjectPath();

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
      await showQuickPick(store, projectPath, updateStatusBar);
    }),

    vscode.commands.registerCommand("claudeResurrect.newSession", async () => {
      if (!projectPath) {
        vscode.window.showWarningMessage(
          "Terminal Session Recall: No workspace folder open.",
        );
        return;
      }
      await startNewSession(store, projectPath, updateStatusBar);
    }),
  );

  // --- Terminal lifecycle tracking ---
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (!projectPath) return;

      const reason = terminal.exitStatus?.reason;
      if (reason === vscode.TerminalExitReason.Process) {
        // CLI exited on its own (user typed exit, /exit, etc.) → completed
        void store.markCompleted(terminal.name, projectPath);
      } else {
        // User closed terminal, VSCode shutdown, or unknown → restorable
        // Note: Extension-disposed terminals also land here (intentional)
        void store.markInactive(terminal.name, projectPath);
      }
      updateStatusBar();
    }),
  );

  // --- Initialize project-specific features ---
  const initProject = (path: string): void => {
    const config = vscode.workspace.getConfiguration("claudeResurrect");
    const autoRestore = config.get<boolean>("autoRestore", true);

    // 14日（336時間）超過のマッピングを globalState から削除
    void store.pruneExpired(336);

    if (autoRestore) {
      void autoRestoreSessions(store, path, updateStatusBar);
    }
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
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const active = store.getActive(projectPath);
  const name = `TS Recall #${active.length + 1}`;

  // Save to globalState BEFORE creating terminal (crash-safe)
  await store.upsert({
    terminalName: name,
    sessionId,
    projectPath,
    lastSeen: Date.now(),
    status: "active",
  });

  const terminal = vscode.window.createTerminal({
    name,
    cwd: projectPath,
    isTransient: true,
  });
  terminal.show();
  terminal.sendText(`${getClaudePath()} --session-id ${sessionId}`);

  onUpdate();
}

async function resumeSession(
  store: SessionStore,
  sessionId: string,
  displayName: string,
  projectPath: string,
  onUpdate: () => void,
): Promise<void> {
  if (!isValidSessionId(sessionId)) {
    console.error(`[Terminal Session Recall] Invalid session ID rejected: ${sessionId.slice(0, 20)}`);
    return;
  }

  if (lookupSessionFileSize(projectPath, sessionId) === 0) {
    vscode.window.showWarningMessage(
      `Terminal Session Recall: Session ${sessionId.slice(0, 8)} has no conversation data. Skipping.`,
    );
    return;
  }

  const terminalName = `TS Recall: ${displayName.slice(0, 30)}`;

  await store.upsert({
    terminalName,
    sessionId,
    projectPath,
    lastSeen: Date.now(),
    status: "active",
  });

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd: projectPath,
    isTransient: true,
  });
  terminal.sendText(`${getClaudePath()} --resume ${sessionId}`);
  terminal.show();

  onUpdate();
}

/** Auto-restore sessions that were active when VSCode died */
async function autoRestoreSessions(
  store: SessionStore,
  projectPath: string,
  onUpdate: () => void,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("claudeResurrect");
  const maxRestore = config.get<number>("maxAutoRestore", 10);
  const active = store.getActive(projectPath);
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
    await resumeSession(store, mapping.sessionId, displayName, projectPath, onUpdate);
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
    action: "new" | "continue" | "focus" | "resume-tracked" | "resume-discovered";
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
      await startNewSession(store, projectPath, onUpdate);
      break;
    case "continue": {
      const terminal = vscode.window.createTerminal({
        name: "TS Recall: continue",
        cwd: projectPath,
        isTransient: true,
      });
      terminal.sendText(`${getClaudePath()} --continue`);
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
        );
      }
      break;
    case "resume-discovered":
      if (selected.discovered) {
        const d = selected.discovered;
        const displayName = d.customTitle ?? d.firstPrompt;
        await resumeSession(store, d.sessionId, displayName, projectPath, onUpdate);
      }
      break;
  }
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
