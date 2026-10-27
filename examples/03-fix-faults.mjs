import { readFileSync, writeFileSync } from 'node:fs'
import { decryptPkt, encryptPkt } from '../src/twofish-eax.js'
import { parseXml } from '../src/xml.js'
import { buildModel, detectIssues } from '../src/model.js'
import { planFixes } from '../src/plan.js'
import { applyOps } from '../src/edit.js'

const [src, out] = process.argv.slice(2)
const { xml } = decryptPkt(readFileSync(src))
const text = xml.toString('utf8')
const model = buildModel(parseXml(text))
const before = detectIssues(model)
const { ops, skipped } = planFixes(model)

console.log(`修复前: ${before.length} 处`)
for (const i of before) console.log(`  [${i.severity}] ${i.device}: ${i.message}`)
console.log(`\n计划 ${ops.reduce((n,o)=>n+(o.describe?.length??0),0)} 项:`)
for (const op of ops) for (const d of op.describe ?? []) console.log('  · ' + d)
for (const s of skipped) console.log('  ! 跳过: ' + s)

const { xml: edited } = applyOps(text, model, ops)
writeFileSync(out, encryptPkt(Buffer.from(edited, 'utf8')))
const after = detectIssues(buildModel(parseXml(decryptPkt(readFileSync(out)).xml.toString('utf8'))))
console.log(`\n已写入 ${out}`)
console.log(`修复后: ${after.length} 处`)
for (const i of after) console.log(`  [${i.severity}] ${i.device}: ${i.message}`)
