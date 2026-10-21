import {
  type AccessKind,
  type AccessMode,
  type Effort,
  type NormalizedUsage,
  type Parent,
  type ReceiptStatus,
  UsageError,
  type WriterSandbox,
} from "../types.ts";

declare const laneBrand: unique symbol;
declare const accessBrand: unique symbol;

export type Access = (
  | { readonly mode: "read-only" }
  | { readonly mode: "isolated-write"; readonly sandbox: WriterSandbox }
) & { readonly [accessBrand]: true };

export function access(mode: AccessMode, sandbox: WriterSandbox = "bounded"): Access {
  if (mode === "isolated-write") return { mode, sandbox } as Access;
  if (sandbox === "full-access") throw new UsageError("writer sandbox full-access requires mode isolated-write");
  return { mode } as Access;
}

export function accessKind(value: Access): AccessKind {
  return value.mode === "isolated-write" && value.sandbox === "full-access" ? "isolated-write-full-access" : value.mode;
}

export interface Lane {
  readonly [laneBrand]: true;
  readonly parent: Parent;
  readonly adapter: ProviderAdapter;
  readonly family: {
    readonly name: string;
    readonly label: string;
    readonly model: string;
    readonly rolling: RollingAlias | null;
  } | null;
  readonly model: string;
  readonly cliModel: string;
  readonly effort: Effort;
  readonly access: Access;
  readonly promptPath: string;
  readonly cwd: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly timeoutMs: number | null;
}

/** A rolling alias such as `opus`. Claude resolves it to the newest `claude-opus-<revision>`. */
export interface RollingAlias {
  readonly revisionPrefix: `${string}-`;
}

export function isRevision(rolling: RollingAlias, model: string): boolean {
  return model.startsWith(rolling.revisionPrefix)
    && /^[0-9]+(?:-[0-9]+)*$/.test(model.slice(rolling.revisionPrefix.length));
}

export interface ChildRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ModelRun extends ChildRun {
  readonly sidecar: string | null;
}

export type PreflightVerdict =
  | { readonly kind: "passed"; readonly evidence: string }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "unavailable-model" }
  | { readonly kind: "inconclusive" };

export interface ProviderMetadata {
  readonly reportedModel: string | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
}

export type ParseResult =
  | { readonly kind: "complete"; readonly text: string; readonly metadata: ProviderMetadata }
  | {
    readonly kind: "provider-failure";
    readonly status: "cancelled" | "child-failed";
    readonly message: string;
    readonly metadata: ProviderMetadata;
  }
  | { readonly kind: "malformed"; readonly message: string };

export type EnvPolicy =
  | {
    readonly kind: "allowlist";
    readonly names: readonly string[];
    readonly prefixes: readonly string[];
    readonly set?: Readonly<Record<string, string>>;
  }
  | { readonly kind: "inherit"; readonly dropPrefixes: readonly string[] };

export interface LaunchFacts {
  readonly sharedGitDir: string | null;
  readonly providerSidecar: {
    readonly directory: string;
    readonly output: string | null;
    readonly config: string | null;
  } | null;
}

export interface ProviderSidecar {
  readonly output: string | null;
  readonly config: { readonly name: string; content(lane: Lane): string } | null;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly executable: string;
  readonly effortIn: "flag" | "model-id" | "config";
  readonly preflight: {
    argv(lane: Lane, sidecar: LaunchFacts["providerSidecar"]): readonly string[];
    readonly retryAfterUnauthenticatedMs: number | null;
    classify(run: ChildRun, lane: Lane): PreflightVerdict;
    readonly guard?: {
      readonly argv: readonly string[];
      check(run: ChildRun): { readonly status: ReceiptStatus; readonly message: string } | null;
    };
  };
  readonly launch: {
    readonly prompt: "stdin" | "file";
    readonly sidecar: ProviderSidecar | null;
    readonly supports: readonly AccessKind[];
    stdinEnvelope?(prompt: string): string;
    needsSharedGitDir(access: Access): boolean;
    argv(lane: Lane, facts: LaunchFacts): readonly string[];
  };
  parse(run: ModelRun, lane: Lane): ParseResult;
  readonly proof: {
    readonly report: "required" | "absent";
    matches(lane: Lane, reported: string): boolean;
  };
  environment(access: Access, sidecarDir: string | null): EnvPolicy;
  readonly docs: {
    readonly name: string;
    readonly hostPrerequisites: readonly string[];
    readonly statePaths: readonly string[];
    readonly notes: readonly string[];
  };
}

export function adapter<const Id extends string, const E extends ProviderAdapter["effortIn"]>(
  value: ProviderAdapter & { readonly id: Id; readonly effortIn: E }
): ProviderAdapter & { readonly id: Id; readonly effortIn: E } {
  return value;
}
