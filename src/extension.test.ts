import { describe, it, expect, vi, beforeEach } from "vitest";

// --- vscode mock ---
const mockStatusBarItem = {
  command: undefined as string | undefined,
  text: "",
  tooltip: "",
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const subscriptions: { dispose: () => void }[] = [];

const vscode = {
  window: {
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
    createTerminal: vi.fn(() => ({
      show: vi.fn(),
      sendText: vi.fn(),
      name: "TS Recall #1",
    })),
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, handler);
      return { dispose: vi.fn() };
    }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "C:\\dev\\test-project" } }] as
      | { uri: { fsPath: string } }[]
      | undefined,
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  },
  StatusBarAlignment: { Right: 2 },
  QuickPickItemKind: { Separator: -1 },
  TerminalExitReason: { Process: 0, User: 1 },
};

vi.mock("vscode", () => vscode);

// Mock claude-dir to avoid filesystem access
vi.mock("./claude-dir", () => ({
  discoverSessions: vi.fn(() => []),
  lookupSessionFileSize: vi.fn(() => 0),
}));

describe("activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    subscriptions.length = 0;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "C:\\dev\\test-project" } }];
  });

  it("creates status bar and shows session count when workspace is open", async () => {
    const { activate } = await import("./extension");

    const context = {
      globalState: {
        get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
        update: vi.fn(() => Promise.resolve()),
      },
      subscriptions,
    };

    activate(context as never);

    expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(2, 100);
    expect(mockStatusBarItem.command).toBe("claudeResurrect.showMenu");
    expect(mockStatusBarItem.text).toBe("$(terminal) TS Recall: 0 live");
    expect(mockStatusBarItem.show).toHaveBeenCalled();
    expect(mockStatusBarItem.hide).not.toHaveBeenCalled();
  });

  it("registers showMenu and newSession commands", async () => {
    const { activate } = await import("./extension");

    const context = {
      globalState: {
        get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
        update: vi.fn(() => Promise.resolve()),
      },
      subscriptions,
    };

    activate(context as never);

    expect(registeredCommands.has("claudeResurrect.showMenu")).toBe(true);
    expect(registeredCommands.has("claudeResurrect.newSession")).toBe(true);
  });

  it("hides status bar when no workspace folder", async () => {
    vscode.workspace.workspaceFolders = undefined;

    // Re-import to pick up the new workspace state
    vi.resetModules();
    vi.mock("vscode", () => vscode);
    vi.mock("./claude-dir", () => ({
      discoverSessions: vi.fn(() => []),
    }));
    const { activate } = await import("./extension");

    const context = {
      globalState: {
        get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
        update: vi.fn(() => Promise.resolve()),
      },
      subscriptions,
    };

    activate(context as never);

    expect(mockStatusBarItem.hide).toHaveBeenCalled();
    expect(mockStatusBarItem.show).not.toHaveBeenCalled();
  });

  it("listens for workspace folder changes when no folder at startup", async () => {
    vscode.workspace.workspaceFolders = undefined;

    vi.resetModules();
    vi.mock("vscode", () => vscode);
    vi.mock("./claude-dir", () => ({
      discoverSessions: vi.fn(() => []),
    }));
    const { activate } = await import("./extension");

    const context = {
      globalState: {
        get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
        update: vi.fn(() => Promise.resolve()),
      },
      subscriptions,
    };

    activate(context as never);

    expect(vscode.workspace.onDidChangeWorkspaceFolders).toHaveBeenCalled();
  });
});
