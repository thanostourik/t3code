// @effect-diagnostics nodeBuiltinImport:off
/**
 * Recursive filesystem watching for a project root (the Dropbox model:
 * watch, debounce, ship). Extracted from WipSnapshotReactor.ts — the
 * reactor owns debounce, fallback pacing, and the degraded notice; this
 * module only produces the raw event stream, which ENDS when watching is
 * impossible or dies.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const WATCH_NOISE = /(^|\/)(\.git|node_modules|dist|build|target|out|\.venv|__pycache__)(\/|$)/;
const WATCH_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".venv",
  "__pycache__",
]);
// Budget cap (M3.7): inotify watches are a per-user resource shared with
// every desktop app. A source tree needing more directories than this is
// not worth the budget — the project falls back to the short sweep.
const MAX_WATCHED_DIRS_PER_PROJECT = 4096;

/**
 * Recursive filesystem events for a project root (the Dropbox model: watch,
 * debounce, ship). The stream ENDS when watching is impossible or dies —
 * the caller owns the fallback.
 *
 * On Linux, node's recursive fs.watch registers an inotify watch for EVERY
 * directory in the tree — node_modules/.git included (measured 2026-07-10:
 * a running desktop instance held ~167k watches), which exhausts the
 * per-user inotify budgets and starves every other watcher in the process.
 * So on Linux the tree is walked and watched per directory, skipping the
 * trees whose events were filtered anyway and capping the total. On
 * macOS/Windows recursive watching is a cheap native facility (FSEvents /
 * ReadDirectoryChangesW) — one watcher, no walk.
 */
export const watchTreeEvents = (root: string, platform: NodeJS.Platform): Stream.Stream<string> =>
  platform === "linux" ? watchTreePerDirectory(root) : watchTreeRecursiveNative(root);

const watchTreeRecursiveNative = (root: string): Stream.Stream<string> =>
  Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        try {
          const watcher = NodeFS.watch(root, { recursive: true }, (_event, fileName) => {
            const relative = fileName?.toString() ?? "";
            if (!WATCH_NOISE.test(relative)) {
              Queue.offerUnsafe(queue, relative);
            }
          });
          watcher.on("error", () => Queue.endUnsafe(queue));
          return watcher;
        } catch {
          Queue.endUnsafe(queue);
          return null;
        }
      }),
      (watcher) =>
        Effect.sync(() => {
          watcher?.close();
        }),
    ),
  );

const watchTreePerDirectory = (root: string): Stream.Stream<string> =>
  Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watchers = new Map<string, NodeFS.FSWatcher>();
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          for (const watcher of watchers.values()) {
            watcher.close();
          }
          watchers.clear();
          Queue.endUnsafe(queue);
        };
        const watchDir = (dir: string): boolean => {
          if (ended || watchers.has(dir)) return !ended;
          if (watchers.size >= MAX_WATCHED_DIRS_PER_PROJECT) {
            end();
            return false;
          }
          try {
            const watcher = NodeFS.watch(dir, (_event, fileName) => onEvent(dir, fileName));
            // A single dead directory (deleted mid-walk) must not kill the
            // project's whole watch; genuine budget exhaustion surfaces as
            // watchDir throwing on the NEXT registration.
            watcher.on("error", () => {
              watcher.close();
              watchers.delete(dir);
            });
            watchers.set(dir, watcher);
            return true;
          } catch {
            end();
            return false;
          }
        };
        const walk = (dir: string): void => {
          if (!watchDir(dir)) return;
          let entries: NodeFS.Dirent[];
          try {
            entries = NodeFS.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (ended) return;
            if (
              entry.isDirectory() &&
              !entry.isSymbolicLink() &&
              !WATCH_EXCLUDED_DIRS.has(entry.name)
            ) {
              walk(NodePath.join(dir, entry.name));
            }
          }
        };
        const onEvent = (dir: string, fileName: string | Buffer | null) => {
          if (ended) return;
          const name = fileName?.toString() ?? "";
          const absolute = NodePath.join(dir, name);
          if (name.length > 0 && !WATCH_EXCLUDED_DIRS.has(name)) {
            // Keep the watcher set in step with directory churn: watch new
            // subtrees, drop watchers under removed ones.
            try {
              if (NodeFS.lstatSync(absolute).isDirectory()) {
                walk(absolute);
              }
            } catch {
              for (const key of watchers.keys()) {
                if (key === absolute || key.startsWith(absolute + NodePath.sep)) {
                  watchers.get(key)?.close();
                  watchers.delete(key);
                }
              }
            }
          }
          if (ended) return;
          const relative = NodePath.relative(root, absolute);
          if (!WATCH_NOISE.test(relative)) {
            Queue.offerUnsafe(queue, relative);
          }
        };
        walk(root);
        if (watchers.size === 0) end();
        return { close: end };
      }),
      (handle) => Effect.sync(() => handle.close()),
    ),
  );
