/**
 * D7-R2 T1 fixture target parent: start the READY child, wait for the release
 * file the host writes after T1 is observed, then exit normally.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const [readyPath, releasePath, nonce, childScript] = process.argv.slice(2)
if (readyPath === undefined || releasePath === undefined || nonce === undefined || childScript === undefined) {
  console.error('target: usage <ready-path> <release-path> <nonce> <child-script>')
  process.exit(2)
}

// detached keeps the child out of the parent's console, so the console host that
// exits with the parent cannot take the surviving Job member down with it.
const child = spawn(process.execPath, [childScript, readyPath, nonce], {
  stdio: 'ignore',
  windowsHide: true,
  detached: true,
})
child.unref()

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

for (let waited = 0; !existsSync(readyPath); waited += 20) {
  if (waited > 20_000) {
    console.error('target: READY file never appeared')
    process.exit(3)
  }
  await sleep(20)
}

for (let waited = 0; !existsSync(releasePath); waited += 20) {
  if (waited > 60_000) {
    console.error('target: release file never appeared')
    process.exit(4)
  }
  await sleep(20)
}

// The parent leaves on its own; the child stays inside the Job for T2.
process.exit(0)
