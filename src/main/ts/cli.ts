#!/usr/bin/env node
// The `ringi` executable. The interface itself is clients/cli/, put together by composition/; this file only runs it
// when started as a program.
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import './composition/index.ts'
import {failure, main} from './clients/cli/index.ts'

export {main}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    process.stderr.write(`ringi: ${failure(e)}\n`)
    process.exitCode = 1
  })
}
