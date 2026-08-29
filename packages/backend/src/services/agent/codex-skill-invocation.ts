import type { RuntimeId } from '@bytelight/shared';

export function rewriteCodexSkillInvocation(
  message: string,
  runtimeId: RuntimeId,
  skillDirNames: ReadonlySet<string>,
): string {
  if (runtimeId !== 'codex' && runtimeId !== 'codex-cli') return message;

  const match = message.match(/^\/(\S+)([\s\S]*)$/);
  if (!match || !skillDirNames.has(match[1])) return message;

  return `$${match[1]}${match[2]}`;
}
