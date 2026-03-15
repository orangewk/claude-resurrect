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
| 2 | Manage Presets webview opens with existing presets | PASS | Fixed in v1.1.0 with `ready` message handshake |
| 3 | Add preset via webview — save persists to settings.json | PASS | |
| 4 | Edit preset fields via webview (label, CWD, args, userName, terminalName) | PASS | |
| 5 | Remove preset via webview | PASS | |
| 6 | Launch preset via webview (play button) | PASS | |
| 7 | Launch preset via QuickPick (Launch Preset) | PASS | If already running, focuses existing terminal |
| 8 | Preset with sessionId → `--resume` passed correctly, session continues | PASS | |
| 9 | Global claudeArgs → all sessions receive the flags | PASS | |
| 10 | Per-preset args override | PASS | Preset args added alongside global claudeArgs |
| 11 | userName + shellWrapper → command wrapped correctly | PASS | `su - abc -c 'cd ... && ...'` works |
| 12 | Per-preset userName override | — | Not explicitly tested (user always uses global userName) |
| 13 | Per-preset shellWrapper override | — | Not explicitly tested (user always uses global shellWrapper) |
| 14 | No userName set → command runs directly | — | Not tested (user always needs userName) |
| 15 | Adopt running session | PASS | Process inspector auto-detects session ID + CWD on Linux |
| 16 | Terminal rename → preset updated | PASS | 2-second polling detects rename, updates store + preset. Verified by log. |
| 17 | Webview global settings sync to settings.json | PASS | ConfigurationTarget inconsistency fixed — all paths use Workspace |
| 18 | QuickPick menu — all actions visible | PASS | Includes "Adopt Running Session" in Actions |
| 19 | QuickPick responsiveness | PASS | maxQuickPickSessions (default 10) + lazy readSessionDisplayInfo |
| 20 | Adopt: process inspector auto-detect (Linux) | PASS | Auto-adopt with session ID from procfs |
| 21 | Adopt: user + args populated in preset | PASS | Args extracted from session JSONL (permissionMode, model) |

### Restart-dependent tests

| # | Test | Status | Notes |
|---|------|--------|-------|
| 22 | Auto-launch presets on VS Code startup (autoLaunch: true) | PASS | Full VS Code restart tested |
| 23 | Auto-restore existing sessions on VS Code restart | PASS | Full VS Code restart tested, notification shown, session resumed with --resume |

---

## Bug: Terminal names lose userName prefix after Reload Window — ✅ FIXED

### Problem

When a preset is launched, the terminal name includes the userName prefix via `prefixedName()` — e.g. `[abc] My Preset`. However, after **Reload Window**, the auto-launched presets create terminals with only the preset's `terminalName` field value (e.g. `My Preset`) without the `[abc]` prefix.

### Resolution

Verified that both `autoLaunchPresets()` and `launchPreset()` call `prefixedName()` identically. The code paths are now consistent.

---

## Cleanup: Remove redundant Command Palette commands — ✅ DONE

Redundant commands removed. Remaining registered commands:

| Command | Purpose |
|---------|---------|
| `claudeResurrect.showMenu` | Main QuickPick entry point (status bar click) |
| `claudeResurrect.newSession` | Start new Claude session |
| `claudeResurrect.adoptSession` | Attach to running terminal |
| `claudeResurrect.launchPreset` | Quick launch preset |
| `claudeResurrect.managePresets` | Open webview preset editor |
| `claudeResurrect.dumpState` | Debug: dump globalState |

---

## Bug: Status bar "live" count only shows sessions matching workspace root — ✅ FIXED

Changed `updateStatusBar()` to use `store.getAll()` instead of `store.getByProject(projectPath)`. Now counts all active sessions regardless of project path.

---

## Bug: Adopt session fails to find sessions in workspace subfolders — ✅ FIXED

Fixed in three places:
1. `discoverSessions()`: changed exact match to `startsWith` for workspace prefix matching
2. `DiscoveredSession` type: added `projectPath` field for actual session CWD
3. Adopt flow: uses `selectedSession.session.projectPath` (or `detected.cwd` from process inspector) as preset CWD

---

## Anomaly: Inconsistent ConfigurationTarget across commands and webview — ✅ FIXED

The old `editUserName` and `editClaudeArgs` commands (which used User-level target) have been removed. All remaining config writes use `ConfigurationTarget.Workspace` consistently.

---

## UX: Add "Adopt Session" to QuickPick menu — ✅ DONE

Added `$(plug) Adopt Running Session` to QuickPick Actions section. New `"adopt"` action type in MenuItem, dispatches to `claudeResurrect.adoptSession` command.

---

## Performance: QuickPick slow due to unbounded session discovery — ✅ FIXED

