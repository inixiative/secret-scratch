import { type ScratchRef, SecretScratchError } from './types';

export const SECRET_MARKER = '$$';

export const SECRET_REFERENCE_PATTERN = /†[A-Za-z0-9_.:/-]+\.\d+/g;

export const SECRET_SCRATCH_GUIDANCE =
  "A reference like †<message>.<n> in a message is a secret the person handed you, held in the thread's scratch pad. You never see the value and must not try to read it: use it. The normal path is secret_scratch with action 'env' (set KEY in an env file) and then secret_pipe from that env file (a command gets the value on its stdin; its output is thrown away and only the exit code comes back). action 'write' puts a value in a file. Pass consume: true on the last use to remove it from the pad. action 'list' shows what is pending. A file the pad has written to is then off limits to read, search or print, like files named .private, *.private or *.private.*: use it through secret_pipe. A secret is one word after $$; a multi-line secret cannot be lifted by marker (shaped private keys are lifted automatically).";

const REF_PATTERN = /^†?(?:([A-Za-z0-9_.:-]+)\/)?([A-Za-z0-9_.:-]+)\.(\d+)$/;
export const VALID_ID_PATTERN = /^[A-Za-z0-9_:-][A-Za-z0-9_.:-]*$/;

export function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function checkId(id: string, what: string): string {
  if (!VALID_ID_PATTERN.test(id)) throw new SecretScratchError(`Not a ${what} id: ${clip(id)}`);
  return id;
}

export function formatScratchRef(ref: ScratchRef, from?: string): string {
  return from === ref.thread
    ? `†${ref.message}.${ref.position}`
    : `†${ref.thread}/${ref.message}.${ref.position}`;
}

export function parseScratchRef(text: string, thread: string): ScratchRef {
  const match = REF_PATTERN.exec(text.trim());
  if (!match?.[2] || !match[3]) {
    throw new SecretScratchError(`Not a scratch pad reference: ${clip(text)}`);
  }
  const position = Number(match[3]);
  const ref: ScratchRef = {
    thread: match[1] ?? thread,
    message: match[2],
    position,
  };
  if (!VALID_ID_PATTERN.test(ref.thread) || !VALID_ID_PATTERN.test(ref.message) || position < 1) {
    throw new SecretScratchError(`Not a scratch pad reference: ${clip(text)}`);
  }
  return ref;
}
