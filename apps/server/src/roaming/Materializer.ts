import * as NodeOS from "node:os";

import {
  CheckpointRef,
  CommandId,
  ProjectId,
  RoamingMaterializationRecord,
  type RoamingMaterializeRequest,
  type RoamingMaterializeStepName,
  type RoamingMaterializeStepStatus,
  RoamingRegistryPayload,
  RoamingVaultBundle,
  RoamingWipPayload,
  WorkspaceProjectId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { VcsDriver } from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PeerMirror } from "./PeerMirror.ts";
import { RoamingBlobStore } from "./RoamingBlobStore.ts";
import { deliverVaultBundle } from "./VaultSync.ts";
import { wipAppliedMarkerRefName, wipRefGlob } from "./WipSnapshots.ts";

// restore-wip runs BEFORE apply-vault: its cleanliness check and the
// checkpoint restore's `git clean` then operate on the pristine clone instead
// of depending on vault files being gitignored (content-wise the order is
// free — WIP capture subtracts the vault set, so the file sets are disjoint).
// Old records store steps as JSON but the loop looks them up by name, so
// records persisted under the previous order resume unchanged.
const STEP_ORDER: ReadonlyArray<RoamingMaterializeStepName> = [
  "resolve-path",
  "clone",
  "restore-wip",
  "apply-vault",
  "register-project",
  "bootstrap",
];

const MIRROR_STALE_MS = 10 * 60 * 1_000;

