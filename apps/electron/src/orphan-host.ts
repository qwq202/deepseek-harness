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
 * since claimed the number. Every kill here is gated on the live process's
 * command line still containing the CLI entry path that was recorded with it.
 * A process whose identity cannot be established is left alone.
 * @module @deepseek-ai/dsh-electron/orphan-host
 */

import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
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
/** Grace period between terminating an orphan and escalating to an unconditional kill. */
const REAP_GRACE_MS = 2_000

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
  await writeFile(recordPath(userDataDir), JSON.stringify(record), 'utf8')
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
  const [command, args] = process.platform === 'win32'
    // -NoProfile so a user's PowerShell profile cannot slow or break the lookup.
    ? ['powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]]
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
  let record: HostRecord
  try {
    record = JSON.parse(await readFile(recordPath(userDataDir), 'utf8')) as HostRecord
  } catch {
    // No record, or one written by an incompatible version: nothing is owed.
    return undefined
  }

  try {
    const commandLine = await commandLineOf(record.pid)
    // The process id alone proves nothing — the OS reuses them. Only a live
    // command line still naming the recorded CLI entry identifies our orphan.
    if (commandLine === undefined || !commandLine.includes(record.bin)) return undefined

    process.kill(record.pid, 'SIGTERM')
    await new Promise((resolve) => { setTimeout(resolve, REAP_GRACE_MS) })
    if (await commandLineOf(record.pid) !== undefined) process.kill(record.pid, 'SIGKILL')
    return record.pid
  } catch {
    // The orphan exited between the identity check and the signal, or the
    // signal was refused. Either way the record is stale and about to be
    // replaced by this run's own.
    return undefined
  } finally {
    await clearRunningHost(userDataDir).catch(() => {
      // A record that cannot be removed is overwritten by this run's own
      // recordRunningHost, so a failure here changes nothing.
    })
  }
}
