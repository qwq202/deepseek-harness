/**
 * Reaps a `dsh web` child left behind by a previous run of this shell.
 *
 * The ordinary shutdown path terminates the child, but nothing runs when the
 * shell's own process dies without notice — a force quit, a crash, `kill -9`.
 * The child survives, keeps its loopback port, and keeps whatever subprocesses
 * the agent had running. There is no cross-platform way to bind a child's
 * lifetime to its parent's, so this does not prevent the orphan: it records
 * the running child, and the next launch terminates whatever the last one left.
 * At most one orphan therefore outlives the shell, and only until it is
 * started again.
 *
 * Killing by recorded process id alone would be unsafe — the operating system
 * reuses process ids, so a stale record can name an unrelated process that has
 * since claimed the number. Every kill here, including the escalation, is gated
 * on the live process's command line still containing the CLI entry path
 * recorded with it. A process whose identity cannot be established is left
 * alone, and its record is left standing so the next launch tries again.
 *
 * The record is not trusted input. It lives in the shell's `userData`
 * directory, which is also the default workspace the agent runs in, so any
 * same-user process — the agent's own tools included — can write it. It is
 * validated before anything is looked up or signalled.
 * @module @deepseek-ai/dsh-electron/orphan-host
 */

import { execFile } from 'node:child_process'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Identity of the child process a run of this shell is responsible for. */
interface HostRecord {
  /** Process id of the spawned `dsh web` child. */
  pid: number
  /** The CLI entry path it was spawned with; the string a surviving process's command line must still contain. */
  bin: string
}

/** How long a process-identity lookup may take before the process is treated as unidentifiable. */
const IDENTITY_LOOKUP_TIMEOUT_MS = 5_000
/**
 * Grace period between signalling an orphan and escalating.
 *
 * Covers the host's own shutdown ladder (`PROCESS_SHUTDOWN_TIMEOUT_MS`, 5s)
 * with headroom, so its fiber disposal gets to terminate the subprocess and
 * terminal trees it owns. Escalating sooner would strand those.
 */
const REAP_GRACE_MS = 8_000

/**
 * Path of the record file for a given user-data directory.
 * @param userDataDir - the shell's `userData` directory.
 * @returns absolute path of the record file.
 */
function recordPath(userDataDir: string): string {
  return path.join(userDataDir, 'running-host.json')
}

/**
 * Records the child this run is responsible for.
 * @param userDataDir - the shell's `userData` directory.
 * @param record - identity of the spawned child.
 */
export async function recordRunningHost(userDataDir: string, record: HostRecord): Promise<void> {
  // Written beside the record and renamed over it, because writing in place
  // truncates first: a force quit during that window — the very case this
  // record exists to recover from — would leave an unparseable file, and the
  // next launch would abandon the surviving host instead of reaping it.
  const destination = recordPath(userDataDir)
  const pending = `${destination}.${String(process.pid)}.tmp`
  await writeFile(pending, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
  await rename(pending, destination)
}

/**
 * Clears the record after the child has been shut down normally.
 * @param userDataDir - the shell's `userData` directory.
 */
export async function clearRunningHost(userDataDir: string): Promise<void> {
  await rm(recordPath(userDataDir), { force: true })
}

/**
 * Reads the live command line of a process.
 * @param pid - process id to inspect.
 * @returns the command line, or undefined when the process is gone or cannot be inspected.
 */
async function commandLineOf(pid: number): Promise<string | undefined> {
  // The Windows lookup interpolates into a PowerShell script, so the caller
  // must have established that this is an integer; see `parseRecord`.
  const [command, args] = process.platform === 'win32'
    // -NoProfile so a user's PowerShell profile cannot slow or break the lookup.
    ? ['powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`]]
    : ['ps', ['-p', String(pid), '-o', 'command=']]
  return new Promise((resolve) => {
    execFile(command, args, { timeout: IDENTITY_LOOKUP_TIMEOUT_MS }, (error, stdout) => {
      // A non-zero exit is the ordinary answer for "no such process", and an
      // unavailable inspector is equally a case of "identity unknown"; both
      // resolve undefined so the caller leaves the process alone.
      resolve(error ? undefined : stdout.trim() || undefined)
    })
  })
}

/**
 * Terminates a `dsh web` child left behind by a previous run, if one is still
 * alive and still identifiable as ours, then clears the record.
 *
 * Never throws: a failure to reap must not stop the shell from starting.
 * @param userDataDir - the shell's `userData` directory.
 * @returns the process id that was terminated, or undefined when there was nothing to reap.
 */
export async function reapOrphanedHost(userDataDir: string): Promise<number | undefined> {
  let raw: string
  try {
    raw = await readFile(recordPath(userDataDir), 'utf8')
  } catch {
    // No record: nothing is owed.
    return undefined
  }

  const record = parseRecord(raw)
  if (record === undefined) {
    // Unusable content cannot identify anything, so there is nothing to reap
    // and nothing to protect; drop it so it stops being re-read every launch.
    await clearRunningHost(userDataDir).catch(() => {
      // Overwritten by this run's own recordRunningHost regardless.
    })
    return undefined
  }

  try {
    // The process id alone proves nothing — the OS reuses them. Only a live
    // command line still naming the recorded CLI entry identifies our orphan.
    if (!identifies(await commandLineOf(record.pid), record)) return undefined

    process.kill(record.pid, 'SIGTERM')
    await new Promise((resolve) => { setTimeout(resolve, REAP_GRACE_MS) })
    // Re-checked rather than assumed: between the signal and now the orphan may
    // have exited and its id been handed to something unrelated, and an
    // unconditional second kill would land on that instead.
    if (identifies(await commandLineOf(record.pid), record)) process.kill(record.pid, 'SIGKILL')

    await clearRunningHost(userDataDir).catch(() => {
      // Overwritten by this run's own recordRunningHost regardless.
    })
    return record.pid
  } catch {
    // The orphan exited between the identity check and the signal, or the
    // signal was refused. The record is left in place: a host this run could
    // not account for stays owed to the next launch.
    return undefined
  }
}

/**
 * Parses and validates a record read from disk.
 *
 * The file sits in the shell's `userData` directory, which is also the default
 * workspace the agent runs in, so its content is not trusted input: a `pid`
 * that is not an integer would reach the Windows lookup's PowerShell script,
 * and an empty `bin` would match every process's command line and turn the
 * reaper into "kill whatever holds this id".
 * @param raw - file content.
 * @returns the record, or undefined when it cannot identify a process.
 */
function parseRecord(raw: string): HostRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { pid, bin } = parsed as Partial<HostRecord>
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (typeof bin !== 'string' || bin.length === 0) return undefined
  return { pid, bin }
}

/**
 * Reports whether a live command line belongs to the recorded host.
 * @param commandLine - command line read from the running process, if any.
 * @param record - the record being reaped.
 * @returns true when the process is the recorded one.
 */
function identifies(commandLine: string | undefined, record: HostRecord): boolean {
  return commandLine !== undefined && commandLine.includes(record.bin)
}
