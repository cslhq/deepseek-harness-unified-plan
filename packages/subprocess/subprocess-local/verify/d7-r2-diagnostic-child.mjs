/**
 * D7-R2 T1 fixture child: publish READY(pid, nonce) once, then stay alive so the
 * Job keeps exactly one surviving member after the target parent exits.
 */
import { renameSync, writeFileSync } from 'node:fs'

const [readyPath, nonce] = process.argv.slice(2)
if (readyPath === undefined || nonce === undefined) {
  console.error('child: usage <ready-path> <nonce>')
  process.exit(2)
}

const staging = `${readyPath}.tmp`
writeFileSync(staging, JSON.stringify({ pid: process.pid, nonce }))
renameSync(staging, readyPath)

// Stay resident until the Job terminates this process.
setInterval(() => {}, 1 << 30)
