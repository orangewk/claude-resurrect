import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { SessionStore } from "./session-store";
import { discoverSessions, isValidSessionId, lookupSessionFileSize, readSessionDisplayInfo, resolveDisplayName } from "./claude-dir";
import { normalizePath } from "./normalize-path";
import { detectClaudeSession } from "./process-inspector";
import type { SessionMapping, SessionPreset } from "./types";
import type { DiscoveredSession } from "./claude-dir";
import { openPresetsPanel } from "./preset-webview";

// --- Shell escape utility ---

/** Escape a single argument for safe shell interpolation */
function shellEscape(arg: string): string {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Build the CLI command string with optional extra args */
function buildCommand(base: string, extraArgs: readonly string[]): string {
  if (extraArgs.length === 0) return base;
  return `${base} ${extraArgs.map(shellEscape).join(" ")}`;
}

/** Resolve the absolute path of the claude executable */
function resolveClaudePath(): string {
  const configured = getClaudePath();
  // If already absolute, use as-is
  if (configured.startsWith("/")) return configured;
  // Try to resolve via which
  try {
    return execFileSync("which", [configured], { encoding: "utf-8" }).trim();
  } catch {
    return configured;
  }
}

// --- User & shell wrapper helpers ---

/** Resolve effective userName: preset-level overrides global */
function resolveUserName(presetUserName?: string): string | undefined {
  const effective = presetUserName || getUserName() || undefined;
  return effective || undefined;
}

/** Get global shell wrapper template */
function getShellWrapper(): string {
  return vscode.workspace
    .getConfiguration("claudeResurrect")
    .get<string>("shellWrapper", "su - {user} -c 'cd {cwd} && {cmd}'");
}

/**
 * Build the CLI command, optionally wrapped with a shell wrapper template.
 * Only wraps when userName is set. The wrapper template uses placeholders:
 * {cmd} = the full claude command, {cwd} = working directory, {user} = userName
 */
function buildWrappedCommand(
  base: string,
  extraArgs: readonly string[],
  cwd: string,
  userName?: string,
  shellWrapperOverride?: string,
): string {
  const cmd = buildCommand(base, extraArgs);

  // No user → run directly, no wrapping
  if (!userName) return cmd;

  const wrapper = shellWrapperOverride || getShellWrapper();

  // No wrapper template → run directly
  if (!wrapper) return cmd;

  return wrapper
    .replace(/\{cmd\}/g, cmd)
    .replace(/\{cwd\}/g, shellEscape(cwd))
    .replace(/\{user\}/g, shellEscape(userName));
}

// --- Config helpers ---

function getClaudePath(): string {
  return vscode.workspace
    .getConfiguration("claudeResurrect")
    .get<string>("claudePath", "claude");
}

function getClaudeArgs(): readonly string[] {
  return vscode.workspace
    .getConfiguration("claudeResurrect")
    .get<string[]>("claudeArgs", []);
}

function getUserName(): string {
  return vscode.workspace
    .getConfiguration("claudeResurrect")
    .get<string>("userName", "");
}

function getSessionPresets(): SessionPreset[] {
  return vscode.workspace
    .getConfiguration("claudeResurrect")
    .get<SessionPreset[]>("sessionPresets", []);
}

/** Prefix a terminal name with userName if set */
function prefixedName(name: string, userNameOverride?: string): string {
  const user = userNameOverride || getUserName();
  if (!user) return name;
  return `[${user}] ${name}`;
}

// --- Debug log channel (lazy-init) ---
let _logChannel: vscode.OutputChannel | undefined;
function log(msg: string): void {
  if (!_logChannel) {
    _logChannel = vscode.window.createOutputChannel("TS Recall Log");
  }
  _logChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// --- Main activation ---

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
    const byProject = store.getByProject(projectPath);
    const active = byProject.filter((m) => m.status === "active");
    const inactive = byProject.filter((m) => m.status === "inactive");

    // Verify active entries have a matching open terminal
    const openTerminalNames = new Set(vscode.window.terminals.map((t) => t.name));
    const liveActive = active.filter((m) => openTerminalNames.has(m.terminalName));
    const staleActive = active.filter((m) => !openTerminalNames.has(m.terminalName));

    if (staleActive.length > 0) {
      log(`[status-bar] ${staleActive.length} stale active entries (no matching terminal): ${staleActive.map(m => `"${m.terminalName}"(${m.sessionId.slice(0, 8)})`).join(", ")}`);
      // Mark stale actives as inactive
      for (const m of staleActive) {
        log(`[status-bar] marking stale active "${m.terminalName}" (${m.sessionId.slice(0, 8)}) as inactive`);
        void store.markInactive(m.terminalName, m.projectPath);
      }
    }

    log(`[status-bar] project=${projectPath} active=${liveActive.length} staleActive=${staleActive.length} inactive=${inactive.length} openTerminals=[${[...openTerminalNames].join(", ")}]`);

    statusBar.text = `$(terminal) TS Recall: ${liveActive.length} live`;

    const tooltip = new vscode.MarkdownString("", true);
    tooltip.isTrusted = true;
    tooltip.supportHtml = true;

    tooltip.appendMarkdown(`**Terminal Session Recall: ${liveActive.length} live**\n\n`);

    if (liveActive.length > 0) {
      tooltip.appendMarkdown("---\n\n");
      for (const m of liveActive) {
        tooltip.appendMarkdown(`$(terminal) \`${m.terminalName}\` — ${m.sessionId.slice(0, 8)}\n\n`);
      }
    }

    if (inactive.length > 0) {
      tooltip.appendMarkdown(`*${inactive.length} inactive (resumable)*\n\n`);
    }

    statusBar.tooltip = tooltip;
    statusBar.show();
  };

  updateStatusBar();

  // --- Original Commands ---
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
      await startNewSession(store, projectPath, updateStatusBar);
    }),
  );

  // --- Feature 4: Adopt Running Session ---
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeResurrect.adoptSession", async () => {
      if (!projectPath) {
        vscode.window.showWarningMessage("Terminal Session Recall: No workspace folder open.");
        return;
      }

      log(`[adopt] projectPath=${projectPath}`);

      // List open terminals not already tracked
      const trackedNames = new Set(
        store.getActive(projectPath).map((m) => m.terminalName),
      );
      const openTerminals = vscode.window.terminals.filter(
        (t) => !trackedNames.has(t.name),
      );

      log(`[adopt] all terminals=${vscode.window.terminals.map(t => t.name).join(", ")}`);
      log(`[adopt] trackedNames=${[...trackedNames].join(", ")}`);
      log(`[adopt] openTerminals (untracked)=${openTerminals.map(t => t.name).join(", ")}`);

      if (openTerminals.length === 0) {
        log("[adopt] No untracked terminals found — aborting");
        vscode.window.showInformationMessage("No untracked terminals found.");
        return;
      }

      interface TerminalItem extends vscode.QuickPickItem {
        terminal: vscode.Terminal;
      }

      const terminalItems: TerminalItem[] = openTerminals.map((t) => ({
        label: t.name,
        terminal: t,
      }));

      const selectedTerminal = await vscode.window.showQuickPick(terminalItems, {
        placeHolder: "Select terminal to adopt",
      });
      if (!selectedTerminal) return;

      // Try process inspection first (Linux: procfs-based)
      const terminalPid = await selectedTerminal.terminal.processId;
      if (terminalPid) {
        log(`[adopt] terminal PID=${terminalPid}, attempting process inspection`);
        const detected = detectClaudeSession(terminalPid);
        if (detected) {
          log(`[adopt] process inspector found session=${detected.sessionId.slice(0, 8)} cwd=${detected.cwd} user=${detected.userName ?? "N/A"} args=${detected.args.join(" ")}`);
          const allTrackedIds = new Set(store.getByProject(projectPath).map((m) => m.sessionId));
          if (!allTrackedIds.has(detected.sessionId)) {
            // Check for duplicate preset
            const existingPresets = getSessionPresets();
            if (existingPresets.some((p) => p.sessionId === detected.sessionId)) {
              log(`[adopt] DUPLICATE — preset with this sessionId already exists, aborting`);
              vscode.window.showWarningMessage(
                `A preset with session ${detected.sessionId.slice(0, 8)} already exists. Use "Manage Presets" to modify it.`,
              );
              return;
            }

            const effectiveCwd = detected.cwd;
            await adoptTerminal(store, selectedTerminal.terminal, detected.sessionId, effectiveCwd);
            log(`[adopt] auto-adopted via process inspection`);

            const newPreset: SessionPreset = {
              label: selectedTerminal.terminal.name,
              cwd: effectiveCwd,
              sessionId: detected.sessionId,
              args: detected.args as string[],
              terminalName: selectedTerminal.terminal.name,
              autoLaunch: false,
              ...(detected.userName ? { userName: detected.userName } : {}),
            };
            const presets = getSessionPresets();
            await vscode.workspace.getConfiguration("claudeResurrect")
              .update("sessionPresets", [...presets, newPreset], vscode.ConfigurationTarget.Workspace);
            log(`[adopt] preset created via process inspection (user=${detected.userName ?? "none"}, args=${detected.args.length})`);

            vscode.window.showInformationMessage(
              `Adopted session ${detected.sessionId.slice(0, 8)} (detected from process)`,
            );
            return;
          }
          log(`[adopt] detected session ${detected.sessionId.slice(0, 8)} is already tracked, falling through`);
        } else {
          log(`[adopt] process inspector returned nothing, falling back to session discovery`);
        }
      }

      // Find candidate sessions from history.jsonl
      const discovered = discoverSessions(projectPath);
      log(`[adopt] discoverSessions returned ${discovered.length} sessions`);
      for (const d of discovered.slice(0, 10)) {
        log(`[adopt]   ${d.sessionId.slice(0, 8)} fileSize=${d.fileSize} project=${d.projectPath} prompt="${d.firstPrompt?.slice(0, 30)}"`);
      }
      const allTrackedIds = new Set(store.getByProject(projectPath).map((m) => m.sessionId));
      log(`[adopt] allTrackedIds (by project exact match)=${[...allTrackedIds].map(id => id.slice(0, 8)).join(", ")}`);

      // Use terminal cwd from shellIntegration to narrow candidates
      const terminalCwd = selectedTerminal.terminal.shellIntegration?.cwd?.fsPath;
      log(`[adopt] terminal cwd from shellIntegration: ${terminalCwd ?? "N/A"}`);

      let candidates: DiscoveredSession[];
      if (terminalCwd) {
        const cwdCandidates = discovered.filter(
          (d) => !allTrackedIds.has(d.sessionId) && d.fileSize > 0
            && normalizePath(d.projectPath) === normalizePath(terminalCwd),
        );
        if (cwdCandidates.length > 0) {
          candidates = cwdCandidates;
          log(`[adopt] cwd-filtered candidates: ${candidates.length}`);
        } else {
          // Fallback: no match for cwd, show all
          candidates = discovered.filter(
            (d) => !allTrackedIds.has(d.sessionId) && d.fileSize > 0,
          );
          log(`[adopt] no cwd match, fallback to all candidates: ${candidates.length}`);
        }
      } else {
        // No shellIntegration — old behavior
        candidates = discovered.filter(
          (d) => !allTrackedIds.has(d.sessionId) && d.fileSize > 0,
        );
        log(`[adopt] no shellIntegration, all candidates: ${candidates.length}`);
      }

      let adoptedSessionId: string;
      let adoptedProjectPath: string | undefined;

      if (candidates.length === 0) {
        log("[adopt] No candidates — falling back to manual ID input");
        // Fallback: ask for manual session ID input
        const manualId = await vscode.window.showInputBox({
          prompt: "No untracked sessions found. Enter session ID manually:",
          placeHolder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        });
        if (!manualId || !isValidSessionId(manualId)) {
          if (manualId) {
            vscode.window.showWarningMessage("Invalid session ID format.");
          }
          return;
        }
        adoptedSessionId = manualId;
      } else if (candidates.length === 1 && terminalCwd) {
        // Auto-adopt: exactly 1 candidate after cwd filtering
        const auto = candidates[0];
        log(`[adopt] auto-adopting single cwd candidate: ${auto.sessionId.slice(0, 8)}`);
        adoptedSessionId = auto.sessionId;
        adoptedProjectPath = auto.projectPath;
      } else {
        interface SessionItem extends vscode.QuickPickItem {
          session: DiscoveredSession;
        }

        const sessionItems: SessionItem[] = candidates.slice(0, 20).map((d) => {
          const info = readSessionDisplayInfo(d.projectPath, d.sessionId);
          const display = info.customTitle ?? d.firstPrompt.slice(0, 40);
          return {
            label: display,
            description: `${d.sessionId.slice(0, 8)} · ${formatSize(d.fileSize)} · ${formatAge(d.lastSeen)}`,
            session: d,
          };
        });

        const selectedSession = await vscode.window.showQuickPick(sessionItems, {
          placeHolder: "Select session to associate with the terminal",
        });
        if (!selectedSession) return;
        adoptedSessionId = selectedSession.session.sessionId;
        adoptedProjectPath = selectedSession.session.projectPath;
      }

      log(`[adopt] selected sessionId=${adoptedSessionId} adoptedProjectPath=${adoptedProjectPath}`);

      // Duplicate check: abort if a preset with this sessionId already exists
      const existingPresets = getSessionPresets();
      log(`[adopt] existing presets: ${existingPresets.map(p => `${p.label}(${p.sessionId?.slice(0, 8)})`).join(", ")}`);
      if (existingPresets.some((p) => p.sessionId === adoptedSessionId)) {
        log(`[adopt] DUPLICATE — preset with this sessionId already exists, aborting`);
        vscode.window.showWarningMessage(
          `A preset with session ${adoptedSessionId.slice(0, 8)} already exists. Use "Manage Presets" to modify it.`,
        );
        return;
      }

      const effectiveCwd = adoptedProjectPath ?? projectPath;
      log(`[adopt] effectiveCwd=${effectiveCwd}`);

      // Register in SessionStore for liveness tracking
      await adoptTerminal(store, selectedTerminal.terminal, adoptedSessionId, effectiveCwd);
      log(`[adopt] adoptTerminal done`);

      // Automatically create a preset
      const newPreset: SessionPreset = {
        label: selectedTerminal.terminal.name,
        cwd: effectiveCwd,
        sessionId: adoptedSessionId,
        args: [],
        terminalName: selectedTerminal.terminal.name,
        autoLaunch: false,
      };
      const config = vscode.workspace.getConfiguration("claudeResurrect");
      const updatedPresets = [...config.get<SessionPreset[]>("sessionPresets", []), newPreset];
      log(`[adopt] saving ${updatedPresets.length} presets to workspace config`);
      await config.update("sessionPresets", updatedPresets, vscode.ConfigurationTarget.Workspace);
      log(`[adopt] preset saved OK`);

      updateStatusBar();
      vscode.window.showInformationMessage(
        `Adopted session ${adoptedSessionId.slice(0, 8)} and saved as preset "${newPreset.label}".`,
      );
    }),
  );

  // --- Feature 5: Session Presets ---
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeResurrect.launchPreset", async () => {
      const presets = getSessionPresets();
      if (presets.length === 0) {
        vscode.window.showInformationMessage("No presets configured. Use 'Claude Resurrect: Manage Presets' to create one.");
        return;
      }

      interface PresetItem extends vscode.QuickPickItem {
        preset: SessionPreset;
      }

      const items: PresetItem[] = presets.map((p) => ({
        label: `$(bookmark) ${p.label}`,
        description: `${p.cwd}${p.autoLaunch ? " (auto-launch)" : ""}`,
        preset: p,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select preset to launch",
      });
      if (!selected) return;

      await launchPreset(store, selected.preset, updateStatusBar);
    }),

    vscode.commands.registerCommand("claudeResurrect.managePresets", () => {
      openPresetsPanel(context.extensionUri, async (preset) => {
        await launchPreset(store, preset, updateStatusBar);
      });
    }),
  );

  // --- Terminal lifecycle tracking ---

  // Track terminal names for rename detection
  const terminalNameCache = new Map<vscode.Terminal, string>();
  for (const t of vscode.window.terminals) {
    terminalNameCache.set(t, t.name);
  }

  // Poll for terminal renames every 2 seconds (VS Code has no onDidRenameTerminal event)
  const RENAME_POLL_MS = 2000;
  const renamePollInterval = setInterval(() => {
    if (!projectPath) return;
    for (const [terminal, oldName] of terminalNameCache) {
      if (terminal.name !== oldName) {
        log(`[rename-poll] detected rename: "${oldName}" → "${terminal.name}"`);
        terminalNameCache.set(terminal, terminal.name);

        // Search ALL active mappings (not just current project — presets may use different cwd)
        const allMappings = store.getAll();
        const mapping = allMappings.find((m) => m.status === "active" && m.terminalName === oldName);
        if (mapping) {
          log(`[rename-poll] found mapping: session=${mapping.sessionId.slice(0, 8)} project=${mapping.projectPath}`);
          void store.upsert({ ...mapping, terminalName: terminal.name }).then(() => {
            log(`[rename-poll] store updated OK: "${oldName}" → "${terminal.name}"`);
            updateStatusBar();
          });

          const presets = getSessionPresets();
          let idx = presets.findIndex((p) => p.sessionId === mapping.sessionId);
          if (idx < 0) {
            // Fallback: match by terminalName or label (for presets without sessionId)
            idx = presets.findIndex((p) => p.terminalName === oldName || p.label === oldName);
            if (idx >= 0) {
              log(`[rename-poll] preset[${idx}] matched by terminalName/label fallback (not by sessionId)`);
            }
          }
          if (idx >= 0) {
            const updated = [...presets];
            updated[idx] = { ...updated[idx], terminalName: terminal.name, label: terminal.name };
            void vscode.workspace.getConfiguration("claudeResurrect")
              .update("sessionPresets", updated, vscode.ConfigurationTarget.Workspace);
            log(`[rename-poll] preset[${idx}] updated: label+terminalName → "${terminal.name}"`);
          } else {
            log(`[rename-poll] no preset found for session ${mapping.sessionId.slice(0, 8)} by sessionId or name "${oldName}" (${presets.length} presets checked)`);
          }
        } else {
          log(`[rename-poll] no active mapping found for terminal "${oldName}" (${allMappings.filter(m => m.status === "active").length} active mappings total)`);
        }
      }
    }
  }, RENAME_POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(renamePollInterval) });

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      log(`[terminal-open] "${terminal.name}" added to rename cache (cache size: ${terminalNameCache.size + 1})`);
      terminalNameCache.set(terminal, terminal.name);
    }),

    vscode.window.onDidCloseTerminal((terminal) => {
      log(`[terminal-close] "${terminal.name}" exitReason=${terminal.exitStatus?.reason} exitCode=${terminal.exitStatus?.code}`);
      terminalNameCache.delete(terminal);
      if (!projectPath) return;

      const reason = terminal.exitStatus?.reason;
      if (reason === vscode.TerminalExitReason.Process) {
        log(`[terminal-close] marking "${terminal.name}" as completed (process exit)`);
        void store.markCompleted(terminal.name, projectPath);
      } else {
        log(`[terminal-close] marking "${terminal.name}" as inactive (reason: ${reason})`);
        void store.markInactive(terminal.name, projectPath);
      }
      updateStatusBar();
    }),
  );

  // --- Initialize project-specific features ---
  const initProject = (path: string): void => {
    const config = vscode.workspace.getConfiguration("claudeResurrect");
    const autoRestore = config.get<boolean>("autoRestore", true);

    const allBefore = store.getAll();
    log(`[init] project=${path} totalMappings=${allBefore.length} active=${allBefore.filter(m => m.status === "active").length} inactive=${allBefore.filter(m => m.status === "inactive").length} completed=${allBefore.filter(m => m.status === "completed").length}`);

    void store.pruneExpired(336).then((expiredCount) => {
      log(`[init] pruneExpired(336h): removed ${expiredCount} entries`);
    });

    void store.pruneDeadProcesses(path).then((deadCount) => {
      log(`[init] pruneDeadProcesses: marked ${deadCount} dead processes as inactive`);
      const allAfter = store.getAll();
      log(`[init] after prune: totalMappings=${allAfter.length} active=${allAfter.filter(m => m.status === "active").length} inactive=${allAfter.filter(m => m.status === "inactive").length}`);
      updateStatusBar();
      if (autoRestore) {
        void autoRestoreSessions(store, path, updateStatusBar);
      }
      // Auto-launch presets after auto-restore
      void autoLaunchPresets(store, updateStatusBar);
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

async function startNewSession(
  store: SessionStore,
  projectPath: string,
  onUpdate: () => void,
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const active = store.getActive(projectPath);
  const userName = resolveUserName();

  const name = prefixedName(`TS Recall #${active.length + 1}`, userName);
  const extraArgs = getClaudeArgs();

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
  terminal.sendText(buildWrappedCommand(`${resolveClaudePath()} --session-id ${sessionId}`, extraArgs, projectPath, userName));

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
  extraArgs?: readonly string[],
  customCwd?: string,
  customTerminalName?: string,
  userNameOverride?: string,
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

  const userName = resolveUserName(userNameOverride);

  const terminalName = customTerminalName ?? prefixedName(`TS Recall: ${displayName.slice(0, 30)}`, userName);
  const cwd = customCwd ?? projectPath;
  const allArgs = [...getClaudeArgs(), ...(extraArgs ?? [])];

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
    cwd,
    isTransient: true,
  });
  terminal.sendText(buildWrappedCommand(`${resolveClaudePath()} --resume ${sessionId}`, allArgs, cwd, userName));
  terminal.show();

  const pid = await terminal.processId;
  if (pid != null) {
    await store.upsert({ ...mapping, pid, pidCreatedAt: Date.now() });
  }

  onUpdate();
}

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

// --- Feature 4: Adopt helper ---

async function adoptTerminal(
  store: SessionStore,
  terminal: vscode.Terminal,
  sessionId: string,
  projectPath: string,
): Promise<void> {
  const mapping: SessionMapping = {
    terminalName: terminal.name,
    sessionId,
    projectPath,
    lastSeen: Date.now(),
    status: "active",
  };
  await store.upsert(mapping);

  const pid = await terminal.processId;
  if (pid != null) {
    await store.upsert({ ...mapping, pid, pidCreatedAt: Date.now() });
  }
}

// --- Feature 5: Preset helpers ---

async function launchPreset(
  store: SessionStore,
  preset: SessionPreset,
  onUpdate: () => void,
): Promise<void> {
  // Validate cwd exists
  try {
    const stat = fs.statSync(preset.cwd);
    if (!stat.isDirectory()) {
      vscode.window.showWarningMessage(`Preset "${preset.label}": ${preset.cwd} is not a directory.`);
      return;
    }
  } catch {
    vscode.window.showWarningMessage(`Preset "${preset.label}": Directory ${preset.cwd} does not exist.`);
    return;
  }

  // Resolve userName and shellWrapper: preset-level overrides global
  const userName = resolveUserName(preset.userName);
  const shellWrapper = preset.shellWrapper || undefined;

  const terminalName = prefixedName(preset.terminalName ?? preset.label, userName);

  // Prevent duplicate terminals
  const alreadyExists = vscode.window.terminals.some(
    (t) => t.name === terminalName,
  );
  if (alreadyExists) {
    const existing = vscode.window.terminals.find((t) => t.name === terminalName);
    if (existing) existing.show();
    return;
  }

  const presetArgs = preset.args ?? [];
  const globalArgs = getClaudeArgs();
  const allArgs = [...globalArgs, ...presetArgs];

  if (preset.sessionId) {
    // Resume existing session
    if (!isValidSessionId(preset.sessionId)) {
      vscode.window.showWarningMessage(`Preset "${preset.label}": Invalid session ID.`);
      return;
    }

    // Check if session file exists — if not, skip silently
    if (lookupSessionFileSize(preset.cwd, preset.sessionId) === 0) {
      vscode.window.showWarningMessage(
        `Preset "${preset.label}": Session ${preset.sessionId.slice(0, 8)} no longer exists. Skipping.`,
      );
      return;
    }

    const mapping: SessionMapping = {
      terminalName,
      sessionId: preset.sessionId,
      projectPath: preset.cwd,
      lastSeen: Date.now(),
      status: "active",
    };
    await store.upsert(mapping);

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: preset.cwd,
      isTransient: true,
    });
    terminal.sendText(buildWrappedCommand(`${resolveClaudePath()} --resume ${preset.sessionId}`, allArgs, preset.cwd, userName, shellWrapper));
    terminal.show();

    const pid = await terminal.processId;
    if (pid != null) {
      await store.upsert({ ...mapping, pid, pidCreatedAt: Date.now() });
    }
  } else {
    // New session
    const sessionId = crypto.randomUUID();
    const mapping: SessionMapping = {
      terminalName,
      sessionId,
      projectPath: preset.cwd,
      lastSeen: Date.now(),
      status: "active",
    };
    await store.upsert(mapping);

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: preset.cwd,
      isTransient: true,
    });
    terminal.show();
    terminal.sendText(buildWrappedCommand(`${resolveClaudePath()} --session-id ${sessionId}`, allArgs, preset.cwd, userName, shellWrapper));

    const pid = await terminal.processId;
    if (pid != null) {
      await store.upsert({ ...mapping, pid, pidCreatedAt: Date.now() });
    }
  }

  onUpdate();
}

