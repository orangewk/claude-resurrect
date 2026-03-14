import * as vscode from "vscode";
import type { SessionPreset } from "./types";
import { lookupSessionFileSize } from "./claude-dir";
import { isValidSessionId } from "./claude-dir";

/** Singleton panel instance */
let currentPanel: vscode.WebviewPanel | undefined;

/** Callback type for launching a preset */
export type LaunchPresetCallback = (preset: SessionPreset) => Promise<void>;

/**
 * Open (or reveal) the Manage Presets webview panel.
 */
export function openPresetsPanel(
  extensionUri: vscode.Uri,
  onLaunch: LaunchPresetCallback,
): void {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    sendPresets(currentPanel);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "claudeResurrect.presets",
    "Manage Presets",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  currentPanel = panel;

  panel.webview.html = getWebviewHtml(panel.webview);
  // NOTE: Do NOT call sendPresets() here — the webview JS has not loaded yet.
  // The webview sends a "ready" message once its JS initialises; we respond to that.

  // Listen for messages from webview
  panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
    switch (msg.type) {
      case "save": {
        const config = vscode.workspace.getConfiguration("claudeResurrect");
        await config.update("sessionPresets", msg.presets, vscode.ConfigurationTarget.Workspace);
        break;
      }
      case "remove": {
        const config = vscode.workspace.getConfiguration("claudeResurrect");
        const presets = config.get<SessionPreset[]>("sessionPresets", []);
        if (msg.index >= 0 && msg.index < presets.length) {
          const updated = presets.filter((_, i) => i !== msg.index);
          await config.update("sessionPresets", updated, vscode.ConfigurationTarget.Workspace);
        }
        break;
      }
      case "launch": {
        const presets = getPresets();
        if (msg.index >= 0 && msg.index < presets.length) {
          await onLaunch(presets[msg.index]);
        }
        break;
      }
      case "saveGlobalUserName": {
        const config = vscode.workspace.getConfiguration("claudeResurrect");
        await config.update("userName", msg.value || "", vscode.ConfigurationTarget.Workspace);
        break;
      }
      case "saveGlobalClaudeArgs": {
        const config = vscode.workspace.getConfiguration("claudeResurrect");
        const args = msg.value.trim() ? msg.value.trim().split(/\s+/) : [];
        await config.update("claudeArgs", args, vscode.ConfigurationTarget.Workspace);
        break;
      }
      case "saveGlobalShellWrapper": {
        const config = vscode.workspace.getConfiguration("claudeResurrect");
        await config.update("shellWrapper", msg.value, vscode.ConfigurationTarget.Workspace);
        break;
      }
      case "ready": {
        sendPresets(panel);
        break;
      }
      case "pickFolder": {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: "Select working directory",
          defaultUri: msg.currentPath ? vscode.Uri.file(msg.currentPath) : undefined,
        });
        if (uris && uris.length > 0) {
          void panel.webview.postMessage({
            type: "folderPicked",
            index: msg.index,
            path: uris[0].fsPath,
          });
        }
        break;
      }
    }
  });

  // Re-send data when config changes
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (currentPanel && (
      e.affectsConfiguration("claudeResurrect.sessionPresets") ||
      e.affectsConfiguration("claudeResurrect.userName") ||
      e.affectsConfiguration("claudeResurrect.claudeArgs") ||
      e.affectsConfiguration("claudeResurrect.shellWrapper")
    )) {
      sendPresets(currentPanel);
    }
  });

  panel.onDidDispose(() => {
    currentPanel = undefined;
    configListener.dispose();
  });
}

// --- Internal helpers ---

interface SaveMessage {
  type: "save";
  presets: SessionPreset[];
}

interface RemoveMessage {
  type: "remove";
  index: number;
}

interface LaunchMessage {
  type: "launch";
  index: number;
}

interface PickFolderMessage {
  type: "pickFolder";
  index: number;
  currentPath?: string;
}

interface SaveGlobalUserNameMessage {
  type: "saveGlobalUserName";
  value: string;
}

interface SaveGlobalClaudeArgsMessage {
  type: "saveGlobalClaudeArgs";
  value: string;
}

interface SaveGlobalShellWrapperMessage {
  type: "saveGlobalShellWrapper";
  value: string;
}

interface ReadyMessage {
  type: "ready";
}

