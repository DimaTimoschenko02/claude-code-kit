// The contract between a project's hook table (core/index.mjs) and the two shells that run it.
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.

/** What a hook answers: the JSON a command hook prints, a string (= additionalContext), or null (nothing). */
export type ClassicOutput = {
  readonly decision?: 'block' | 'approve' | 'deny';
  readonly reason?: string;
  readonly continue?: boolean;
  readonly stopReason?: string;
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly permissionDecision?: 'allow' | 'deny' | 'ask';
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
    readonly updatedInput?: Record<string, unknown>;
    readonly [field: string]: unknown;
  };
};

export type HookAnswer = ClassicOutput | string | null | undefined;

/** The classic hook input (what a command hook reads on stdin): session_id, cwd, tool_name, tool_input, … */
export type HookInput = Readonly<Record<string, unknown>> & {
  readonly hook_event_name: string;
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: Readonly<Record<string, unknown>>;
};

export type RunResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

/** Everything a hook may touch. The mod builds it over `$`, the runner over node:fs and child_process. */
export type HookIo = {
  /** The project root, forward slashes (C:/Users/x/proj on Windows). */
  readonly root: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly home: string;
  /** True under Codex (node/runner.mjs started by the Codex runtime). */
  readonly codex: boolean;
  /** CCLL_INACTIVE, CCLL_ENABLED, CCLL_THRESHOLD, CCLL_STALE_LOCK_MINUTES, CLAUDE_PROJECT_DIR, CLAUDE_CONFIG_DIR, PATH, HOME only. */
  env(name: string): Promise<string | undefined>;
  /** File text; null when missing, unreadable, or (in the mod) over 4 MiB. */
  read(path: string): Promise<string | null>;
  /** Whole new content; creates the directories. */
  write(path: string, text: string): Promise<void>;
  append(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ kind: string; size: number; mtimeMs: number } | null>;
  list(dir: string): Promise<{ name: string; kind: string }[]>;
  /** A process by argv, no shell; resolves once it exits. */
  run(argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<RunResult>;
  /** Git Bash on Windows (never the WSL launcher), `bash` elsewhere. */
  bash(): Promise<string>;
  /** `C:\x`, `/c/x` → `C:/x` on Windows. */
  path(p: string): string;
  now(): Date;
  log(line: string): void;
};

/** One row of the table: a classic event, an optional matcher, and either a pure `run` or a `script`. */
export type HookSpec = {
  readonly name: string;
  /** One classic event name or several: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop, … */
  readonly event: string | readonly string[];
  /** Tested against what settings.json tests (tool name, SessionStart source, agent type). No `g` flag. */
  readonly matcher?: RegExp;
  /** Cheap gate before `run` or `script`: false skips the hook. Keeps a script from starting for nothing. */
  readonly when?: (input: HookInput, io: HookIo) => boolean | Promise<boolean>;
  /** Pure check: runs inside the session in the mod, in node under Codex. */
  readonly run?: (input: HookInput, io: HookIo) => HookAnswer | Promise<HookAnswer>;
  /**
   * A command hook kept as a process: argv (no shell), `${root}` = project root, a bare `bash` = Git Bash on
   * Windows. Gets the input on stdin and CLAUDE_PROJECT_DIR; answers as a command hook does (stdout, exit 2).
   */
  readonly script?: readonly string[];
  /** false: Codex does not run it (the Codex runtime owns that job, or it needs Claude Code). */
  readonly codex?: boolean;
  readonly timeoutMs?: number;
};
