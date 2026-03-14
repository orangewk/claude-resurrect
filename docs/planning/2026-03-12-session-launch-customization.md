# Session Launch Customization (#54)

## Overview

Five enhancements to give users control over how Claude CLI sessions are launched, named, and tracked. All configuration is managed through the extension's UI (commands, QuickPick, input boxes) — no manual JSON editing required.

---

## Feature 1: Configurable CLI flags for session launch

### Goal

Allow users to specify extra `claude` CLI arguments (e.g. `--model`, `--verbose`, `--allowedTools`) that are applied when starting or resuming a session.

### Design

- New setting: `claudeResurrect.claudeArgs` (`string[]`, default: `[]`)
- Editable via a dedicated command: `claudeResurrect.editClaudeArgs` — opens a QuickPick/input flow to add, remove, or reorder flags
- Applied in both `startNewSession()` and `resumeSession()` by appending to the `sendText()` command string
- Args are shell-escaped before interpolation to prevent command injection

### Affected files

| File | Change |
|------|--------|
| `package.json` | Add `claudeResurrect.claudeArgs` setting + `claudeResurrect.editClaudeArgs` command |
| `src/extension.ts` | Read setting, append args in `startNewSession()` and `resumeSession()`, implement edit command |

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Command injection via malicious args | HIGH | Shell-escape all values; validate no shell metacharacters |
| Invalid flags crash CLI | LOW | Claude CLI exits gracefully on unknown flags |

---

## Feature 2: Custom user identity per session

### Goal

Allow specifying a user name / profile label for sessions, useful in shared or multi-profile environments.

### Design

- New setting: `claudeResurrect.userName` (`string`, default: `""`)
- Editable via command: `claudeResurrect.editUserName` — opens an input box to set the name
- Per-workspace setting (each workspace can have a different user label)
- Displayed as a prefix/label in QuickPick items and terminal tab names
- Display-only label for now; if Claude CLI adds a `--user` or `--profile` flag in the future, it can be forwarded automatically

### Affected files

| File | Change |
|------|--------|
| `package.json` | Add `claudeResurrect.userName` setting + `claudeResurrect.editUserName` command |
| `src/extension.ts` | Read setting, prepend to terminal name and QuickPick labels, implement edit command |
| `src/types.ts` | Add optional `userName` field to `SessionMapping` |
| `src/session-store.ts` | Persist `userName` through upsert |

---

## Feature 3: Terminal rename support

### Goal

Allow users to rename the VS Code terminal tab for a tracked session after creation.

### Design

- New command: `claudeResurrect.renameTerminal`
- Flow: QuickPick input box → user types new name → terminal is recreated or renamed via VS Code API
- The `SessionMapping.terminalName` field already exists, so store persistence is straightforward
- Also available as a QuickPick action in the session menu (pencil icon)
- **Preset sync**: When a terminal is renamed, the extension must also update the matching preset's `terminalName` field in `settings.json` (matched by `sessionId`). This ensures the preset and store stay consistent — the new name persists across restarts and is visible in the Settings UI.

### Implementation options

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | `workbench.action.terminal.rename` command | Native UX, simple | No programmatic control, no store update |
| B | Kill + recreate terminal with new name | Full control, store stays in sync | Interrupts running session |
| C | QuickPick input → update store only, set name on next restore | Non-disruptive | Name doesn't update until restart |

**Recommended**: Option A + store update. Trigger the native rename command, then listen for name changes to update the store.

### Affected files

| File | Change |
|------|--------|
| `package.json` | Register `claudeResurrect.renameTerminal` command |
| `src/extension.ts` | Implement rename command, update store after rename |
| `src/session-store.ts` | Add `updateTerminalName()` method (or reuse `upsert`) |

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| VS Code API doesn't expose terminal rename event | MEDIUM | Poll `terminal.name` or use `onDidChangeTerminalState` |
| Store gets out of sync | LOW | Reconcile on QuickPick open |
| Preset not updated on rename | MEDIUM | After store update, find matching preset by sessionId and update its `terminalName` in `settings.json` |

---

## Feature 4: Adopt already-running Claude sessions (creates a preset)

### Goal

Allow "capturing" a Claude CLI session that was started manually (not by the extension), making it trackable, editable, and relaunchable. Adopting a session **always creates a preset** — there is no separate "store-only" adoption. This ensures every tracked session is visible and editable through the Presets UI.

### Design

