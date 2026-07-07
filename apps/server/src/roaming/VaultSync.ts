import * as NodeCrypto from "node:crypto";

import {
  DEFAULT_VAULT_PATTERNS,
  ROAMING_VAULT_BUNDLE_MAX_BYTES,
  RoamingRegistryPayload,
  RoamingVaultBundle,
  type RoamingVaultFileEntry,
  type WorkspaceProjectId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";

const WATCH_DEBOUNCE = Duration.millis(500);

export class VaultPathEscapeError extends Schema.TaggedErrorClass<VaultPathEscapeError>()(
  "VaultPathEscapeError",
  { path: Schema.String },
) {}

interface VaultTarget {
  readonly workspaceProjectId: WorkspaceProjectId;
  readonly workspaceRoot: string;
}

export interface CaptureVaultResult {
  readonly status: "written" | "unchanged" | "oversize";
  readonly recordVersion?: number;
}

export interface ApplyVaultResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export class VaultSync extends Context.Service<
  VaultSync,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly rescanProject: (workspaceProjectId: WorkspaceProjectId) => Effect.Effect<void>;
    readonly rescanAll: () => Effect.Effect<void>;
  }
>()("t3/roaming/VaultSync") {}

const decodeRegistryPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingRegistryPayload),
);
const decodeVaultBundleJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingVaultBundle));
const encodeVaultBundleJson = Schema.encodeEffect(Schema.fromJsonString(RoamingVaultBundle));