Added `claudeResurrect.maxQuickPickSessions` setting (default: 10). Applied `.slice(0, maxSessions)` to inactive, discovered, and merged lists before expensive I/O.

---

## Performance: discoverSessions reads all session JSONL files eagerly — ✅ FIXED

Removed `readSessionDisplayInfo()` call from `discoverSessions()` — now returns `customTitle: undefined`. The `readSessionDisplayInfo()` is called lazily in `showQuickPick()` only for the final displayed items (after `maxSessions` slicing).

---

## Bug: Terminal rename does not sync to preset — ✅ FIXED

Added `onDidChangeTerminalState` listener with a `terminalNameCache` (Map<Terminal, string>) to detect name changes. When a tracked terminal is renamed natively, the new name is synced to both the SessionStore and the matching preset in `settings.json`.

---

## Feature: Detect active Claude session ID from terminal process (adopt improvement)

### Problem

The adopt flow cannot reliably determine which Claude session is running in a given VS Code terminal. The `shellIntegration?.cwd` approach fails when the Claude CLI is the foreground process (shell integration only reports CWD while the shell is active). This results in showing all workspace sessions (50+) instead of the correct one.

### Solution: Process tree inspection

Use the terminal's PID to walk the process tree and find the running `claude` child process. From that process, extract the working directory, then match it against `~/.claude/projects/<encoded-path>/` to find the active session file.

#### Method (verified on Linux)

1. `terminal.processId` → shell PID (VS Code API)
2. Find `claude` child process: scan `/proc/<shellPid>/task/*/children` or use `pgrep -P <shellPid>`
3. Read claude process CWD: `readlink /proc/<claudePid>/cwd` → e.g. `/home/code/workspaces/web-quiz-ws`
4. Encode CWD to claude projects path: `/home/code/workspaces/web-quiz-ws` → `~/.claude/projects/-home-code-workspaces-web-quiz-ws/`
5. Find the most recently modified `.jsonl` file in that directory → that is the active session ID
6. Optionally: read `/proc/<claudePid>/cmdline` for `--resume <sessionId>` argument (direct match, but only present when session was resumed)

#### Proof of concept (2026-03-14)

```bash
# Terminal running claude in /home/code/workspaces/web-quiz-ws
# Shell PID → child claude process PID 11350

$ readlink /proc/11350/cwd
/home/code/workspaces/web-quiz-ws

$ ls -lt ~/.claude/projects/-home-code-workspaces-web-quiz-ws/*.jsonl | head -1
-rw------- 1 abc abc 2570414 Mar 14 18:02 .../9930ae2d-bc67-40b2-b3ed-57793951a4dc.jsonl

# → Session ID: 9930ae2d-bc67-40b2-b3ed-57793951a4dc ✅ (confirmed correct)
```

### Platform support

| Platform | Status | Method |
|----------|--------|--------|
| **Linux** | **Working** ✅ | `/proc/<pid>/cwd`, `/proc/<pid>/cmdline`, `/proc/<pid>/task/*/children` |
| **macOS** | Needs research | No `/proc`. Possible: `lsof -p <pid>` (cwd), `ps -o command= -p <pid>` (cmdline). Needs testing. |
| **Windows** | Needs research | No procfs. Possible: PowerShell `Get-Process`, `Get-CimInstance Win32_Process`. CWD retrieval is non-trivial (native API). Needs testing. |

### Implementation plan

| Step | Description | Status |
|------|-------------|--------|
| 1 | Create `src/process-inspector.ts` with platform-specific PID → claude session ID resolution | ✅ Done |
| 2 | Linux implementation: procfs-based (proven) | ✅ Done |
| 3 | macOS/Windows: stub that returns `undefined` (graceful fallback to current behavior) | TODO |
| 4 | Integrate into adopt flow: if process inspection returns a session ID, auto-adopt without QuickPick | ✅ Done |
| 5 | Future: implement macOS/Windows variants after research | TODO |

### Additional data available from process inspection (Linux)

On Linux, `/proc/<pid>/cmdline` and `/proc/<pid>/status` contain enough information to fully populate the adopted preset — not just the session ID, but also:

1. **userName**: Read from `/proc/<claudePid>/status` → `Uid:` line → resolve to username via `os.userInfo()` or `/etc/passwd`. Alternatively, parse from the parent process cmdline if launched via `su - <user> -c '...'`.
2. **CLI args**: The full `/proc/<claudePid>/cmdline` contains all `--` flags (e.g. `--dangerously-skip-permissions`, `--verbose`, `--model opus`). These can be extracted and saved into the preset's `args` field.