- New command: `claudeResurrect.adoptSession`
- Flow:
  1. List all open terminals not already tracked in a QuickPick
  2. User selects one
  3. Extension discovers session ID candidates by reading `~/.claude/history.jsonl` and matching the workspace path. If no candidates found, falls back to manual session ID input.
  4. User confirms the matched session ID (or picks from candidates)
  5. **Duplicate check**: If a preset with the same `sessionId` already exists, show a warning and abort (user can edit the existing preset via "Edit Preset")
  6. Extension **automatically creates a preset** with pre-filled values:
     - `label`: terminal name
     - `cwd`: current workspace path
     - `sessionId`: the confirmed session ID
     - `args`: `[]` (unknown for manually started sessions — user can edit later via "Edit Preset")
     - `terminalName`: current terminal name
     - `autoLaunch`: false
  7. Preset is saved to `settings.json` AND session is registered in `SessionStore` as `active` (for liveness tracking)
  8. PID is recorded from `terminal.processId` for liveness tracking
  9. The preset is immediately visible in the Presets section and fully editable

### Key decisions

- **Always creates a preset** — no optional prompt. Every adopted session becomes a reusable, editable preset.
- **Editable after adoption** — since args are unknown at adopt time, the user is expected to fill them in later via "Edit Preset" if needed.
- **Duplicate protection** — adopting the same session twice is blocked; user should use "Edit Preset" to modify the existing one.

### Affected files

| File | Change |
|------|--------|
| `package.json` | Register `claudeResurrect.adoptSession` command |
| `src/extension.ts` | Implement adopt flow: terminal selection, session discovery, duplicate check, preset creation, store registration |
| `src/claude-dir.ts` | Possibly add helper to find recent untracked sessions |

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Wrong session ID matched to terminal | MEDIUM | Show session details for user confirmation |
| Terminal has no Claude session running | LOW | Validate before adopting; show warning |
| PID mismatch (shell PID vs CLI PID) | LOW | Same limitation as existing implementation; shell PID is sufficient |
| Duplicate presets if adopting the same session twice | LOW | Check for existing preset with same sessionId; warn and abort |
| User wants to change args after adopt | LOW | "Edit Preset" command is already available |

---

## Feature 5: Session presets / templates

### Goal

Allow users to define a list of pre-configured session templates that can be launched with a single click from the QuickPick menu. This automates the common manual workflow of `cd <dir> && claude --resume <id> --flags`. Presets are also the unified storage for adopted sessions (Feature 4).

### Example use case

Instead of manually typing:
```bash
cd /home/code/workspaces/directus-ws/vue-directus-frontend
claude --resume 9a2ece9f-4dde-48d3-a978-66aa716a53e0 --dangerously-skip-permissions
```

The user selects "Directus Frontend" from the Presets section in QuickPick.

### Design

#### Preset management — all from the extension UI

Presets are stored in `settings.json` under `claudeResurrect.sessionPresets`, but users **never edit JSON manually**. All CRUD operations happen through extension commands:

- **`claudeResurrect.addPreset`** — Guided flow:
  1. Input box: label (display name)
  2. Folder picker: cwd (working directory)
  3. Input box: session ID (optional — leave empty for new sessions)
  4. Input box: CLI args (space-separated, optional)
  5. Input box: terminal name (optional, defaults to label)
  6. Checkbox: auto-launch on startup? (yes/no)
  7. Saves to settings

- **`claudeResurrect.editPreset`** — QuickPick lists existing presets → select one → same guided flow pre-filled with current values

- **`claudeResurrect.removePreset`** — QuickPick lists existing presets → select one → confirmation → remove

- **`claudeResurrect.launchPreset`** — QuickPick lists presets → select → launch immediately

- **`claudeResurrect.adoptSession`** — Adopting a running session automatically creates a preset (see Feature 4)

Also accessible: QuickPick menu gains a **"Presets"** section (between Actions and Active) with all presets listed. A gear icon action on each preset opens `editPreset`.

#### Preset data structure

```jsonc
// Stored in settings.json (managed by extension, not edited manually)
"claudeResurrect.sessionPresets": [
  {
    "label": "Directus Frontend",
    "cwd": "/home/code/workspaces/directus-ws/vue-directus-frontend",
    "sessionId": "9a2ece9f-4dde-48d3-a978-66aa716a53e0",
    "args": ["--dangerously-skip-permissions"],
    "terminalName": "Claude: Directus FE",
    "autoLaunch": true
  },
  {
    "label": "Backend API",
    "cwd": "/home/code/workspaces/api-server",
    "args": ["--model", "opus", "--verbose"],
    "terminalName": "Claude: API",
    "autoLaunch": false
  }
]
```