async function autoLaunchPresets(
  store: SessionStore,
  onUpdate: () => void,
): Promise<void> {
  // Security: do not auto-launch in untrusted workspaces
  if (!vscode.workspace.isTrusted) {
    log("[auto-launch] skipped — workspace is not trusted");
    return;
  }

  const presets = getSessionPresets();
  const autoLaunch = presets.filter((p) => p.autoLaunch === true);
  if (autoLaunch.length === 0) return;

  let launched = 0;
  for (const preset of autoLaunch) {
    const userName = resolveUserName(preset.userName);
    const terminalName = prefixedName(preset.terminalName ?? preset.label, userName);
    const alreadyExists = vscode.window.terminals.some(
      (t) => t.name === terminalName,
    );
    if (alreadyExists) continue;

    // Validate cwd
    try {
      if (!fs.statSync(preset.cwd).isDirectory()) continue;
    } catch {
      continue;
    }

    // If sessionId set but file missing, skip
    if (preset.sessionId) {
      if (!isValidSessionId(preset.sessionId)) continue;
      if (lookupSessionFileSize(preset.cwd, preset.sessionId) === 0) continue;
    }

    await launchPreset(store, preset, onUpdate);
    launched++;
  }

  if (launched > 0) {
    vscode.window.showInformationMessage(
      `Terminal Session Recall: Auto-launched ${launched} preset(s).`,
    );
  }
}