This means on Linux the adopt flow can be fully automatic: session ID + user + args all come from the process tree, no user input needed. **Implemented in v1.1.0** — the adopt flow now extracts all three. On macOS/Windows this data extraction is TODO (needs platform-specific research).

### Affected files

| File | Changes |
|------|---------|
| `src/process-inspector.ts` | New file — platform-specific process tree inspection |
| `src/extension.ts` | Adopt flow: call process inspector before falling back to session list |

---

## Bug: CLI args not extractable from claude process cmdline (2026-03-15) — ✅ FIXED

### Problem

`/proc/<pid>/cmdline` for the claude process only shows `claude` followed by null bytes — Node.js overwrites the process argv. Walking up the process tree also fails: the `sendText()` command is sent via PTY and does not appear in any ancestor's cmdline.

### Fix: Read args from session JSONL file

The session JSONL file (`~/.claude/projects/<slug>/<sessionId>.jsonl`) contains fields that map to CLI flags. Read the first 8KB of the file (fields appear early) and infer:
- `permissionMode: "bypassPermissions"` → `--dangerously-skip-permissions`
- `model: "<name>"` → `--model <name>`

New function: `readClaudeArgsFromSession(cwd, sessionId)` replaces the old procfs-based `readClaudeArgs(pid)`.

### Constraints preserved

- Session ID detection (CWD + most recent .jsonl) — unchanged
- userName detection (`/proc/<pid>/status` Uid) — unchanged
- Fallback: returns `[]` if session file not found or unreadable

---

## UX: Status bar tooltip should show tracked terminals

### Problem

The status bar shows `TS Recall: N live` but hovering over it only shows a generic tooltip. The user has no way to see which terminals are being tracked and under what names. This makes it hard to verify that rename sync is working and to understand what "live" means.

### Fix

Update `updateStatusBar()` to build a tooltip that lists all active tracked terminals:

```
TS Recall: 3 live
──────────────
• [abc] Claude: web-quiz (active)
• [abc] Claude: EUB-WS (active)
• [abc] Claude: ORIGINAL (active)
```

Use `vscode.MarkdownString` for the tooltip to enable multi-line formatting.

### Affected files

| File | Change |
|------|--------|
| `src/extension.ts` | `updateStatusBar()`: build MarkdownString tooltip with tracked terminal list |

### Status: ✅ DONE

---

## Bug: Status bar tooltip shows stale inactive sessions

### Problem

The status bar tooltip shows "10 inactive (resumable)" even when no terminals are running. These are stale `SessionMapping` entries with `inactive` status left in the store from previous sessions (e.g. after Reload Window). The `pruneExpired()` only removes entries older than 14 days, and `pruneDeadProcesses()` may not catch all cases.

The tooltip should not advertise resumable sessions that are just stale leftovers.

### Root cause found

`pruneDeadProcesses()` only operated on the exact `projectPath` (workspace root), missing subdirectory mappings. Additionally, `updateStatusBar()` used `store.getAll()` instead of `store.getByProject()`, showing sessions from all projects.

### Fix applied

1. `getByProject()` changed to `startsWith` prefix match — `pruneDeadProcesses` now finds subdirectory mappings
2. `updateStatusBar()` uses `store.getByProject(projectPath)` instead of `store.getAll()`
3. `updateStatusBar()` verifies active entries have a matching open terminal — marks stale ones as inactive

### Status: FIXED ✅ (2026-03-15)

Verified by log: 10 stale active entries detected and cleaned up on startup. Status bar correctly shows `active=1` after launching a preset terminal.

---

## Bug: Terminal rename not detected — no VS Code API for it (2026-03-15)

### Problem

The `onDidChangeTerminalState` event does NOT fire when a terminal is renamed. The VS Code `TerminalState` interface only contains `isInteractedWith` — it does not track the terminal name. There is no dedicated `onDidRenameTerminal` event in the VS Code API.

The current implementation using `terminalNameCache` + `onDidChangeTerminalState` never triggers because the event doesn't fire on rename.

### Impact

When a user renames a terminal tab (right-click → Rename), the new name is not synced to the matching preset's `terminalName` in `settings.json`.

### Fix: Polling (same approach as claude-code-extender)

VS Code has no rename event, so **polling is the only reliable solution**. The user may rename a terminal without changing focus (staying on the same terminal), which means event-based approaches (`onDidChangeActiveTerminal`, `onDidChangeTerminalState`) cannot catch all renames.

Reference implementation: `claude-code-extender/claude-code-orchestrator/src/services/terminalMonitor.ts` uses 2-second polling with `vscode.Terminal` object reference tracking.

#### Implementation