#### Preset fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | `string` | Yes | Display name in QuickPick menu |
| `cwd` | `string` | Yes | Working directory — terminal opens here |
| `sessionId` | `string` | No | If set, launches with `--resume <sessionId>`. If omitted, starts a new session |
| `args` | `string[]` | No | Extra CLI flags appended to the command |
| `terminalName` | `string` | No | Custom terminal tab name. Defaults to `label` |
| `autoLaunch` | `boolean` | No | If `true`, this preset launches automatically on VS Code startup. Default: `false` |

#### Auto-launch on startup

During `activate()`, after the existing auto-restore flow:
1. Read `sessionPresets` from settings
2. Filter presets where `autoLaunch === true`
3. For each auto-launch preset:
   - Skip if a terminal with the same name is already open (prevent duplicates)
   - If `sessionId` is set, verify the session file exists; if not, skip with a warning
   - Launch the preset (create terminal, send command, register in store)
4. Show info message: "Auto-launched N preset(s)"

#### Session ID handling

- If `sessionId` is set but the session file no longer exists → **skip silently** (don't launch, don't fall back to new session). The preset becomes a "dead" entry — user can edit or remove it.
- QuickPick shows a warning icon on presets with missing session files

#### QuickPick integration

- New section: **"Presets"** (shown between Actions and Active sections)
- Each preset shown with a bookmark icon and its label
- Inline actions per preset: launch (play icon), edit (gear icon), remove (trash icon)
- Selecting a preset launches it:
  1. Creates a terminal with `cwd` and `terminalName`
  2. Sends `claude --resume <sessionId> <args>` or `claude --session-id <uuid> <args>`
  3. Inserts the mapping into `SessionStore` as `active`

#### Validation

- `cwd` must be an existing directory (warn and skip if not)
- `sessionId` must pass `isValidSessionId()` if provided
- `args` values are shell-escaped

### Affected files

| File | Change |
|------|--------|
| `package.json` | Add `claudeResurrect.sessionPresets` setting + 4 preset commands |
| `src/types.ts` | Add `SessionPreset` interface |
| `src/extension.ts` | Preset CRUD commands, QuickPick section, launch logic, auto-launch in `activate()` |

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Command injection via `args` or `cwd` | HIGH | Shell-escape args; validate cwd exists and is a directory |
| Stale `sessionId` (session file deleted) | LOW | Skip with warning; don't fall back to new session |
| Large preset list clutters QuickPick | LOW | Collapse under a submenu if > 5 presets |
| Auto-launch creates unwanted terminals | MEDIUM | Only launch if `autoLaunch: true`; skip duplicates; show info message |

---

## Feature 6: Webview UI for preset management

### Problem

VS Code's Settings UI renders `sessionPresets` as a raw JSON array. Users cannot:

- Find where presets are stored
- Edit preset fields without understanding JSON structure
- See which presets are active, stale, or auto-launching
- Perform actions (launch, reorder, toggle) inline

The Settings UI does not support rich editing for `object[]` types — it always falls back to raw JSON. This makes the current preset management **unusable** for non-technical users.

### Solution: Dedicated Webview panel

A Webview panel launched via command: `claudeResurrect.managePresets` ("Claude Resurrect: Manage Presets").

Also accessible from the QuickPick menu as a "Manage Presets" action in the Actions section:

```
Actions
  $(add) New Session
  $(debug-continue) Continue Last
  $(gear) Manage Presets          ← opens the Webview
```

#### UI layout

Table-based view with one row per preset:

| Column | Type | Notes |
|--------|------|-------|
| Label | Editable text | Display name |
| CWD | Text + folder picker button | Working directory |
| Session ID | Text (read-only or editable) | UUID, truncated display |
| Args | Editable text | Space-separated CLI flags |
| Terminal Name | Editable text | Custom tab name |
| Auto-launch | Toggle switch | On/off |

#### Row actions

- **Launch** (play icon) — launches the preset immediately
- **Edit** (pencil icon) — makes the row editable inline
- **Remove** (trash icon) — deletes the preset with confirmation
- **Move up / Move down** (arrows) — reorders presets

#### Top-level actions

- **Add Preset** button — adds an empty row for inline editing
- **Import from running terminal** — shortcut to `adoptSession`

