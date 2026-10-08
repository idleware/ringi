#!/usr/bin/env node
// The `ringi` executable. The interface itself is cli/; this file only runs it when started as a program.
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {main} from './cli/index.ts'
import {Fail} from './lib/index.ts'

export {main}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    process.stderr.write(`ringi: ${e instanceof Fail ? e.message : (e as Error).stack}\n`)
    process.exitCode = 1
  })
}
