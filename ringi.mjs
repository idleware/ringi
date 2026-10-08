#!/usr/bin/env node
// Temporary launcher for scripts that still call ./ringi.mjs during the move to src/main/ts; the command is `ringi`
// (target/esm/cli.js). Removed once nothing calls this path.
const {main} = await import('./target/esm/cli.js')
main().catch(e => {
  process.stderr.write(`ringi: ${e?.constructor?.name === 'Fail' ? e.message : e.stack}\n`)
  process.exitCode = 1
})