#### Visual indicators

- Warning icon on presets with missing session files
- Green dot on auto-launch presets
- Grayed-out row for presets with invalid `cwd`

#### Technical design

- Webview HTML/CSS/JS bundled as static assets in `media/` directory
- Message passing between extension host and webview via `postMessage` / `onDidReceiveMessage`
- All writes go through `vscode.workspace.getConfiguration().update()` to persist to `settings.json`
- Webview reads initial state from `settings.json` on open; listens for `onDidChangeConfiguration` to stay in sync

### Affected files

| File | Change |
|------|--------|
| `package.json` | Register `claudeResurrect.managePresets` command |
| `src/extension.ts` | Add "Manage Presets" to QuickPick Actions; implement webview panel creation |
| `src/preset-webview.ts` | New file — webview panel provider, message handling, state sync |
| `media/presets.html` | New file — webview HTML template |
| `media/presets.css` | New file — webview styles (VS Code theme-aware) |
| `media/presets.js` | New file — webview client-side logic |

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Webview state out of sync with settings.json | MEDIUM | Re-read settings on every focus; listen for config changes |
| Complex implementation (HTML/CSS/JS + message passing) | HIGH | Keep initial version simple — table only, no drag-and-drop |
| CSP restrictions in webview | LOW | Use VS Code's `webview.asWebviewUri()` for all assets |
| Folder picker not available in webview | MEDIUM | Send message to extension host to open native folder picker, return result |

---

## Feature 7: Per-preset userName (run-as user)

### Problem

The `userName` setting is currently **global only** (workspace-level). It serves as a display prefix for terminal names. However, in practice it has a critical functional role: the `--dangerously-skip-permissions` flag only works when Claude Code runs as a non-root user. Different presets may need to run as different system users.

With only a global `userName`, all presets share the same user identity. There is no way to configure one preset to run as "john" and another as "admin".

### Solution: Add `userName` field to `SessionPreset`

#### Data model change

Add an optional `userName` field to the `SessionPreset` interface:

```typescript
export interface SessionPreset {
  readonly label: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly args?: readonly string[];
  readonly terminalName?: string;
  readonly autoLaunch?: boolean;
  readonly userName?: string;  // ← NEW: overrides global userName for this preset
}
```

#### Resolution logic

When launching a preset, the effective userName is resolved as:

```
preset.userName  →  (if set) use this
                 →  (if empty/undefined) fall back to global claudeResurrect.userName
```

This mirrors how `args` already works: preset-level overrides global-level.

#### Webview integration

Add a **"User"** column to the Webview preset table (between "Label" and "CWD"):

| Column | Type | Notes |
|--------|------|-------|
| User | Editable text | Per-preset user identity. Empty = use global setting |

The column should show the global `userName` as placeholder text when the field is empty, so the user can see the effective value.

#### Global userName in Webview header

Add a **global settings section** at the top of the Webview panel (above the table):

```
Global Settings
  User Name: [____________]    ← edits claudeResurrect.userName
  CLI Args:  [____________]    ← edits claudeResurrect.claudeArgs (read-only display / link to edit)
```

This gives users a single place to manage both global defaults and per-preset overrides.

### Affected files

| File | Change |
|------|--------|
| `src/types.ts` | Add `userName?: string` to `SessionPreset` |
| `package.json` | Add `userName` to `sessionPresets` item schema |
| `src/extension.ts` | Update `launchPreset()` and `prefixedName()` to use preset-level userName with global fallback |
| `src/preset-webview.ts` | Add "User" column; add global settings section at top of Webview |

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Confusion between global and per-preset userName | LOW | Show global value as placeholder in empty per-preset field |
| Breaking change to preset data structure | LOW | Field is optional; existing presets without it continue to work (fall back to global) |

---

## Feature 8: userName as actual system user (su)

### Problem

Currently `userName` is only a **display prefix** in terminal names. It has no functional effect — the session always runs as the current OS user (typically root in containers). This breaks `--dangerously-skip-permissions`, which refuses to run as root.

Users expect that setting `userName` to e.g. `"code"` will cause the Claude CLI session to actually run as that system user.

### Solution: Execute via `su <userName> -c "..."`

When a `userName` is set (either globally or per-preset), the terminal command must be wrapped with `su`:

#### Current behavior (broken)

```bash
claude --resume <id> --dangerously-skip-permissions
# → runs as root → --dangerously-skip-permissions refuses to run
```