type WebviewMessage = ReadyMessage | SaveMessage | RemoveMessage | LaunchMessage | PickFolderMessage | SaveGlobalUserNameMessage | SaveGlobalClaudeArgsMessage | SaveGlobalShellWrapperMessage;

function getPresets(): SessionPreset[] {
  return vscode.workspace
    .getConfiguration("claudeResurrect")
    .get<SessionPreset[]>("sessionPresets", []);
}

function sendPresets(panel: vscode.WebviewPanel): void {
  const config = vscode.workspace.getConfiguration("claudeResurrect");
  const presets = getPresets();
  // Annotate each preset with session file status
  const annotated = presets.map((p) => ({
    ...p,
    _sessionExists: p.sessionId
      ? isValidSessionId(p.sessionId) && lookupSessionFileSize(p.cwd, p.sessionId) > 0
      : true,
  }));
  void panel.webview.postMessage({
    type: "init",
    presets: annotated,
    globalUserName: config.get<string>("userName", ""),
    globalClaudeArgs: config.get<string[]>("claudeArgs", []),
    globalShellWrapper: config.get<string>("shellWrapper", "su - {user} -c 'cd {cwd} && {cmd}'"),
  });
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manage Presets</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    h2 {
      margin-bottom: 12px;
      font-weight: 600;
      font-size: 1.15em;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    button {
      font-family: inherit;
      font-size: inherit;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      padding: 6px 14px;
      border-radius: 2px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.icon-btn {
      padding: 4px 6px;
      background: transparent;
      color: var(--vscode-foreground);
      font-size: 16px;
      line-height: 1;
    }
    button.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    button.icon-btn.danger:hover { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th {
      text-align: left;
      padding: 8px 6px;
      font-weight: 600;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #444));
      white-space: nowrap;
    }
    td {
      padding: 4px 6px;
      vertical-align: middle;
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #333));
    }
    /* Column widths */
    .col-label { width: 12%; }
    .col-user { width: 8%; }
    .col-cwd { width: 22%; }
    .col-session { width: 14%; }
    .col-args { width: 14%; }
    .col-tname { width: 10%; }
    .col-auto { width: 6%; text-align: center; }
    .col-actions { width: 14%; text-align: right; }

    input[type="text"] {
      width: 100%;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 3px 6px;
      border-radius: 2px;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    input[type="checkbox"] {
      accent-color: var(--vscode-checkbox-background);
      cursor: pointer;
      width: 16px;
      height: 16px;
    }

    .cwd-cell {
      display: flex;
      gap: 2px;
      align-items: center;
    }
    .cwd-cell input { flex: 1; }
    .cwd-cell button { flex-shrink: 0; }

    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
      vertical-align: middle;
    }
    .status-ok { background: var(--vscode-testing-iconPassed, #4caf50); }
    .status-missing { background: var(--vscode-testing-iconFailed, #f44336); }
    .status-new { background: var(--vscode-charts-blue, #2196f3); }

    .empty-state {
      padding: 40px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state p { margin-bottom: 12px; }

    tr:hover { background: var(--vscode-list-hoverBackground); }
    .actions-cell { white-space: nowrap; }

    .global-settings {
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 4px;
      padding: 12px 16px;
      margin-bottom: 16px;
    }
    .global-settings h3 {
      font-size: 0.95em;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-descriptionForeground);
    }
    .global-field {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .global-field label {
      min-width: 80px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    .global-field input {
      flex: 1;
      max-width: 400px;
    }
  </style>
</head>
<body>
  <div class="global-settings">
    <h3>Global Settings</h3>
    <div class="global-field">
      <label>User Name:</label>
      <input type="text" id="global-userName" placeholder="System user (su). Empty = run as current user">
    </div>
    <div class="global-field">
      <label>CLI Args:</label>
      <input type="text" id="global-claudeArgs" placeholder="Global CLI args (e.g. --model opus)">
    </div>
    <div class="global-field">
      <label>Shell Wrapper:</label>
      <input type="text" id="global-shellWrapper" placeholder="su - {user} -c 'cd {cwd} && {cmd}'">
    </div>
  </div>

  <h2>Session Presets</h2>
  <div class="toolbar">
    <button id="add-btn">+ Add Preset</button>
  </div>
  <div id="content"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let presets = [];
    let globalUserName = '';
    let globalClaudeArgs = [];
    let globalShellWrapper = '';

    function render() {
      const container = document.getElementById('content');
      if (presets.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No presets configured.</p><p>Click <b>+ Add Preset</b> to create one, or use <b>Adopt Running Session</b> from the Command Palette.</p></div>';
        return;
      }

      let html = '<table><thead><tr>';
      html += '<th class="col-label">Label</th>';
      html += '<th class="col-user">User</th>';
      html += '<th class="col-cwd">Working Directory</th>';
      html += '<th class="col-session">Session ID</th>';
      html += '<th class="col-args">CLI Args</th>';
      html += '<th class="col-tname">Terminal Name</th>';
      html += '<th class="col-auto">Auto</th>';
      html += '<th class="col-actions">Actions</th>';
      html += '</tr></thead><tbody>';

      for (let i = 0; i < presets.length; i++) {
        const p = presets[i];
        const statusClass = !p.sessionId ? 'status-new' : (p._sessionExists ? 'status-ok' : 'status-missing');
        const statusTitle = !p.sessionId ? 'New session' : (p._sessionExists ? 'Session file exists' : 'Session file missing');

        html += '<tr>';
        html += '<td><input type="text" data-idx="' + i + '" data-field="label" value="' + esc(p.label || '') + '" placeholder="Preset name"></td>';
        html += '<td><input type="text" data-idx="' + i + '" data-field="userName" value="' + esc(p.userName || '') + '" placeholder="' + esc(globalUserName || 'current') + '"></td>';
        html += '<td><div class="cwd-cell"><input type="text" data-idx="' + i + '" data-field="cwd" value="' + esc(p.cwd || '') + '" placeholder="/path/to/project">';
        html += '<button class="icon-btn" data-action="pickFolder" data-idx="' + i + '" title="Browse...">&#128193;</button></div></td>';
        html += '<td><span class="status-dot ' + statusClass + '" title="' + statusTitle + '"></span>';
        html += '<input type="text" data-idx="' + i + '" data-field="sessionId" value="' + esc(p.sessionId || '') + '" placeholder="(empty = new)" style="width:calc(100% - 14px)"></td>';
        html += '<td><input type="text" data-idx="' + i + '" data-field="args" value="' + esc((p.args || []).join(' ')) + '" placeholder="--flag"></td>';
        html += '<td><input type="text" data-idx="' + i + '" data-field="terminalName" value="' + esc(p.terminalName || '') + '" placeholder="' + esc(p.label || 'auto') + '"></td>';
        html += '<td style="text-align:center"><input type="checkbox" data-idx="' + i + '" data-field="autoLaunch"' + (p.autoLaunch ? ' checked' : '') + '></td>';
        html += '<td class="actions-cell">';
        html += '<button class="icon-btn" data-action="launch" data-idx="' + i + '" title="Launch">&#9654;</button>';
        html += '<button class="icon-btn" data-action="moveUp" data-idx="' + i + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>';
        html += '<button class="icon-btn" data-action="moveDown" data-idx="' + i + '" title="Move down"' + (i === presets.length - 1 ? ' disabled' : '') + '>&#9660;</button>';
        html += '<button class="icon-btn danger" data-action="remove" data-idx="' + i + '" title="Remove">&#10005;</button>';
        html += '</td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      container.innerHTML = html;
    }

    function esc(str) {
      return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function collectPresets() {
      // Build presets array from current state (not from DOM inputs, from our presets variable)
      return presets.map(function(p) {
        const cleaned = { label: p.label || '', cwd: p.cwd || '' };
        if (p.userName) cleaned.userName = p.userName;
        if (p.shellWrapper) cleaned.shellWrapper = p.shellWrapper;
        if (p.sessionId) cleaned.sessionId = p.sessionId;
        if (p.args && p.args.length > 0) cleaned.args = p.args;
        if (p.terminalName) cleaned.terminalName = p.terminalName;
        if (p.autoLaunch) cleaned.autoLaunch = true;
        return cleaned;
      });
    }

    function savePresets() {
      vscode.postMessage({ type: 'save', presets: collectPresets() });
    }

    // Handle field changes
    document.addEventListener('change', function(e) {
      const el = e.target;
      const idx = parseInt(el.dataset.idx, 10);
      const field = el.dataset.field;
      if (isNaN(idx) || !field) return;

      if (field === 'autoLaunch') {
        presets[idx].autoLaunch = el.checked;
      } else if (field === 'args') {
        const val = el.value.trim();
        presets[idx].args = val ? val.split(/\\s+/) : [];
      } else {
        presets[idx][field] = el.value;
      }
      savePresets();
    });

    // Also save on blur for text inputs (handles tab-out without pressing Enter)
    document.addEventListener('focusout', function(e) {
      const el = e.target;
      if (el.tagName !== 'INPUT' || el.type !== 'text') return;
      const idx = parseInt(el.dataset.idx, 10);
      const field = el.dataset.field;
      if (isNaN(idx) || !field) return;

      if (field === 'args') {
        const val = el.value.trim();
        presets[idx].args = val ? val.split(/\\s+/) : [];
      } else {
        presets[idx][field] = el.value;
      }
      savePresets();
    });

    // Handle button clicks
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.idx, 10);

      if (action === 'remove') {
        vscode.postMessage({ type: 'remove', index: idx });
      } else if (action === 'launch') {
        vscode.postMessage({ type: 'launch', index: idx });
      } else if (action === 'pickFolder') {
        vscode.postMessage({ type: 'pickFolder', index: idx, currentPath: presets[idx].cwd || '' });
      } else if (action === 'moveUp' && idx > 0) {
        const tmp = presets[idx];
        presets[idx] = presets[idx - 1];
        presets[idx - 1] = tmp;
        savePresets();
        render();
      } else if (action === 'moveDown' && idx < presets.length - 1) {
        const tmp = presets[idx];
        presets[idx] = presets[idx + 1];
        presets[idx + 1] = tmp;
        savePresets();
        render();
      }
    });

    // Add preset button
    document.getElementById('add-btn').addEventListener('click', function() {
      presets.push({ label: '', cwd: '', args: [], autoLaunch: false, _sessionExists: true });
      savePresets();
      render();
      // Focus the label input of the new row
      setTimeout(function() {
        const inputs = document.querySelectorAll('input[data-field="label"]');
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
      }, 50);
    });

    // Global settings change handlers
    document.getElementById('global-userName').addEventListener('change', function(e) {
      vscode.postMessage({ type: 'saveGlobalUserName', value: e.target.value });
    });
    document.getElementById('global-userName').addEventListener('focusout', function(e) {
      vscode.postMessage({ type: 'saveGlobalUserName', value: e.target.value });
    });
    document.getElementById('global-claudeArgs').addEventListener('change', function(e) {
      vscode.postMessage({ type: 'saveGlobalClaudeArgs', value: e.target.value });
    });
    document.getElementById('global-claudeArgs').addEventListener('focusout', function(e) {
      vscode.postMessage({ type: 'saveGlobalClaudeArgs', value: e.target.value });
    });
    document.getElementById('global-shellWrapper').addEventListener('change', function(e) {
      vscode.postMessage({ type: 'saveGlobalShellWrapper', value: e.target.value });
    });
    document.getElementById('global-shellWrapper').addEventListener('focusout', function(e) {
      vscode.postMessage({ type: 'saveGlobalShellWrapper', value: e.target.value });
    });

    // Tell the extension we are ready to receive data
    vscode.postMessage({ type: 'ready' });

    // Messages from extension
    window.addEventListener('message', function(e) {
      const msg = e.data;
      if (msg.type === 'init') {
        presets = msg.presets || [];
        globalUserName = msg.globalUserName || '';
        globalClaudeArgs = msg.globalClaudeArgs || [];
        globalShellWrapper = msg.globalShellWrapper || '';
        // Update global settings inputs (only if not focused to avoid overwriting user typing)
        var userNameEl = document.getElementById('global-userName');
        if (document.activeElement !== userNameEl) userNameEl.value = globalUserName;
        var argsEl = document.getElementById('global-claudeArgs');
        if (document.activeElement !== argsEl) argsEl.value = globalClaudeArgs.join(' ');
        var wrapperEl = document.getElementById('global-shellWrapper');
        if (document.activeElement !== wrapperEl) wrapperEl.value = globalShellWrapper;
        render();
      } else if (msg.type === 'folderPicked') {
        if (msg.index >= 0 && msg.index < presets.length) {
          presets[msg.index].cwd = msg.path;
          savePresets();
          render();
        }
      }
    });
  </script>
</body>
</html>`;
}
