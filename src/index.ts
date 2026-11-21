export {
  type AcpProxyController,
  type AcpProxyOptions,
  createAcpProxy,
  type RunAcpProxyOptions,
  runAcpProxy,
  secretNotice,
} from './acpProxy';
export {
  createSecretScratchMcpHandler,
  SECRET_PIPE_TOOL_NAME,
  SECRET_SCRATCH_TOOL_NAME,
  SECRET_SCRATCH_TOOLS,
  type SecretScratchMcpOptions,
  serveSecretScratchMcp,
} from './mcp';
export { SecretScratchPad } from './pad';
export {
  buildShapedLiftPatterns,
  CONTEXT_SECRETS,
  contextSecretHits,
  SHAPED_SECRET_PATTERNS,
  SHAPED_SECRETS,
  scrubSecrets,
} from './patterns';
export {
  isPrivatePath,
  privatePathDenial,
  privatePathGate,
  scratchTarget,
} from './privacy';
export {
  formatScratchRef,
  parseScratchRef,
  SECRET_MARKER,
  SECRET_REFERENCE_PATTERN,
  SECRET_SCRATCH_GUIDANCE,
} from './refs';
export {
  type PrivatePathOptions,
  type ScratchDagger,
  type ScratchPadSummary,
  type ScratchRef,
  type ScratchSource,
  type ScratchUse,
  SecretScratchError,
  type ToolGate,
  type ToolGateDecision,
  type ToolRequest,
} from './types';