#### New behavior

```bash
su code -c 'claude --resume <id> --dangerously-skip-permissions'
# → runs as user "code" → --dangerously-skip-permissions works
```

### Design

#### Command construction

Modify `buildCommand()` (or add a wrapper) to support user switching:

```typescript
function buildCommandAsUser(
  base: string,
  extraArgs: readonly string[],
  userName?: string,
): string {
  const cmd = buildCommand(base, extraArgs);
  if (!userName) return cmd;
  // Wrap entire command in su
  return `su ${shellEscape(userName)} -c ${shellEscape(cmd)}`;
}
```

#### Resolution order (same as Feature 7)

1. `preset.userName` (if set) → use this
2. Global `claudeResurrect.userName` (if set) → use this
3. Neither set → run as current user (no `su` wrapping)

#### Affected call sites

Every place that sends a command to a terminal must use the new wrapper:

- `startNewSession()` — uses global userName
- `resumeSession()` — uses global userName (or preset-level if called from `launchPreset`)
- `launchPreset()` — uses `preset.userName ?? globalUserName`
- `autoLaunchPresets()` — same as `launchPreset()`
- QuickPick "Continue Last" action

#### Validation

- `userName` must be a valid Unix username (`/^[a-z_][a-z0-9_-]*$/`)
- The system user must exist (check via `id <userName>` before launching)
- If the user doesn't exist, show a warning and abort

### Affected files

| File | Change |
|------|--------|
| `src/extension.ts` | Add `buildCommandAsUser()`, update all `sendText()` call sites, add user validation |

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `su` requires password on some systems | MEDIUM | In containerized environments (VS Code Remote), `su` typically works without password. Warn user if it fails |
| Command injection via userName | HIGH | Validate against strict Unix username regex; shell-escape the value |
| User doesn't exist on system | LOW | Validate with `id <userName>` before launching; show clear error |
| Different shell environment for target user | LOW | `su <user> -c` inherits the target user's shell. This is expected behavior |

---

## Feature 9: Configurable shell command wrapper (replaces hardcoded `su`)

### Problem

Feature 8 implemented `su - <userName> -c '<command>'` wrapping to run Claude as a non-root system user. This works in some environments but **fails in practice** due to two issues:

#### Issue 1: CWD not inherited by `su -c`

When the extension runs:
```bash
su - abc -c '/config/.nvm/versions/node/v18.20.8/bin/claude --resume 4793ec08-... --dangerously-skip-permissions'
```

The `su - abc` switches to abc's home directory (`/config`), not the preset's CWD (`/home/code/workspaces/Directus-WS`). Claude resolves sessions based on CWD → `~/.claude/projects/<slug>/`, so with the wrong CWD it produces:
```
No conversation found with session ID: 4793ec08-...
```

Meanwhile, when the user manually opens an `abc-user` terminal profile (configured in VS Code settings as `su - abc -c 'cd /home/code/workspaces && exec bash'`) and runs `claude --resume ...` there, it works because the CWD is correct.

#### Issue 2: Hardcoded `su` is not universal

The `su` approach is specific to containerized environments like code-server where:
- The VS Code server runs as root
- A non-root user (`abc`) is created for running Claude with `--dangerously-skip-permissions`
- `su` from root to abc works without password

This does not apply to most users. The hardcoded `su` wrapper is an environment-specific hack, not a general solution.

### Solution: User-configurable shell command wrapper

Replace the hardcoded `su` logic with a **configurable command template** that the user defines. This covers `su`, `sudo`, `ssh`, Docker exec, or any custom wrapper.

#### New setting: `claudeResurrect.shellWrapper`

A string template with placeholders:

| Placeholder | Replaced with |
|-------------|---------------|
| `{cmd}` | The full claude command (already shell-escaped) |
| `{cwd}` | The working directory for this session |
| `{user}` | The resolved userName (preset-level or global) |

**Default value** (matches the current code-server environment for testing):
```
su - {user} -c 'cd {cwd} && {cmd}'
```

**Examples for other environments:**

| Environment | shellWrapper value |
|---|---|
| code-server (su) | `su - {user} -c 'cd {cwd} && {cmd}'` |
| sudo | `sudo -u {user} bash -c 'cd {cwd} && {cmd}'` |
| No wrapping needed | (leave empty — commands run directly) |

#### Behavior