export class MaterializeError extends Schema.TaggedErrorClass<MaterializeError>()(
  "MaterializeError",
  {
    reason: Schema.Literals(["not-found", "invalid-target", "clone-failed", "internal"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Roaming materialize failed (${this.reason}): ${this.detail}`;
  }
}

export class Materializer extends Context.Service<
  Materializer,
  {
    readonly materialize: (
      request: RoamingMaterializeRequest,
    ) => Effect.Effect<RoamingMaterializationRecord, MaterializeError>;
    readonly subscribeUpdates: Effect.Effect<
      PubSub.Subscription<RoamingMaterializationRecord>,
      never,
      Scope.Scope
    >;
  }
>()("t3/roaming/Materializer") {}

const decodeRegistryPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RoamingRegistryPayload),
);
const decodeRawJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeRawJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeVaultBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingVaultBundle));
const decodeWipPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(RoamingWipPayload));
const decodeMaterializationRecord = Schema.decodeUnknownEffect(RoamingMaterializationRecord);
const RoamingMaterializeStepsJson = Schema.fromJsonString(
  RoamingMaterializationRecord.fields.steps,
);
const RoamingMaterializeNoticesJson = Schema.fromJsonString(
  RoamingMaterializationRecord.fields.notices,
);
const decodeStepsJson = Schema.decodeUnknownEffect(RoamingMaterializeStepsJson);
const decodeNoticesJson = Schema.decodeUnknownEffect(RoamingMaterializeNoticesJson);
const encodeStepsJson = Schema.encodeEffect(RoamingMaterializeStepsJson);
const encodeNoticesJson = Schema.encodeEffect(RoamingMaterializeNoticesJson);

const sqlError = (operation: string) => (cause: unknown) =>
  new MaterializeError({ reason: "internal", detail: operation, cause });

const internalError = (detail: string) => (cause: unknown) =>
  new MaterializeError({ reason: "internal", detail, cause });

const stepError = (reason: MaterializeError["reason"], detail: string, cause?: unknown) =>
  new MaterializeError({
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const expandHomePath = (input: string, path: Path.Path): string => {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
};

// Trust-on-first-use is only auto-applied for these well-known public git
// hosts (2026-07-06 decision); anything else surfaces host-key failures with
// manual instructions rather than silently trusting an unknown server.
const WELL_KNOWN_SSH_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "ssh.dev.azure.com",
]);

/** SSH host from scp-style (`git@host:...`) or `ssh://` URLs; null for https/other. */
const sshHostOf = (remoteUrl: string): string | null => {
  const scp = /^[^/@]+@([^:/]+):/.exec(remoteUrl);
  if (scp !== null) return scp[1]!.toLowerCase();
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^:/]+)/.exec(remoteUrl);
  if (ssh !== null) return ssh[1]!.toLowerCase();
  return null;
};

const remoteRepoName = (remoteUrl: string): string => {
  const withoutTrailingSlash = remoteUrl.replace(/\/+$/, "");
  const segments = withoutTrailingSlash.split(/[/:]/);
  const lastSegment = segments.findLast((segment) => segment.length > 0) ?? "";
  const withoutGit = lastSegment.endsWith(".git") ? lastSegment.slice(0, -4) : lastSegment;
  return withoutGit.trim();
};

const hasFinishedStep = (status: RoamingMaterializeStepStatus): boolean =>
  status === "completed" || status === "skipped";

const initialSteps = () => STEP_ORDER.map((step) => ({ step, status: "pending" as const }));

const addNotice = (
  record: RoamingMaterializationRecord,
  notice: string,
): RoamingMaterializationRecord =>
  record.notices.includes(notice) ? record : { ...record, notices: [...record.notices, notice] };

const replaceStep = (
  record: RoamingMaterializationRecord,
  step: RoamingMaterializeStepName,
  status: RoamingMaterializeStepStatus,
  detail?: string,
): RoamingMaterializationRecord => ({
  ...record,
  steps: record.steps.map((entry) =>
    entry.step === step
      ? {
          step,
          status,
          ...(detail === undefined ? {} : { detail }),
        }
      : entry,
  ),
});

const failureMessage = (cause: unknown): string => {
  // Walk the cause chain: upstream source-control errors wrap the real git
  // failure ("Host key verification failed", auth prompts, DNS) behind a
  // generic "could not be completed" — the user needs the bottom message
  // (field finding 2026-07-06).
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (typeof current === "string") {
      if (current.length > 0) parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const record = current as {
      readonly message?: unknown;
      readonly detail?: unknown;
      readonly cause?: unknown;
    };
    const message =
      typeof record.detail === "string" && record.detail.length > 0
        ? record.detail
        : typeof record.message === "string" && record.message.length > 0
          ? record.message
          : null;
    if (message !== null) parts.push(message);
    current = record.cause;
  }
  // Known say-nothing wrapper texts add noise once a real message exists.
  const generic = new Set([
    "The source control operation could not be completed.",
    "Git command exited with a non-zero status.",
    "Process exited with a non-zero status.",
    "Authentication failed.",
  ]);
  const unique = [...new Set(parts)];
  const informative = unique.filter((part) => !generic.has(part));
  const chosen = informative.length > 0 ? informative : unique;
  if (chosen.length === 0) return "Unknown materialize failure";
  // Outermost context first, root cause last — the root is what to fix.
  return chosen.join(" · ");
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettingsService;
  const blobStore = yield* RoamingBlobStore;
  const peerMirror = yield* PeerMirror;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const sourceControl = yield* SourceControlRepositoryService;
  const git = yield* VcsDriver;
  const engine = yield* OrchestrationEngineService;
  const projectRepository = yield* ProjectionProjectRepository;
  const updates = yield* PubSub.unbounded<RoamingMaterializationRecord>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const readRecord = (workspaceProjectId: WorkspaceProjectId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly workspaceProjectId: string;
        readonly status: string;
        readonly stepsJson: string;
        readonly noticesJson: string;
        readonly targetPath: string | null;
        readonly localProjectId: string | null;
        readonly error: string | null;
        readonly startedAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          workspace_project_id AS "workspaceProjectId",
          status,
          steps_json AS "stepsJson",
          notices_json AS "noticesJson",
          target_path AS "targetPath",
          local_project_id AS "localProjectId",
          error,
          started_at AS "startedAt",
          updated_at AS "updatedAt"
        FROM roaming_materializations
        WHERE workspace_project_id = ${workspaceProjectId}
      `.pipe(Effect.mapError(sqlError("roaming.materializer.read")));
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return yield* decodeMaterializationRecord({
        workspaceProjectId: row.workspaceProjectId,
        status: row.status,
        steps: yield* decodeStepsJson(row.stepsJson).pipe(
          Effect.mapError(internalError("materialization steps decode failed")),
        ),
        notices: yield* decodeNoticesJson(row.noticesJson).pipe(
          Effect.mapError(internalError("materialization notices decode failed")),
        ),
        targetPath: row.targetPath,
        localProjectId: row.localProjectId,
        error: row.error,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
      }).pipe(Effect.mapError(internalError("materialization row decode failed")));
    });

  const saveRecord = (record: RoamingMaterializationRecord) =>
    Effect.gen(function* () {
      const updated = { ...record, updatedAt: yield* nowIso };
      const stepsJson = yield* encodeStepsJson(updated.steps).pipe(
        Effect.mapError(internalError("materialization steps encode failed")),
      );
      const noticesJson = yield* encodeNoticesJson(updated.notices).pipe(
        Effect.mapError(internalError("materialization notices encode failed")),
      );
      yield* sql`
        INSERT INTO roaming_materializations (
          workspace_project_id, status, steps_json, notices_json, target_path,
          local_project_id, error, started_at, updated_at
        ) VALUES (
          ${updated.workspaceProjectId}, ${updated.status}, ${stepsJson},
          ${noticesJson}, ${updated.targetPath}, ${updated.localProjectId},
          ${updated.error}, ${updated.startedAt}, ${updated.updatedAt}
        )
        ON CONFLICT (workspace_project_id) DO UPDATE SET
          status = excluded.status,
          steps_json = excluded.steps_json,
          notices_json = excluded.notices_json,
          target_path = excluded.target_path,
          local_project_id = excluded.local_project_id,
          error = excluded.error,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(sqlError("roaming.materializer.save")));
      yield* PubSub.publish(updates, updated);
      return updated;
    });

  // Seed a well-known host's key into the server's known_hosts so a
  // background clone can verify it (the server has no terminal to answer the
  // first-connect prompt). Returns whether it seeded. Never throws.
  const seedKnownHostKey = (remoteUrl: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const host = sshHostOf(remoteUrl);
      if (host === null || !WELL_KNOWN_SSH_HOSTS.has(host)) return false;
      const scan = yield* vcsProcess
        .run({
          operation: "Materializer.sshKeyscan",
          command: "ssh-keyscan",
          cwd: "/",
          args: ["-T", "10", host],
          allowNonZeroExit: true,
          timeoutMs: 15_000,
          maxOutputBytes: 64 * 1024,
        })
        .pipe(Effect.orElseSucceed(() => null));
      const keys = (scan?.stdout ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0 && !line.startsWith("#"));
      if (scan === null || scan.exitCode !== 0 || keys.length === 0) return false;
      const sshDir = path.join(NodeOS.homedir(), ".ssh");
      const knownHosts = path.join(sshDir, "known_hosts");
      yield* fs.makeDirectory(sshDir, { recursive: true }).pipe(Effect.ignore);
      const existing = yield* fs.readFileString(knownHosts).pipe(Effect.orElseSucceed(() => ""));
      const missing = keys.filter((line) => !existing.includes(line));
      if (missing.length === 0) return true;
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
      yield* fs.writeFileString(knownHosts, `${prefix}${missing.join("\n")}\n`).pipe(Effect.ignore);
      yield* Effect.logInfo("roaming: seeded known_hosts for materialize", { host });
      return true;
    });

  const diagnoseRemote = (remoteUrl: string): Effect.Effect<string | null> =>
    vcsProcess
      .run({
        operation: "Materializer.diagnoseRemote",
        command: "git",
        cwd: "/",
        args: ["ls-remote", "--exit-code", remoteUrl, "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: 64 * 1024,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" },
      })
      .pipe(
        Effect.map((result) => {
          if (result.exitCode === 0) return null;
          const stderr = result.stderr
            .trim()
            // never echo embedded credentials (https://user:token@host/...)
            .replace(/\/\/[^/@\s]+@/g, "//<redacted>@");
          return stderr.length > 0
            ? `Cannot reach ${remoteUrl.replace(/\/\/[^/@\s]+@/g, "//<redacted>@")} from this machine's background server: ${stderr}`
            : null;
        }),
        Effect.orElseSucceed(() => null),
      );

  const loadRegistry = (workspaceProjectId: WorkspaceProjectId) =>
    Effect.gen(function* () {
      const readBlob = blobStore
        .get({ kind: "registry", key: workspaceProjectId })
        .pipe(Effect.mapError(internalError("registry blob lookup failed")));
      let blob = yield* readBlob;
      if (blob === null) {
        // Materialize must not depend on background sync timing: when the
        // local mirror has no copy yet (live peer, freshly enabled sync),
        // pull one on demand before giving up (2026-07-06 field finding).
        yield* peerMirror.syncNowAndWait();
        blob = yield* readBlob;
      }
      if (blob === null) {
        return yield* stepError(
          "not-found",
          `No synced copy of ${workspaceProjectId} — is sync on and the machine reachable?`,
        );
      }
      return yield* decodeRegistryPayload(blob.payload).pipe(
        Effect.mapError(internalError("registry payload decode failed")),
      );
    });

  const normalizePath = (input: string) => path.resolve(expandHomePath(input.trim(), path));

  const resolveTargetPath = (
    request: RoamingMaterializeRequest,
    registry: RoamingRegistryPayload,
  ) =>
    Effect.gen(function* () {
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const explicitTarget = request.targetPath ?? registry.perMachineRoots[environmentId];
      if (explicitTarget !== undefined && explicitTarget.trim().length > 0) {
        return normalizePath(explicitTarget);
      }

      const currentSettings = yield* settings.getSettings.pipe(
        Effect.mapError(internalError("settings lookup failed")),
      );
      const baseDirectory = currentSettings.addProjectBaseDirectory.trim();
      if (baseDirectory.length === 0) {
        return yield* stepError(
          "invalid-target",
          "No target path, per-machine root, or add-project base directory is configured",
        );
      }

      const name = remoteRepoName(registry.repository.locator.remoteUrl);
      if (name.length === 0) {
        return yield* stepError(
          "invalid-target",
          `Cannot derive repository name from ${registry.repository.locator.remoteUrl}`,
        );
      }
      return path.join(normalizePath(baseDirectory), name);
    });

  // Compare canonical forms: an existing SSH clone of an HTTPS registry URL
  // (or .git/trailing-slash variants) is the same repository, not a foreign
  // directory to refuse.
  const pathHasMatchingRemote = (targetPath: string, remoteUrl: string) =>
    git.listRemotes(targetPath).pipe(
      Effect.map((result) =>
        result.remotes.some(
          (remote) => normalizeGitRemoteUrl(remote.url) === normalizeGitRemoteUrl(remoteUrl),
        ),
      ),
      Effect.orElseSucceed(() => false),
    );

  const cloneRepository = (targetPath: string, remoteUrl: string) =>
    Effect.gen(function* () {
      if (yield* fs.exists(targetPath)) {
        if (yield* pathHasMatchingRemote(targetPath, remoteUrl)) {
          return "existing clone";
        }
        const entries = yield* fs
          .readDirectory(targetPath, { recursive: false })
          .pipe(
            Effect.mapError((cause) =>
              stepError("invalid-target", "Target path exists and is not a directory", cause),
            ),
          );
        if (entries.length > 0) {
          return yield* stepError(
            "invalid-target",
            "Target path exists and is not an existing clone of the registry remote",
          );
        }
      }
      const clone = () => sourceControl.cloneRepository({ remoteUrl, destinationPath: targetPath });
      const firstAttempt = yield* clone().pipe(Effect.exit);
      if (firstAttempt._tag === "Success") return `cloned to ${targetPath}`;

      // The vcs layer drops git's stderr from errors (token safety), leaving
      // "exited with a non-zero status" — diagnose with a harmless ls-remote
      // whose stderr we CAN read.
      const diagnostic = yield* diagnoseRemote(remoteUrl);
      // Host-key verification is the fresh-machine trap: the background server
      // never accepted the host key. For well-known public hosts, seed it and
      // retry once so materialize just works.
      if (diagnostic !== null && /host key verification failed/i.test(diagnostic)) {
        const seeded = yield* seedKnownHostKey(remoteUrl);
        if (seeded) {
          const retry = yield* clone().pipe(Effect.exit);
          if (retry._tag === "Success") return `cloned to ${targetPath}`;
          const retryDiagnostic = yield* diagnoseRemote(remoteUrl);
          return yield* stepError(
            "clone-failed",
            retryDiagnostic ?? failureMessage(retry.cause),
            retry.cause,
          );
        }
      }
      return yield* stepError(
        "clone-failed",
        diagnostic ?? failureMessage(firstAttempt.cause),
        firstAttempt.cause,
      );
    });

  const appendMirrorNotice = (record: RoamingMaterializationRecord) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly lastMirrorContactAt: string | null }>`
        SELECT MAX(last_contact_at) AS "lastMirrorContactAt" FROM roaming_peers
      `.pipe(Effect.mapError(sqlError("roaming.materializer.last-mirror-contact")));
      const lastMirrorContactAt = rows[0]?.lastMirrorContactAt ?? null;
      if (lastMirrorContactAt === null) {
        return addNotice(record, "no completed mirror pass on this machine");
      }
      if ((yield* Clock.currentTimeMillis) - Date.parse(lastMirrorContactAt) > MIRROR_STALE_MS) {
        return addNotice(record, `last completed mirror pass was ${lastMirrorContactAt}`);
      }
      return record;
    });

  const applyVault = (record: RoamingMaterializationRecord) =>
    Effect.gen(function* () {
      if (record.targetPath === null) {
        return yield* stepError("invalid-target", "Target path has not been resolved");
      }
      let next = yield* appendMirrorNotice(record);
      const readVault = blobStore
        .get({ kind: "vault", key: record.workspaceProjectId })
        .pipe(Effect.mapError(internalError("vault blob lookup failed")));
      let blob = yield* readVault;
      if (blob === null) {
        // Same on-demand pull as the registry: a freshly-enabled sync may
        // have delivered the registry but not yet the vault. Try once before
        // reporting "no secret files synced".
        yield* peerMirror.syncNowAndWait();
        blob = yield* readVault;
      }
      if (blob === null) {
        return {
          record: addNotice(next, "no secret files synced"),
          detail: "no vault blob",
        };
      }
      const bundle = yield* decodeVaultBundle(blob.payload).pipe(
        Effect.mapError(internalError("vault payload decode failed")),
      );
      if (bundle.files.length === 0) {
        return {
          record: addNotice(next, "no secret files synced"),
          detail: "empty vault bundle",
        };
      }
      // The recording variant: later vault deliveries may update files this
      // materialize wrote, as long as the user has not edited them since.
      const applied = yield* deliverVaultBundle({
        workspaceProjectId: record.workspaceProjectId,
        workspaceRoot: record.targetPath,
        bundle,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig.ServerConfig, serverConfig),
        Effect.mapError(internalError("vault apply failed")),
      );
      if (applied.skipped.length > 0) {
        next = addNotice(
          next,
          `secret files skipped because local files differ: ${applied.skipped.join(", ")}`,
        );
      }
      return {
        record: next,
        detail: `applied ${applied.written.length} secret file(s)`,
      };
    });

  interface RestoreWipResult {
    readonly status: "completed" | "skipped";
    readonly detail: string;
    readonly record: RoamingMaterializationRecord;
  }

  /**
   * Bring the peer's uncommitted work into the fresh clone: newest snapshot
   * across environments wins, sourced from the origin's hidden WIP refs
   * first (they work with the authoring machine off) and mirrored bundle
   * blobs second. Applies only to a clean tree; skips (never fails the
   * materialization) when there is nothing applicable.
   */
  const restoreWip = (
    record: RoamingMaterializationRecord,
    request: RoamingMaterializeRequest,
  ): Effect.Effect<RestoreWipResult, MaterializeError> =>
    Effect.gen(function* () {
      if (record.targetPath === null) {
        return yield* stepError("invalid-target", "Target path has not been resolved");
      }
      if (request.restoreWip === false) {
        return { status: "skipped", detail: "disabled by request", record };
      }
      const cwd = record.targetPath;
      const gitExec = (args: ReadonlyArray<string>, operation: string) =>
        git
          .execute({ operation, cwd, args, allowNonZeroExit: true })
          .pipe(Effect.mapError(internalError(operation)));

      const porcelain = yield* gitExec(
        ["status", "--porcelain"],
        "roaming.materializer.wip-status",
      );
      if (porcelain.exitCode !== 0) {
        return yield* stepError("internal", "git status failed in the materialized clone");
      }
      if (porcelain.stdout.trim().length > 0) {
        return {
          status: "skipped",
          detail: "local changes present; remote work in progress not applied",
          record: addNotice(record, "work in progress not applied: local changes present"),
        };
      }

      const glob = yield* wipRefGlob(record.workspaceProjectId).pipe(
        Effect.mapError(internalError("workspace project id is not ref-safe")),
      );
      // Non-fatal: the origin may refuse (bundle-mode projects) or lack the
      // namespace entirely; wildcard refspecs succeed with zero matches.
      yield* gitExec(["fetch", "origin", `+${glob}:${glob}`], "roaming.materializer.wip-fetch");

      const listWipRefs = gitExec(
        [
          "for-each-ref",
          "--format=%(refname) %(committerdate:unix) %(committerdate:iso-strict) %(objectname)",
          glob.slice(0, -1),
        ],
        "roaming.materializer.wip-list",
      ).pipe(
        Effect.map((listing) =>
          listing.exitCode !== 0
            ? []
            : listing.stdout
                .split("\n")
                .map((line) => line.trim().split(" "))
                .flatMap((parts) =>
                  parts.length === 4 && parts[0]!.length > 0
                    ? [
                        {
                          refName: parts[0]!,
                          committedAtUnix: Number(parts[1]!),
                          committedAtIso: parts[2]!,
                          commitOid: parts[3]!,
                        },
                      ]
                    : [],
                ),
        ),
      );

      // Mirrored bundle blobs (the no-push-rights transport) import into the
      // same local namespace, then both sources compete on committer date.
      const importBundles = Effect.gen(function* () {
        const manifest = yield* blobStore
          .manifest()
          .pipe(Effect.mapError(internalError("blob manifest failed")));
        const refs = manifest.filter(
          (entry) => entry.kind === "wip" && entry.key.startsWith(`${record.workspaceProjectId}/`),
        );
        let imported = record;
        for (const ref of refs) {
          const blob = yield* blobStore
            .get({ kind: "wip", key: ref.key })
            .pipe(Effect.orElseSucceed(() => null));
          if (blob === null) {
            continue;
          }
          const payload = yield* decodeWipPayload(blob.payload).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (payload === null) {
            imported = addNotice(imported, `undecodable work-in-progress blob: ${ref.key}`);
            continue;
          }
          // Origin-mode freshness beacons carry no pack — the origin fetch
          // above is their transport.
          if (payload.bundleBase64.length === 0) {
            continue;
          }
          const tempDir = yield* fs
            .makeTempDirectory({ prefix: "t3-wip-restore-" })
            .pipe(Effect.mapError(internalError("temp dir for wip bundle failed")));
          const bundlePath = path.join(tempDir, "wip.bundle");
          const applied = yield* Effect.gen(function* () {
            yield* fs
              .writeFile(bundlePath, Buffer.from(payload.bundleBase64, "base64"))
              .pipe(Effect.mapError(internalError("wip bundle write failed")));
            const fetched = yield* gitExec(
              ["fetch", bundlePath, `+${payload.refName}:${payload.refName}`],
              "roaming.materializer.wip-bundle-fetch",
            );
            return fetched.exitCode === 0;
          }).pipe(
            Effect.ensuring(
              fs.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore),
            ),
          );
          if (!applied) {
            imported = addNotice(
              imported,
              `work-in-progress bundle from ${ref.key.split("/")[1] ?? ref.key} did not apply`,
            );
          }
        }
        return imported;
      });

      let next = yield* importBundles;
      let candidates = yield* listWipRefs;
      if (candidates.length === 0) {
        // Same on-demand pull as registry/vault: a freshly-paired machine may
        // not have mirrored the wip blob yet.
        yield* peerMirror.syncNowAndWait();
        next = yield* importBundles;
        candidates = yield* listWipRefs;
      }
      if (candidates.length === 0) {
        return { status: "skipped", detail: "no work in progress found", record: next };
      }

      const newest = [...candidates].sort(
        (left, right) => right.committedAtUnix - left.committedAtUnix,
      )[0]!;
      const environment = newest.refName.split("/").pop() ?? "unknown";

      const newestTree = yield* gitExec(
        ["rev-parse", "-q", "--verify", `${newest.refName}^{tree}`],
        "roaming.materializer.wip-tree",
      );
      const headTree = yield* gitExec(
        ["rev-parse", "-q", "--verify", "HEAD^{tree}"],
        "roaming.materializer.head-tree",
      );
      if (
        newestTree.exitCode === 0 &&
        headTree.exitCode === 0 &&
        newestTree.stdout.trim() === headTree.stdout.trim()
      ) {
        return {
          status: "skipped",
          detail: "work in progress already matches the checkout",
          record: next,
        };
      }

      const checkpoints = git.checkpoints;
      if (checkpoints === undefined) {
        return yield* stepError("internal", "VCS driver does not support checkpoint restore");
      }
      const restored = yield* checkpoints
        .restoreCheckpoint({ cwd, checkpointRef: CheckpointRef.make(newest.refName) })
        .pipe(Effect.mapError(internalError("work-in-progress restore failed")));
      if (!restored) {
        return { status: "skipped", detail: "work-in-progress ref vanished", record: next };
      }
      // Record what this checkout was fast-forwarded to: the auto-apply
      // reactor treats a worktree matching this marker as edit-free, so
      // newer peer snapshots keep flowing in after materialize.
      const appliedMarker = yield* wipAppliedMarkerRefName(record.workspaceProjectId).pipe(
        Effect.mapError(internalError("applied marker name failed")),
      );
      const markerWrite = yield* gitExec(
        ["update-ref", appliedMarker, newest.commitOid],
        "roaming.materializer.wip-applied-marker",
      );
      if (markerWrite.exitCode !== 0) {
        // Fails safe (auto-apply just stays blocked for this checkout), but
        // silently degrading delivery is worth a trace.
        yield* Effect.logWarning("roaming materialize: applied-marker write failed", {
          workspaceProjectId: record.workspaceProjectId,
          stderr: markerWrite.stderr.trim().slice(0, 200),
        });
      }
      // A snapshot older than the clone's HEAD can legitimately win — the
      // age in the detail keeps that honest.
      return {
        status: "completed",
        detail: `applied work in progress from ${environment}, captured ${newest.committedAtIso}`,
        record: next,
      };
    });

  const findLinkedProject = (workspaceProjectId: WorkspaceProjectId) =>
    projectRepository.listAll().pipe(
      Effect.map((projects) =>
        projects.find(
          (project) =>
            project.deletedAt === null && project.workspaceProjectId === workspaceProjectId,
        ),
      ),
      Effect.mapError(internalError("project lookup failed")),
    );

  const findActiveProjectAtPath = (workspaceRoot: string) =>
    projectRepository.listAll().pipe(
      Effect.map((projects) =>
        projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        ),
      ),
      Effect.mapError(internalError("project path lookup failed")),
    );

  const ensureRegistryRoot = (
    workspaceProjectId: WorkspaceProjectId,
    targetPath: string,
    registry: RoamingRegistryPayload,
  ) =>
    Effect.gen(function* () {
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      if (registry.perMachineRoots[environmentId] === targetPath) {
        return;
      }
      // Merge on the raw JSON, not the decoded schema: a decode/re-encode
      // round-trip strips fields a newer-schema peer wrote, and this
      // machine's version bump would mirror the stripped payload out as
      // authoritative. Only perMachineRoots is touched.
      const current = yield* blobStore
        .get({ kind: "registry", key: workspaceProjectId })
        .pipe(Effect.mapError(internalError("registry blob read failed")));
      if (current === null) {
        return yield* internalError("registry blob missing during root update")(undefined);
      }
      const decoded = yield* decodeRawJson(current.payload).pipe(
        Effect.mapError(internalError("registry payload parse failed")),
      );
      const raw = typeof decoded === "object" && decoded !== null ? decoded : {};
      const existingRoots = (raw as Record<string, unknown>).perMachineRoots;
      const merged: Record<string, unknown> = {
        ...raw,
        perMachineRoots: {
          ...(typeof existingRoots === "object" && existingRoots !== null ? existingRoots : {}),
          [environmentId]: targetPath,
        },
      };
      const payload = yield* encodeRawJson(merged).pipe(
        Effect.mapError(internalError("registry payload encode failed")),
      );
      yield* blobStore
        .writeLocal({
          kind: "registry",
          key: workspaceProjectId,
          workspaceProjectId,
          payload,
        })
        .pipe(Effect.mapError(internalError("registry root update failed")));
    });

  const registerProject = (
    record: RoamingMaterializationRecord,
    registry: RoamingRegistryPayload,
  ) =>
    Effect.gen(function* () {
      if (record.targetPath === null) {
        return yield* stepError("invalid-target", "Target path has not been resolved");
      }
      const linked = yield* findLinkedProject(record.workspaceProjectId);
      if (linked !== undefined) {
        yield* ensureRegistryRoot(record.workspaceProjectId, record.targetPath, registry);
        return { localProjectId: linked.projectId, detail: `linked ${linked.projectId}` };
      }

      const projectAtPath = yield* findActiveProjectAtPath(record.targetPath);
      const projectId =
        record.localProjectId ??
        projectAtPath?.projectId ??
        ProjectId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));

      if (projectAtPath === undefined && record.localProjectId === null) {
        yield* engine
          .dispatch({
            type: "project.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
            projectId,
            title: registry.title,
            workspaceRoot: record.targetPath,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.mapError(internalError("project create dispatch failed")));
      }

      yield* engine
        .dispatch({
          type: "project.roaming.enroll",
          commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          projectId,
          workspaceProjectId: record.workspaceProjectId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError(internalError("project roaming link dispatch failed")));
      yield* ensureRegistryRoot(record.workspaceProjectId, record.targetPath, registry);
      return { localProjectId: projectId, detail: `linked ${projectId}` };
    });

  const runStep = (
    record: RoamingMaterializationRecord,
    step: RoamingMaterializeStepName,
    request: RoamingMaterializeRequest,
    registry: RoamingRegistryPayload,
  ) =>
    Effect.gen(function* () {
      const running = yield* saveRecord({
        ...replaceStep(record, step, "running"),
        status: "running",
        error: null,
      });

      switch (step) {
        case "resolve-path": {
          const targetPath = yield* resolveTargetPath(request, registry);
          return yield* saveRecord({
            ...replaceStep(running, step, "completed", targetPath),
            targetPath,
            error: null,
          });
        }
        case "clone": {
          if (running.targetPath === null) {
            return yield* stepError("invalid-target", "Target path has not been resolved");
          }
          const detail = yield* cloneRepository(
            running.targetPath,
            registry.repository.locator.remoteUrl,
          );
          return yield* saveRecord({
            ...replaceStep(running, step, "completed", detail),
            error: null,
          });
        }
        case "apply-vault": {
          const applied = yield* applyVault(running);
          return yield* saveRecord({
            ...replaceStep(applied.record, step, "completed", applied.detail),
            error: null,
          });
        }
        case "restore-wip": {
          const restored = yield* restoreWip(running, request);
          return yield* saveRecord({
            ...replaceStep(restored.record, step, restored.status, restored.detail),
            error: null,
          });
        }
        case "register-project": {
          const registered = yield* registerProject(running, registry);
          return yield* saveRecord({
            ...replaceStep(running, step, "completed", registered.detail),
            localProjectId: registered.localProjectId,
            error: null,
          });
        }
        case "bootstrap":
          return yield* saveRecord({
            ...replaceStep(running, step, "skipped", "M4"),
            status: "completed",
            error: null,
          });
      }
    });

  const failStep = (
    record: RoamingMaterializationRecord,
    step: RoamingMaterializeStepName,
    cause: unknown,
  ) =>
    saveRecord({
      ...replaceStep(record, step, "failed", failureMessage(cause)),
      status: "failed",
      error: failureMessage(cause),
    });

  /**
   * A completed record only short-circuits while its outcome still exists:
   * the target path must still hold a git checkout and the registered
   * project must still be live. Otherwise (user deleted the project and/or
   * the files — 2026-07-07 field bug: the stale record returned success
   * while materializing nothing) the record is discarded and a fresh run
   * starts; every step is idempotent against whatever survived.
   */
  const completedRecordStillValid = (record: RoamingMaterializationRecord) =>
    Effect.gen(function* () {
      if (record.targetPath === null) {
        return false;
      }
      const hasGitDir = yield* fs
        .exists(path.join(record.targetPath, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (!hasGitDir) {
        return false;
      }
      const linked = yield* findLinkedProject(record.workspaceProjectId).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return linked !== undefined;
    });

  const materialize: Materializer["Service"]["materialize"] = Effect.fn("Materializer.materialize")(
    function* (request) {
      const existing = yield* readRecord(request.workspaceProjectId);
      if (existing?.status === "completed") {
        if (yield* completedRecordStillValid(existing)) {
          return existing;
        }
      }

      const freshRecord = () =>
        Effect.gen(function* () {
          return yield* saveRecord({
            workspaceProjectId: request.workspaceProjectId,
            status: "running",
            steps: initialSteps(),
            notices: [],
            targetPath: null,
            localProjectId: null,
            error: null,
            startedAt: yield* nowIso,
            updatedAt: yield* nowIso,
          });
        });

      let record =
        existing === undefined || existing === null || existing.status === "completed"
          ? yield* freshRecord()
          : existing;

      const registryResult = yield* loadRegistry(request.workspaceProjectId).pipe(Effect.result);
      if (Result.isFailure(registryResult)) {
        return yield* saveRecord({
          ...replaceStep(record, "resolve-path", "failed", failureMessage(registryResult.failure)),
          status: "failed",
          error: failureMessage(registryResult.failure),
        });
      }
      const registry = registryResult.success;

      for (const step of STEP_ORDER) {
        const currentStep = record.steps.find((entry) => entry.step === step);
        if (currentStep !== undefined && hasFinishedStep(currentStep.status)) {
          continue;
        }
        const result = yield* runStep(record, step, request, registry).pipe(Effect.result);
        if (Result.isFailure(result)) {
          return yield* failStep(record, step, result.failure);
        }
        record = result.success;
      }

      if (record.status !== "completed") {
        record = yield* saveRecord({ ...record, status: "completed", error: null });
      }
      return record;
    },
  );

  return {
    materialize,
    subscribeUpdates: PubSub.subscribe(updates),
  } satisfies Materializer["Service"];
});

export const layer = Layer.effect(Materializer, make);
