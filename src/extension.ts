import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { SessionStore } from "./session-store";
import { discoverSessions, lookupSessionFileSize } from "./claude-dir";
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
    const discovered = discoverSessions(projectPath);
    // Deduplicate: discovered sessions that are already tracked
    const trackedIds = new Set(tracked.map((m) => m.sessionId));
    const untracked = discovered.filter((d) => !trackedIds.has(d.sessionId));
    const live = tracked.filter((m) => m.status === "active").length;
    const idle = tracked.filter((m) => m.status !== "active" && m.status !== "completed").length
      + untracked.length;

    statusBar.text = `$(terminal) Claude: ${live} live · ${idle} idle`;
    statusBar.tooltip = "Claude Resurrect — Click to manage sessions";
    statusBar.show();
  };

  updateStatusBar();

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeResurrect.showMenu", async () => {
      if (!projectPath) {
        vscode.window.showWarningMessage(
          "Claude Resurrect: No workspace folder open.",
        );
        return;
      }
      await showQuickPick(store, projectPath, updateStatusBar);
    }),

    vscode.commands.registerCommand("claudeResurrect.newSession", async () => {
      if (!projectPath) {
        vscode.window.showWarningMessage(
          "Claude Resurrect: No workspace folder open.",
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
  const name = `Claude #${active.length + 1}`;

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
  const terminalName = `Claude: ${displayName.slice(0, 30)}`;

  await store.upsert({
    terminalName,
    sessionId,
    projectPath,
    lastSeen: Date.now(),
    firstPrompt: displayName,
    status: "active",
  });

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd: projectPath,
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
  const active = store.getActive(projectPath);
  if (active.length === 0) return;

  for (const mapping of active) {
    const displayName = mapping.firstPrompt ?? mapping.sessionId.slice(0, 8);
    await resumeSession(store, mapping.sessionId, displayName, projectPath, onUpdate);
  }

  vscode.window.showInformationMessage(
    `Claude Resurrect: Restored ${active.length} interrupted session(s).`,
  );
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
  const untrackedSessions = discovered.filter((d) => !trackedIds.has(d.sessionId));

  // Merge inactive + untracked into resumable, sorted by lastSeen, limited to N
  const merged = [
    ...inactiveItems.map((m) => ({ lastSeen: m.lastSeen, kind: "tracked" as const, mapping: m })),
    ...untrackedSessions.map((d) => ({ lastSeen: d.lastSeen, kind: "discovered" as const, session: d })),
  ].sort((a, b) => b.lastSeen - a.lastSeen);

  interface MenuItem extends vscode.QuickPickItem {
    action: "new" | "continue" | "resume-tracked" | "resume-discovered";
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
      items.push({
        label: `$(circle-filled) ${mapping.terminalName}`,
        description: [
          mapping.firstPrompt ? `"${mapping.firstPrompt.slice(0, 40)}"` : mapping.sessionId.slice(0, 8),
          size,
          formatAge(mapping.lastSeen),
        ].filter(Boolean).join(" · "),
        action: "resume-tracked",
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
      resumableMenuItems.push({
        label: `$(circle-outline) ${entry.mapping.firstPrompt ?? entry.mapping.sessionId.slice(0, 8)}`,
        description: [size, formatAge(entry.mapping.lastSeen)].filter(Boolean).join(" · "),
        action: "resume-tracked",
        mapping: entry.mapping,
      });
    } else {
      const size = formatSize(entry.session.fileSize);
      resumableMenuItems.push({
        label: `$(circle-outline) ${entry.session.firstPrompt.slice(0, 40)}`,
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
    completedMenuItems.push({
      label: `$(check) ${mapping.firstPrompt ?? mapping.sessionId.slice(0, 8)}`,
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
    placeHolder: "Claude Resurrect",
  });

  if (!selected) return;

  switch (selected.action) {
    case "new":
      await startNewSession(store, projectPath, onUpdate);
      break;
    case "continue": {
      const terminal = vscode.window.createTerminal({
        name: "Claude: continue",
        cwd: projectPath,
      });
      terminal.sendText(`${getClaudePath()} --continue`);
      terminal.show();
      break;
    }
    case "resume-tracked":
      if (selected.mapping) {
        const m = selected.mapping;
        await resumeSession(
          store,
          m.sessionId,
          m.firstPrompt ?? m.sessionId.slice(0, 8),
          projectPath,
          onUpdate,
        );
      }
      break;
    case "resume-discovered":
      if (selected.discovered) {
        const d = selected.discovered;
        await resumeSession(store, d.sessionId, d.firstPrompt, projectPath, onUpdate);
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