- If `shellWrapper` is **empty or unset** AND `userName` is **empty**: command runs directly (no wrapping). This is the default for most users.
- If `shellWrapper` is **empty or unset** AND `userName` is **set**: use built-in default `su - {user} -c 'cd {cwd} && {cmd}'`
- If `shellWrapper` is **set**: always use the template, replacing placeholders

#### Per-preset override

Add optional `shellWrapper` field to `SessionPreset` for per-preset override, same pattern as `userName` and `args`.

#### Data model changes

```typescript
// Global setting
"claudeResurrect.shellWrapper": {
  "type": "string",
  "default": "su - {user} -c 'cd {cwd} && {cmd}'",
  "description": "Shell command template for running Claude as a different user. Placeholders: {cmd}, {cwd}, {user}. Leave empty to run directly."
}

// SessionPreset addition
export interface SessionPreset {
  // ... existing fields ...
  readonly shellWrapper?: string;  // overrides global shellWrapper
}
```

#### Implementation

Replace `buildCommandAsUser()` with `buildWrappedCommand()`:

```typescript
function buildWrappedCommand(
  base: string,
  extraArgs: readonly string[],
  cwd: string,
  userName?: string,
  shellWrapperOverride?: string,
): string {
  const cmd = buildCommand(base, extraArgs);
  const wrapper = shellWrapperOverride || getShellWrapper();

  // No wrapper and no user → run directly
  if (!wrapper && !userName) return cmd;

  // Has user but no explicit wrapper → use default template
  const template = wrapper || "su - {user} -c 'cd {cwd} && {cmd}'";

  return template
    .replace(/\{cmd\}/g, cmd)
    .replace(/\{cwd\}/g, shellEscape(cwd))
    .replace(/\{user\}/g, userName ? shellEscape(userName) : '');
}
```

### Why Feature 8 must be replaced

Feature 8's `su` wrapping had three bugs:
1. **Missing CWD** — `su - user -c 'claude ...'` doesn't `cd` to the preset CWD, so Claude can't find the session
2. **Not configurable** — hardcoded `su` doesn't work in environments that use `sudo`, Docker, or no wrapping at all
3. **PATH issues** — `su -` resets PATH; required `resolveClaudePath()` hack with `which claude` to get absolute path

The `shellWrapper` template solves all three: the user controls the exact command, including `cd`, user switching, and PATH handling.

### Affected files

| File | Change |
|------|--------|
| `package.json` | Add `claudeResurrect.shellWrapper` setting; add `shellWrapper` to preset schema |
| `src/types.ts` | Add `shellWrapper?: string` to `SessionPreset` |
| `src/extension.ts` | Replace `buildCommandAsUser()` with `buildWrappedCommand()`; update all call sites; remove `su`-specific code |
| `src/preset-webview.ts` | Add "Shell Wrapper" field to global settings; add column or field to preset table |

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Command injection via template | HIGH | Placeholders are replaced with shell-escaped values; warn user that shellWrapper is powerful |
| Broken template syntax | MEDIUM | Validate template contains `{cmd}` at minimum; show error if not |
| Default template breaks for non-code-server users | LOW | Default only activates when `userName` is set; most users won't set userName |

---

## Implementation order

| Phase | Feature | Complexity | Dependencies |
|-------|---------|-----------|--------------|
| 1 | CLI flags (`claudeArgs`) | Low | None |
| 2 | User identity (`userName`) | Low | None |
| 3 | Terminal rename | Medium | None |
| 4 | Adopt running sessions (creates preset) | Medium | `claude-dir.ts` session discovery, Feature 5 preset storage |
| 5 | Session presets + auto-launch | Medium-High | Feature 1 (shares arg-handling logic) |
| 6 | Webview UI for preset management | High | Feature 5 (preset data structure must be stable first) |
| 7 | Per-preset userName | Low | Feature 5 (preset data model), Feature 6 (Webview UI for display) |
| 8 | userName as actual system user (`su`) | Medium | Feature 7 (userName field must exist first) — **SUPERSEDED by Feature 9** |
| 9 | Configurable shell command wrapper | Medium | Feature 7 (userName), replaces Feature 8 |

Phases 1-2 are independent and can be developed in parallel. Phase 3 is independent. Phases 4 and 5 share the preset data structure and should be developed together. Phase 6 depends on Phase 5. **Phases 7 and 9 should be implemented together** — Feature 7 adds the `userName` field, and Feature 9 replaces Feature 8's hardcoded `su` with a user-configurable shell wrapper template. Feature 8 is superseded and should not be implemented separately.