// --- QuickPick ---

async function showQuickPick(
  store: SessionStore,
  projectPath: string,
  onUpdate: () => void,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("claudeResurrect");
  const maxSessions = config.get<number>("maxQuickPickSessions", 10);

  const activeItems = store.getActive(projectPath);
  const allByProject = store.getByProject(projectPath);
  const inactiveItems = [...allByProject]
    .filter((m) => m.status === "inactive")
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, maxSessions);
  const completedItems = [...allByProject]
    .filter((m) => m.status === "completed")
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, maxSessions);

  const discovered = discoverSessions(projectPath);
  const trackedIds = new Set(allByProject.map((m) => m.sessionId));
  const untrackedSessions = discovered
    .filter((d) => !trackedIds.has(d.sessionId) && d.fileSize > 0)
    .slice(0, maxSessions);

  const hasFile = (m: SessionMapping): boolean =>
    lookupSessionFileSize(projectPath, m.sessionId) > 0;

  const merged = [
    ...inactiveItems.filter(hasFile).map((m) => ({ lastSeen: m.lastSeen, kind: "tracked" as const, mapping: m })),
    ...untrackedSessions.map((d) => ({ lastSeen: d.lastSeen, kind: "discovered" as const, session: d })),
  ].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, maxSessions);

  type MenuAction = "new" | "continue" | "manage-presets" | "adopt" | "focus" | "resume-tracked" | "resume-discovered" | "launch-preset";

  interface MenuItem extends vscode.QuickPickItem {
    action: MenuAction;
    mapping?: SessionMapping;
    discovered?: DiscoveredSession;
    preset?: SessionPreset;
  }

  const items: MenuItem[] = [];

  // Actions
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
  items.push({
    label: "$(gear) Manage Presets",
    description: "Open preset editor panel",
    action: "manage-presets",
  });
  items.push({
    label: "$(plug) Adopt Running Session",
    description: "Attach to an existing terminal running Claude",
    action: "adopt",
  });

  // Presets section (Feature 5)
  const presets = getSessionPresets();
  if (presets.length > 0) {
    items.push({
      label: "Presets",
      kind: vscode.QuickPickItemKind.Separator,
      action: "new",
    });
    for (const preset of presets) {
      const hasSession = preset.sessionId
        ? lookupSessionFileSize(preset.cwd, preset.sessionId) > 0
        : true;
      items.push({
        label: `$(bookmark) ${preset.label}`,
        description: [
          preset.cwd,
          preset.sessionId ? preset.sessionId.slice(0, 8) : "new",
          preset.autoLaunch ? "auto" : "",
          !hasSession ? "$(warning) missing" : "",
        ].filter(Boolean).join(" · "),
        action: "launch-preset",
        preset,
      });
    }
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

  // Resumable section
  let remaining = maxSessions;
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
      // Lazy load: only read display info for items that will actually be shown
      const displayInfo = readSessionDisplayInfo(entry.session.projectPath, entry.session.sessionId);
      const discoveredDisplay = displayInfo.customTitle ?? entry.session.firstPrompt.slice(0, 40);
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

  // Completed section
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
    case "manage-presets":
      vscode.commands.executeCommand("claudeResurrect.managePresets");
      break;
    case "adopt":
      vscode.commands.executeCommand("claudeResurrect.adoptSession");
      break;
    case "continue": {
      const contUser = resolveUserName();
      const terminal = vscode.window.createTerminal({
        name: prefixedName("TS Recall: continue", contUser),
        cwd: projectPath,
        isTransient: true,
      });
      terminal.sendText(buildWrappedCommand(`${resolveClaudePath()} --continue`, getClaudeArgs(), projectPath, contUser));
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
    case "launch-preset":
      if (selected.preset) {
        await launchPreset(store, selected.preset, onUpdate);
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
