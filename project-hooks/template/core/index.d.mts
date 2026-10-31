// Types of this project's hook table for the mod shell (hooks/register.ts). Copied from claude-code-kit/project-hooks.
import type { HookSpec } from '../hooks/contract';
export declare const HOOKS: readonly HookSpec[];
/** Command hooks left in settings on purpose (read by test/table.test.mjs); optional. */
export declare const KEPT_COMMAND_HOOKS: readonly { readonly command: RegExp; readonly why: string }[] | undefined;