## Quality gate

All changes must pass before merge: `npm run typecheck && npm run test && npm run compile`

---

## Testing checklist (v1.1.0)

Tests are ordered to avoid VS Code restarts — restart-dependent tests are at the end.

### No-restart tests (can test with running sessions)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | New session launch (QuickPick → New Session) | PASS | Claude started in new terminal |
| 2 | Manage Presets webview opens with existing presets | PASS (v1.1.0) | Fixed in v1.1.0 with `ready` message handshake. Was FAIL in previous build. |
| 3 | Add preset via webview — save persists to settings.json | PASS | |
| 4 | Edit preset fields via webview (label, CWD, args, userName, terminalName) | PASS | |
| 5 | Remove preset via webview | PASS | |
| 6 | Launch preset via webview (play button) | PASS | |
| 7 | Launch preset via QuickPick (Launch Preset) | PASS | If already running, focuses existing terminal |
| 8 | Preset with sessionId → `--resume` passed correctly, session continues | PASS | |
| 9 | Global claudeArgs → all sessions receive the flags | PASS | |
| 10 | Per-preset args override | — | Not explicitly tested |
| 11 | userName + shellWrapper → command wrapped correctly | PASS | `su - abc -c 'cd ... && ...'` works |
| 12 | Per-preset userName override | — | Not explicitly tested |
| 13 | Per-preset shellWrapper override | — | Not explicitly tested |
| 14 | No userName set → command runs directly | — | Not tested (user always needs userName) |
| 15 | Adopt running session | FAIL | Path mismatch bug — `discoverSessions()` exact match on workspace root misses subfolder sessions. See bug report. |
| 16 | Terminal rename → preset updated | FAIL | Rename did not rename terminal; did not update preset. Also shows non-preset terminals. See bug report. |
| 17 | Webview global settings sync to settings.json | PASS | Works but ConfigurationTarget inconsistency (see anomaly report) |
| 18 | QuickPick menu — all actions visible | PASS | 12 items shown |

### Restart-dependent tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 19 | Auto-launch presets on VS Code startup (autoLaunch: true) | PARTIAL | Reload Window triggers auto-launch of `autoLaunch: true` presets. However, see bug below about terminal name inconsistency on reload. |
| 20 | Auto-restore existing sessions on VS Code restart | DEFERRED | Full restart not tested yet |

---

## Bug: Terminal names lose userName prefix after Reload Window

### Problem

When a preset is launched, the terminal name includes the userName prefix via `prefixedName()` — e.g. `[abc] My Preset`. However, after **Reload Window**, the auto-launched presets create terminals with only the preset's `terminalName` field value (e.g. `My Preset`) without the `[abc]` prefix.

This suggests that the auto-launch code path on startup applies `prefixedName()` differently, or that the `terminalName` stored in the preset already contains the prefix from the first launch, but on reload the name resolution works differently.

### Expected behavior

Terminal names should be consistent between first launch and auto-launch after reload. If the userName prefix is applied dynamically via `prefixedName()`, it should be applied identically in both code paths.

### Investigation needed

- Check whether `autoLaunchPresets()` calls `prefixedName()` the same way as `launchPreset()`
- Check whether the preset's `terminalName` field gets saved with or without the prefix — if it includes the prefix, then `prefixedName()` would double-prefix on first launch but not on reload (or vice versa)

---

## Cleanup: Remove redundant Command Palette commands

### Problem

With the Webview preset manager (Feature 6), several Command Palette commands are now redundant. The webview handles all preset CRUD operations more intuitively. Having both creates confusion and duplicate code paths.

### Commands to remove

| Command | Reason |
|---------|--------|
| `claudeResurrect.addPreset` | Replaced by webview "Add Preset" button |
| `claudeResurrect.editPreset` | Replaced by inline editing in webview |
| `claudeResurrect.removePreset` | Replaced by webview Remove (X) button |
| `claudeResurrect.renameTerminal` | Broken (see bug report); should be replaced by native rename + preset sync |
| `claudeResurrect.editClaudeArgs` | Replaced by webview global settings section |
| `claudeResurrect.editUserName` | Replaced by webview global settings section |

### Commands to keep

| Command | Reason |
|---------|--------|
| `claudeResurrect.newSession` | Core functionality |
| `claudeResurrect.showMenu` | Main QuickPick entry point |
| `claudeResurrect.launchPreset` | Quick launch without opening webview |
| `claudeResurrect.managePresets` | Opens webview |
| `claudeResurrect.adoptSession` | Attach to running terminal |
| `claudeResurrect.dumpState` | Debug tool |