1. Replace the current `onDidChangeTerminalState` listener with a `setInterval` polling loop (every 2 seconds)
2. Track terminals by `vscode.Terminal` object reference (not by name) in the `terminalNameCache`
3. On each poll: compare cached name vs `terminal.name` for all tracked terminals
4. If name changed: sync to store + preset (existing logic)

```typescript
const RENAME_POLL_MS = 2000;
const renamePollInterval = setInterval(() => {
  for (const [terminal, oldName] of terminalNameCache) {
    if (terminal.name !== oldName) {
      // sync to store + preset (existing logic)
      terminalNameCache.set(terminal, terminal.name);
    }
  }
}, RENAME_POLL_MS);
context.subscriptions.push({ dispose: () => clearInterval(renamePollInterval) });
```

### Affected files

| File | Change |
|------|--------|
| `src/extension.ts` | Replace `onDidChangeTerminalState` listener with polling interval |

### Status: FIXED ✅ (2026-03-15)

Polling implemented with `store.getAll()` search (not project-scoped). Verified by log: rename detection works within 2 seconds, store and preset both updated.

---

## Bug: projectPath mismatch — workspace root vs preset cwd

### Problem

The workspace `projectPath` is the root folder opened in VS Code (e.g. `/home/code/workspaces`), but session mappings created by presets or adopt use the preset's `cwd` as `projectPath` (e.g. `/home/code/workspaces/terminal-session-recall`). Since `getByProject()` uses exact path matching (`normalizePath(m.projectPath) === normalized`), these mappings are invisible to:

1. **Status bar** (`updateStatusBar`): shows 0 live even when preset-launched terminals are running
2. **pruneDeadProcesses**: never checks mappings under subdirectories — stale active entries accumulate forever
3. **Rename polling**: already fixed to use `store.getAll()`, but `updateStatusBar` still misses the renamed terminal
4. **QuickPick active section**: `store.getActive(projectPath)` misses preset-launched terminals

### Root cause

`SessionStore.getByProject(projectPath)` does exact match. The workspace root and preset cwd are different paths — the preset cwd is a subdirectory of the workspace root.

### Symptoms observed

- Status bar shows "0 live" while a preset-launched terminal is running
- "10 active" mappings never get pruned (they belong to subdirectory project paths)
- "4 inactive" entries accumulate under workspace root from previous sessions

### Solution

Change `getByProject()` to use prefix matching: a mapping matches if its `projectPath` starts with the workspace root (or equals it exactly). This way all subdirectory sessions are included.

```typescript
getByProject(projectPath: string): readonly SessionMapping[] {
  const normalized = normalizePath(projectPath);
  return this.mappings.filter(
    (m) => normalizePath(m.projectPath).startsWith(normalized),
  );
}
```

**Impact**: This single change fixes status bar, pruneDeadProcesses, QuickPick active section, and any other call site that uses `getByProject()`.

### Affected files

| File | Change |
|------|--------|
| `src/session-store.ts` | `getByProject()`: exact match → `startsWith` prefix match |

### Status: FIXED ✅ (2026-03-15)

Verified by log: `getByProject` prefix match correctly finds subdirectory mappings. Status bar shows `active=1` for preset-launched terminal. Stale active entries auto-cleaned on startup.

---

## Bug: Rename polling does not update preset when sessionId is missing from preset

### Problem

The rename polling finds the preset by `sessionId`:
```typescript
const idx = presets.findIndex((p) => p.sessionId === mapping.sessionId);
```

But when a preset was created without a `sessionId` (new session mode), the preset has no `sessionId` field. At runtime a UUID is generated and stored in the `SessionMapping`, but the preset still has `sessionId: undefined`. The `findIndex` comparison fails → preset is never updated on rename.

### Log evidence

```
[rename-poll] found mapping: session=9930ae2d project=/home/code/workspaces/web-quiz-ws
[rename-poll] no preset found for session 9930ae2d (2 presets checked)
[rename-poll] store updated OK: "[abc] web-quiz-ws" → "[abc] web-quiz-ws XXX"
```

The store was updated successfully, but the preset was not.

### Solution

Fall back to matching by `terminalName` (the old name before rename) when `sessionId` match fails:

```typescript
let idx = presets.findIndex((p) => p.sessionId === mapping.sessionId);
if (idx < 0) {
  // Fallback: match by terminalName (for presets without sessionId)
  idx = presets.findIndex((p) => p.terminalName === oldName || p.label === oldName);
}
```

### Affected files

| File | Change |
|------|--------|
| `src/extension.ts` | Rename polling: add terminalName/label fallback for preset lookup |

### Status: FIXED ✅ (2026-03-15)

Verified by log: `preset[1] updated` — fallback to terminalName/label match works. Both rename cycles (`XXX` → `YYY`) correctly updated store and preset.