const normalizeRelativePath = (rawPath: string): string | null => {
  if (rawPath.length === 0 || rawPath.includes("\0")) {
    return null;
  }
  const slashPath = rawPath.replaceAll("\\", "/");
  if (slashPath.startsWith("/")) {
    return null;
  }
  const parts: string[] = [];
  for (const part of slashPath.split("/")) {
    if (part.length === 0 || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  if (normalized.length === 0) {
    return null;
  }
  return normalized;
};

const normalizeRelativePathOrFail = (rawPath: string) =>
  Effect.suspend(() => {
    const normalized = normalizeRelativePath(rawPath);
    return normalized === null
      ? Effect.fail(new VaultPathEscapeError({ path: rawPath }))
      : Effect.succeed(normalized);
  });

const fileIdentity = (entry: Pick<RoamingVaultFileEntry, "path" | "sha256" | "mode">): string =>
  `${entry.path}\0${entry.sha256}\0${entry.mode ?? ""}`;

const decodeCurrentVaultBundle = (payload: string) =>
  decodeVaultBundleJson(payload).pipe(Effect.result);

type TrackedLookup =
  | { readonly _tag: "tracked"; readonly paths: ReadonlySet<string> }
  | { readonly _tag: "unavailable" };

/**
 * The untracked-only invariant must fail closed: on a genuine git failure we
 * cannot tell tracked from untracked, so the caller skips the capture rather
 * than shipping committed lookalikes. A workspace that simply isn't a git
 * repository has no tracked files, so everything is a candidate there.
 */
export const listTrackedCandidates = (workspaceRoot: string, candidates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (candidates.length === 0) {
      return { _tag: "tracked", paths: new Set<string>() } as TrackedLookup;
    }
    const git = yield* GitVcsDriver;
    const result = yield* git
      .execute({
        operation: "VaultSync.gitLsFiles",
        cwd: workspaceRoot,
        args: ["ls-files", "-z", "--", ...candidates],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("roaming vault: git ls-files failed", {
            workspaceRoot,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
    if (result === null) {
      return { _tag: "unavailable" } as TrackedLookup;
    }
    if (result.exitCode !== 0) {
      if (result.stderr.includes("not a git repository")) {
        return { _tag: "tracked", paths: new Set<string>() } as TrackedLookup;
      }
      yield* Effect.logWarning("roaming vault: git ls-files exited nonzero, skipping capture", {
        workspaceRoot,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
      return { _tag: "unavailable" } as TrackedLookup;
    }
    return {
      _tag: "tracked",
      paths: new Set(result.stdout.split("\0").filter((path) => path.length > 0)),
    } as TrackedLookup;
  });

export const T3SYNC_FILE_NAME = ".t3sync";
export const GLOBAL_T3SYNC_FILE_NAME = "t3sync";

const T3SYNC_TEMPLATE = `# Files that sync between YOUR machines only (never to a git remote).
# Same syntax as .gitignore. This global file applies to every project;
# delete a line to stop syncing it everywhere. A project can extend or veto
# it with its own .t3sync in the repo root (e.g. ".idea/" to sync more,
# "!.env" to keep this project's .env local).
${DEFAULT_VAULT_PATTERNS.join("\n")}
# Dependency/build trees are full of throwaway certs and keys that would
# otherwise match the patterns above (this is a denylist — extend it if
# your tooling drops matches somewhere else).
!node_modules/**
!vendor/**
!dist/**
!build/**
!target/**
!.venv/**
!__pycache__/**
`;

/**
 * The defaults are not hidden machinery: they live in ONE editable file in
 * the app's own state dir (git's core.excludesFile model), written once and
 * never regenerated. Repos are never touched — a per-project .t3sync is
 * purely user-created.
 */
const ensureGlobalT3Sync = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const globalPath = pathService.join(config.stateDir, GLOBAL_T3SYNC_FILE_NAME);
  // On a flaky stat, assume the file EXISTS: writing here would overwrite
  // a user-edited global manifest with the template — the one unacceptable
  // outcome. (The read side defaults the other way; a transient miss there
  // only drops the file from one pass and self-heals.)
  const exists = yield* fs.exists(globalPath).pipe(Effect.orElseSucceed(() => true));
  if (!exists) {
    yield* fs.makeDirectory(config.stateDir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(globalPath, T3SYNC_TEMPLATE)),
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming vault: could not write global t3sync", { cause }),
      ),
    );
  }
  return globalPath;
});

/**
 * Untracked files the sync manifests select, via git's own exclude engine
 * (exact .gitignore semantics: directories, globs, `!` negation). The
 * global file's patterns come first, the optional repo-root .t3sync second,
 * so a project line — including a negation — wins over a global one.
 * Output is repo-relative untracked paths; a pattern can never select
 * anything outside the repo.
 */
const readT3SyncCandidates = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const globalPath = yield* ensureGlobalT3Sync;
    const projectPath = pathService.join(workspaceRoot, T3SYNC_FILE_NAME);
    const excludeFiles: string[] = [];
    if (yield* fs.exists(globalPath).pipe(Effect.orElseSucceed(() => false))) {
      excludeFiles.push(globalPath);
    }
    if (yield* fs.exists(projectPath).pipe(Effect.orElseSucceed(() => false))) {
      excludeFiles.push(T3SYNC_FILE_NAME);
    }
    if (excludeFiles.length === 0) {
      return [];
    }
    const git = yield* GitVcsDriver;
    const result = yield* git
      .execute({
        operation: "VaultSync.t3syncMatches",
        cwd: workspaceRoot,
        args: [
          "ls-files",
          "-z",
          "-o",
          "-i",
          ...excludeFiles.flatMap((file) => [`--exclude-from=${file}`]),
        ],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (result === null || result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => normalizeRelativePath(path))
      .filter((path): path is string => path !== null);
  });

export const buildCandidatePaths = (
  workspaceRoot: string,
  _workspaceProjectId: WorkspaceProjectId,
) =>
  Effect.gen(function* () {
    // The t3sync files are the single source of truth (M3.5, user
    // decision): defaults live in the editable GLOBAL file (created once in
    // the app's state dir — repos are never touched), a user-created
    // repo-root .t3sync extends or vetoes them. Deleting a line is the
    // whole exclusion mechanism; no hidden pattern list, no registry
    // override.
    const candidates = new Set(yield* readT3SyncCandidates(workspaceRoot));
    return [...candidates].sort();
  });

const statMode = (stat: unknown): number | undefined => {
  const mode = (stat as { readonly mode?: unknown }).mode;
  return typeof mode === "number" ? mode & 0o777 : undefined;
};

const captureBundle = (target: VaultTarget) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const candidates = yield* buildCandidatePaths(target.workspaceRoot, target.workspaceProjectId);
    const tracked = yield* listTrackedCandidates(target.workspaceRoot, candidates);
    if (tracked._tag === "unavailable") {
      return { _tag: "skipped" as const };
    }
    const files: RoamingVaultFileEntry[] = [];
    let totalBytes = 0;

    for (const relativePath of candidates) {
      if (tracked.paths.has(relativePath)) {
        continue;
      }
      const absolutePath = pathService.join(target.workspaceRoot, relativePath);
      // stat follows symlinks; a matched symlink (.env -> elsewhere) must not
      // have its target read and shipped. readLink succeeds only on symlinks.
      const isSymlink = yield* fs.readLink(absolutePath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (isSymlink) {
        continue;
      }
      const stat = yield* fs.stat(absolutePath).pipe(Effect.orElseSucceed(() => null));
      if (stat?.type !== "File") {
        continue;
      }
      // Enforce the cap from stat before reading: an accidentally matched
      // huge file must be skipped, not loaded into memory first.
      totalBytes += Number(stat.size);
      if (totalBytes > ROAMING_VAULT_BUNDLE_MAX_BYTES) {
        return { _tag: "oversize" as const, totalBytes };
      }
      const content = yield* fs.readFile(absolutePath);
      files.push({
        path: relativePath,
        ...(statMode(stat) !== undefined ? { mode: statMode(stat) } : {}),
        sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
        contentBase64: Buffer.from(content).toString("base64"),
      });
    }

    return {
      _tag: "bundle" as const,
      bundle: {
        schemaVersion: 1,
        capturedAt: DateTime.formatIso(yield* DateTime.now),
        files,
      },
    };
  });

function sameVaultFileSet(
  left: ReadonlyArray<Pick<RoamingVaultFileEntry, "path" | "sha256" | "mode">>,
  right: ReadonlyArray<Pick<RoamingVaultFileEntry, "path" | "sha256" | "mode">>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftIds = left.map(fileIdentity).sort();
  const rightIds = right.map(fileIdentity).sort();
  return leftIds.every((value, index) => value === rightIds[index]);
}

export const captureVaultForProject = Effect.fn("VaultSync.captureVaultForProject")(function* (
  target: VaultTarget,
) {
  const blobStore = yield* RoamingBlobStore;
  const captured = yield* captureBundle(target).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("roaming vault: capture failed", {
        workspaceProjectId: target.workspaceProjectId,
        workspaceRoot: target.workspaceRoot,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (captured === null || captured._tag === "skipped") {
    return { status: "unchanged" };
  }
  if (captured._tag === "oversize") {
    yield* Effect.logWarning("roaming vault: bundle exceeds size cap, skipping capture", {
      workspaceProjectId: target.workspaceProjectId,
      bytes: captured.totalBytes,
      maxBytes: ROAMING_VAULT_BUNDLE_MAX_BYTES,
    });
    return { status: "oversize" };
  }

  const current = yield* blobStore.get({ kind: "vault", key: target.workspaceProjectId });
  if (current !== null) {
    const decoded = yield* decodeCurrentVaultBundle(current.payload);
    if (
      Result.isSuccess(decoded) &&
      sameVaultFileSet(captured.bundle.files, decoded.success.files)
    ) {
      return { status: "unchanged" };
    }
  }

  const payload = yield* encodeVaultBundleJson(captured.bundle).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("roaming vault: bundle encode failed", {
        workspaceProjectId: target.workspaceProjectId,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (payload === null) {
    return { status: "unchanged" };
  }
  const record = yield* blobStore.writeLocal({
    kind: "vault",
    key: target.workspaceProjectId,
    workspaceProjectId: target.workspaceProjectId,
    payload,
  });
  return { status: "written", recordVersion: record.version };
});

export const applyVaultBundle = Effect.fn("VaultSync.applyVaultBundle")(function* (input: {
  readonly workspaceRoot: string;
  readonly bundle: RoamingVaultBundle;
  readonly overwrite: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const workspaceRoot = pathService.resolve(input.workspaceRoot);
  const realWorkspaceRoot = yield* fs
    .realPath(workspaceRoot)
    .pipe(Effect.orElseSucceed(() => workspaceRoot));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const entry of input.bundle.files) {
    const relativePath = yield* normalizeRelativePathOrFail(entry.path);
    const absolutePath = pathService.resolve(workspaceRoot, relativePath);
    const relativeToRoot = pathService.relative(workspaceRoot, absolutePath);
    if (
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${pathService.sep}`) ||
      pathService.isAbsolute(relativeToRoot)
    ) {
      return yield* new VaultPathEscapeError({ path: entry.path });
    }
    // The lexical check above cannot see symlinks: a symlinked directory
    // inside the workspace (or a symlink at the target path itself) would
    // redirect the write outside the root. Resolve the real parent and
    // refuse both.
    const isSymlinkTarget = yield* fs.readLink(absolutePath).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (isSymlinkTarget) {
      return yield* new VaultPathEscapeError({ path: entry.path });
    }

    const nextContent = Buffer.from(entry.contentBase64, "base64");
    const existing = yield* fs.readFile(absolutePath).pipe(Effect.orElseSucceed(() => null));
    if (existing !== null) {
      const existingHash = NodeCrypto.createHash("sha256").update(existing).digest("hex");
      if (existingHash !== entry.sha256 && !input.overwrite) {
        skipped.push(relativePath);
        continue;
      }
      if (existingHash === entry.sha256) {
        if (entry.mode !== undefined) {
          yield* fs.chmod(absolutePath, entry.mode);
        }
        applied.push(relativePath);
        continue;
      }
    }

    yield* fs.makeDirectory(pathService.dirname(absolutePath), { recursive: true });
    const realParent = yield* fs
      .realPath(pathService.dirname(absolutePath))
      .pipe(Effect.orElseSucceed(() => null));
    if (
      realParent === null ||
      (realParent !== realWorkspaceRoot &&
        !realParent.startsWith(`${realWorkspaceRoot}${pathService.sep}`))
    ) {
      return yield* new VaultPathEscapeError({ path: entry.path });
    }
    // Secret files must never exist at the umask default, even briefly.
    yield* fs.writeFile(absolutePath, nextContent, {
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    });
    if (entry.mode !== undefined) {
      yield* fs.chmod(absolutePath, entry.mode);
    }
    applied.push(relativePath);
  }

  return { applied, skipped };
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const git = yield* GitVcsDriver;
  const blobStore = yield* RoamingBlobStore;
  const projectRepository = yield* ProjectionProjectRepository;
  const serverSettings = yield* ServerSettingsService;
  const watcherScopes = yield* Ref.make(new Map<string, Scope.Scope>());
  const serverConfig = yield* ServerConfig.ServerConfig;
  const provideVaultDeps = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | RoamingBlobStore
      | FileSystem.FileSystem
      | Path.Path
      | GitVcsDriver
      | ServerConfig.ServerConfig
    >,
  ) =>
    effect.pipe(
      Effect.provideService(RoamingBlobStore, blobStore),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(GitVcsDriver, git),
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
    );

  const isEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.roaming && settings.roamingSecretsSync),
    Effect.catch((cause) =>
      Effect.logWarning("roaming vault: failed to read settings", { cause }).pipe(Effect.as(false)),
    ),
  );

  const listTargets = Effect.gen(function* () {
    const projects = yield* projectRepository
      .listAll()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("roaming vault: failed to list projects", { cause }).pipe(
            Effect.as([]),
          ),
        ),
      );
    const targets: VaultTarget[] = [];
    for (const project of projects) {
      if (project.deletedAt !== null || project.workspaceProjectId === null) {
        continue;
      }
      const stat = yield* fs.stat(project.workspaceRoot).pipe(Effect.orElseSucceed(() => null));
      if (stat?.type !== "Directory") {
        continue;
      }
      targets.push({
        workspaceProjectId: project.workspaceProjectId,
        workspaceRoot: project.workspaceRoot,
      });
    }
    return targets;
  });

  const findTarget = (workspaceProjectId: WorkspaceProjectId) =>
    listTargets.pipe(
      Effect.map(
        (targets) =>
          targets.find((target) => target.workspaceProjectId === workspaceProjectId) ?? null,
      ),
    );

  const worker = yield* makeKeyedCoalescingWorker<WorkspaceProjectId, VaultTarget, never, never>({
    merge: (_current, next) => next,
    process: (_workspaceProjectId, target) =>
      isEnabled.pipe(
        Effect.flatMap((enabled) =>
          enabled
            ? provideVaultDeps(captureVaultForProject(target))
            : Effect.succeed({ status: "unchanged" }),
        ),
        Effect.catchCause((cause) => Effect.logWarning("roaming vault: rescan failed", { cause })),
        Effect.asVoid,
      ),
  });

  const enqueueTarget = (target: VaultTarget) => worker.enqueue(target.workspaceProjectId, target);

  const watchDirectoriesFor = (target: VaultTarget) =>
    Effect.gen(function* () {
      const candidates = yield* provideVaultDeps(
        buildCandidatePaths(target.workspaceRoot, target.workspaceProjectId),
      );
      const dirs = new Set([target.workspaceRoot]);
      for (const relativePath of candidates) {
        const slashIndex = relativePath.lastIndexOf("/");
        const dirname = slashIndex === -1 ? "." : relativePath.slice(0, slashIndex);
        if (dirname !== ".") {
          dirs.add(pathService.join(target.workspaceRoot, dirname));
        }
      }
      const existingDirs: string[] = [];
      for (const dir of dirs) {
        const stat = yield* fs.stat(dir).pipe(Effect.orElseSucceed(() => null));
        if (stat?.type === "Directory") {
          existingDirs.push(dir);
        }
      }
      return existingDirs;
    });

  const closeWatcher = (workspaceProjectId: WorkspaceProjectId) =>
    Ref.modify(watcherScopes, (scopes) => {
      const scope = scopes.get(workspaceProjectId);
      const next = new Map(scopes);
      next.delete(workspaceProjectId);
      return [scope, next] as const;
    }).pipe(
      Effect.flatMap((scope) =>
        scope === undefined ? Effect.void : Scope.close(scope, Exit.void).pipe(Effect.asVoid),
      ),
    );

  const installWatcher = (target: VaultTarget) =>
    Effect.gen(function* () {
      // Swap atomically: rescanProject (registry changes) and rescanAll
      // (settings toggles) run on independent fibers; a close-then-set pair
      // would let a concurrent install evict a scope from the map without
      // closing it, leaking its watch fibers forever.
      const scope = yield* Scope.make("sequential");
      const previous = yield* Ref.modify(watcherScopes, (scopes) => {
        const old = scopes.get(target.workspaceProjectId);
        const next = new Map(scopes);
        next.set(target.workspaceProjectId, scope);
        return [old, next] as const;
      });
      if (previous !== undefined) {
        yield* Scope.close(previous, Exit.void);
      }
      const directories = yield* watchDirectoriesFor(target);
      for (const directory of directories) {
        const events = fs.watch(directory).pipe(Stream.debounce(WATCH_DEBOUNCE));
        yield* Stream.runForEach(events, () => enqueueTarget(target)).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(scope),
        );
      }
    });

  const rescanProject: VaultSync["Service"]["rescanProject"] = (workspaceProjectId) =>
    isEnabled.pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? findTarget(workspaceProjectId).pipe(
              Effect.flatMap((target) =>
                target === null
                  ? closeWatcher(workspaceProjectId)
                  : installWatcher(target).pipe(Effect.andThen(enqueueTarget(target))),
              ),
            )
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming vault: project rescan failed", { cause }),
      ),
    );

  const rescanAll: VaultSync["Service"]["rescanAll"] = () =>
    isEnabled.pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? listTargets.pipe(
              Effect.flatMap((targets) =>
                Effect.forEach(
                  targets,
                  (target) => installWatcher(target).pipe(Effect.andThen(enqueueTarget(target))),
                  { discard: true },
                ),
              ),
            )
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("roaming vault: full rescan failed", { cause }),
      ),
    );

  const closeAllWatchers = Ref.modify(
    watcherScopes,
    (scopes) => [[...scopes.values()], new Map<string, Scope.Scope>()] as const,
  ).pipe(
    Effect.flatMap((scopes) =>
      Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true }),
    ),
  );

  const start: VaultSync["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => closeAllWatchers);
      const enabledRef = yield* Ref.make(yield* isEnabled);
      if (yield* Ref.get(enabledRef)) {
        yield* rescanAll();
      }

      yield* Effect.forkScoped(
        serverSettings.streamChanges.pipe(
          Stream.runForEach((settings) =>
            Effect.gen(function* () {
              const enabled = settings.roaming && settings.roamingSecretsSync;
              const wasEnabled = yield* Ref.getAndSet(enabledRef, enabled);
              if (enabled) {
                yield* rescanAll();
              } else if (wasEnabled) {
                yield* closeAllWatchers;
              }
            }),
          ),
          Effect.ignoreCause({ log: true }),
        ),
      );

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const changes = yield* blobStore.subscribeChanges;
          return yield* Effect.forever(
            PubSub.take(changes).pipe(
              Effect.flatMap((record) =>
                record.kind === "registry" ? rescanProject(record.workspaceProjectId) : Effect.void,
              ),
            ),
          );
        }),
      );
    });

  return { start, rescanProject, rescanAll } satisfies VaultSync["Service"];
});

export const layer = Layer.effect(VaultSync, make);