---

## Bug: Status bar "live" count only shows sessions matching workspace root

### Problem

The status bar uses `store.getByProject(projectPath)` where `projectPath` is the first workspace folder (e.g. `/home/code/workspaces`). The `getByProject()` method does an **exact path match** via `normalizePath()`.

However, `launchPreset()` stores `projectPath: preset.cwd` (e.g. `/home/code/workspaces/project-a`). Since the preset CWD is a subfolder of the workspace root, the exact match fails and the session is not counted as "live".

### Root cause

The status bar was designed before presets existed, when all sessions were started in the workspace root. The per-project filtering made sense then but is now incorrect.

### Fix

The status bar should count **all active sessions in the store**, regardless of project path. The store only contains sessions started by this extension, so no further filtering is needed.

Change `updateStatusBar()`:
```typescript
// Before (broken):
const tracked = store.getByProject(projectPath);
const live = tracked.filter((m) => m.status === "active").length;

// After (correct):
const all = store.getAll();
const live = all.filter((m) => m.status === "active").length;
```

The `projectPath` guard (`if (!projectPath)`) can remain — we still need a workspace to be open for the extension to function.

---

## Bug: Adopt session fails to find sessions in workspace subfolders

### Problem

The "Adopt Running Session" command calls `discoverSessions(projectPath)` where `projectPath` is the workspace root (e.g. `/home/code/workspaces`). However, sessions started in subfolders (e.g. `/home/code/workspaces/kiosk-bom-mvp`) are recorded in `~/.claude/history.jsonl` with the actual CWD as the `project` field.

`discoverSessions()` in `claude-dir.ts` line 53 does an **exact match**:
```typescript
if (normalizePath(entry.project) !== normalizedWorkspace) continue;
```

This filters out all sessions that run in subfolders of the workspace → no candidates found → user gets "No untracked sessions found" or is asked for manual session ID input.

### Second problem: adopted preset gets wrong CWD

In the adopt flow (`extension.ts` line 378), the new preset is created with:
```typescript
cwd: projectPath,  // ← workspace root, not the session's actual directory
```

Even if the session were found, the preset would have the wrong CWD. The correct CWD is available in `history.jsonl` as `entry.project`.

### Additional finding

The bug occurs not only for brand-new sessions (never resumed), but also for sessions that have been resumed before. The `discoverSessions()` exact match on workspace root vs actual CWD consistently fails for any session in a subfolder, regardless of session history.

### Fix

1. **`discoverSessions()` in `claude-dir.ts`**: Change exact match to `startsWith` — accept history entries whose `project` path starts with the workspace root path.

2. **`DiscoveredSession` type**: Add `projectPath` field so the caller knows the session's actual CWD.

3. **Adopt flow in `extension.ts`**: Use the discovered session's `projectPath` as the preset `cwd` instead of the workspace root:
```typescript
// Before (broken):
cwd: projectPath,

// After (correct):
cwd: selectedSession.session.projectPath,
```

---

## Anomaly: Inconsistent ConfigurationTarget across commands and webview

The `editUserName` command saves `userName` at **User** level (global), while the webview's global settings section saves to **Workspace** level (`ConfigurationTarget.Workspace`). This means:

- Setting userName via command → appears in Settings **User** tab
- Setting userName via webview → appears in Settings **Workspace** tab
- The two can coexist with different values (Workspace overrides User)

The same inconsistency may apply to `editClaudeArgs`. All write paths should use the same `ConfigurationTarget` — preferably `Workspace`, since these settings are typically per-project.

---

## Bug: Terminal rename does not update matching preset

### Problem

Renaming a terminal via the `claudeResurrect.renameTerminal` command does not correctly update the corresponding preset's `terminalName` in `settings.json`. The preset retains the old name after rename.

### Expected behavior

When a terminal is renamed, the extension should find the matching preset (by `sessionId`) and update its `terminalName` field in `settings.json` to reflect the new name.

### Additional findings

- The rename command allows selecting terminals that are not in presets — this is confusing since the rename has no effect for non-preset terminals.
- The rename command did not actually rename the running terminal even when it was a preset terminal.
- **Suggestion**: Remove the dedicated rename command from QuickPick. Instead, hook into VS Code's native terminal rename and sync the new name back to the matching preset automatically.
