/**
 * Create a brand-new topology from a template: keep one router + one switch,
 * drop everything else, and connect them with a straight-through cable.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decryptPkt, encryptPkt } from '../src/twofish-eax.js'
import { parseXml } from '../src/xml.js'
import { buildModel, detectIssues, renderSummary } from '../src/model.js'
import { retainOnly } from '../src/build.js'

const [tplPath, outPath] = process.argv.slice(2)

const { xml } = decryptPkt(readFileSync(tplPath))
const text = xml.toString('utf8')
const model = buildModel(parseXml(text))

console.log('=== 模板 ===')
console.log(`  ${model.devices.length} 台设备: ${model.devices.map((d) => `${d.name}(${d.type})`).join(', ')}`)

const router = model.devices.find((d) => d.type.toLowerCase() === 'router')
const sw = model.devices.find((d) => d.type.toLowerCase() === 'switch')
if (!router || !sw) throw new Error('模板里缺少路由器或交换机')

// Router <-> Switch is a different-layer link: straight-through.
const newXml = retainOnly(text, model, [router.name, sw.name], [
  { from: router.name, fromPort: 'GigabitEthernet0/0', to: sw.name, toPort: 'FastEthernet0/1', cable: 'eStraightThrough' }
])

writeFileSync(outPath, encryptPkt(Buffer.from(newXml, 'utf8')))
console.log(`\n=== 新建拓扑已写入 ${outPath} ===`)

const m2 = buildModel(parseXml(decryptPkt(readFileSync(outPath)).xml.toString('utf8')))
console.log(renderSummary(m2))

const issues = detectIssues(m2)
console.log('\n=== 检查 ===')
if (!issues.length) console.log('  ✓ 无问题')
for (const i of issues) console.log(`  [${i.severity}] ${i.device}: ${i.message}`)
