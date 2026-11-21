export interface ScratchRef {
  readonly thread: string;
  readonly message: string;
  readonly position: number;
}

export interface ScratchDagger {
  readonly message: string;
  readonly at: string;
  readonly excerpt: string;
  readonly positions: readonly number[];
}

export interface ScratchPadSummary {
  readonly thread: string;
  readonly daggers: readonly ScratchDagger[];
}

export type ScratchSource =
  | { readonly ref: string }
  | { readonly envFile: string; readonly key: string }
  | { readonly value: string };

export interface ScratchUse {
  readonly consume?: boolean;
}

export class SecretScratchError extends Error {
  override readonly name = 'SecretScratchError';
}

export interface ToolRequest {
  readonly stage?: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly toolServer?: string;
  readonly toolMethod?: string;
  readonly blockedPath?: string;
}

export type ToolGateDecision =
  | { readonly behavior: 'allow' }
  | { readonly behavior: 'deny'; readonly message: string };

export type ToolGate = (
  request: Pick<
    ToolRequest,
    'stage' | 'toolInput' | 'blockedPath' | 'toolMethod' | 'toolName' | 'toolServer'
  >,
) => ToolGateDecision;

export interface PrivatePathOptions {
  readonly scratchDir?: string;
  readonly privatePaths?: readonly string[];
  readonly heldFiles?: readonly string[];
  readonly isOwnTool?: (
    request: Pick<ToolRequest, 'toolName' | 'toolServer' | 'toolMethod'>,
  ) => boolean;
}
