/**
 * Build: R1 + Switch0 -> PC(left) and Switch1 -> PC(right), each side its own subnet.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decryptPkt, encryptPkt } from '../src/twofish-eax.js'
import { parseXml } from '../src/xml.js'
import { buildModel, detectIssues, renderSummary } from '../src/model.js'
import { retainOnly } from '../src/build.js'
import { applyOps } from '../src/edit.js'

const [tplPath, outPath] = process.argv.slice(2)

const { xml } = decryptPkt(readFileSync(tplPath))
const text = xml.toString('utf8')
const model = buildModel(parseXml(text))

const ROUTER = 'R1'
const SW_L = 'Switch0'
const SW_R = 'Switch1'
const PC_L = 'PC1'
const PC_R = 'PC2'

// left / right addressing
const LEFT_NET = '114.0.0.0'
const LEFT_GW = '114.0.0.254'
const LEFT_PC = '114.0.0.1'
const RIGHT_NET = '54.0.0.0'
const RIGHT_GW = '54.0.0.254'
const RIGHT_PC = '54.0.0.1'
const MASK = '255.255.255.0'

// 1) keep only what we need, and wire it
let doc = retainOnly(text, model, [ROUTER, SW_L, SW_R, PC_L, PC_R], [
  { from: ROUTER, fromPort: 'GigabitEthernet0/0', to: SW_L, toPort: 'FastEthernet0/1', cable: 'eStraightThrough' },
  { from: ROUTER, fromPort: 'GigabitEthernet0/1', to: SW_R, toPort: 'FastEthernet0/1', cable: 'eStraightThrough' },
  { from: SW_L, fromPort: 'FastEthernet0/2', to: PC_L, toPort: 'FastEthernet0', cable: 'eStraightThrough' },
  { from: SW_R, fromPort: 'FastEthernet0/2', to: PC_R, toPort: 'FastEthernet0', cable: 'eStraightThrough' }
])

// 2) configure the router and the endpoints
const m2 = buildModel(parseXml(doc))
const idx = (n) => m2.devices.findIndex((d) => d.name === n)

const ops = [
  {
    kind: 'config',
    deviceIndex: idx(ROUTER),
    interfaces: [
      { name: 'GigabitEthernet0/0', want: { ip: LEFT_GW, mask: MASK, shutdown: false } },
      { name: 'GigabitEthernet0/1', want: { ip: RIGHT_GW, mask: MASK, shutdown: false } }
    ],
    routing: { proto: null, networks: [] },
    describe: [`${ROUTER} Gi0/0 = ${LEFT_GW}/24, Gi0/1 = ${RIGHT_GW}/24（清除旧路由配置）`]
  },
  {
    kind: 'endpoint',
    deviceIndex: idx(PC_L),
    want: { ip: LEFT_PC, mask: MASK, gateway: LEFT_GW },
    describe: [`${PC_L} = ${LEFT_PC}/24, 网关 ${LEFT_GW}`]
  },
  {
    kind: 'endpoint',
    deviceIndex: idx(PC_R),
    want: { ip: RIGHT_PC, mask: MASK, gateway: RIGHT_GW },
    describe: [`${PC_R} = ${RIGHT_PC}/24, 网关 ${RIGHT_GW}`]
  }
]

const res = applyOps(doc, m2, ops)
doc = res.xml
for (const c of res.changes) console.log('  · ' + c)

writeFileSync(outPath, encryptPkt(Buffer.from(doc, 'utf8')))
console.log(`\n已写入 ${outPath}\n`)

const final = buildModel(parseXml(decryptPkt(readFileSync(outPath)).xml.toString('utf8')))
console.log(renderSummary(final))

console.log('\n=== 检查 ===')
const issues = detectIssues(final)
if (!issues.length) console.log('  ✓ 无问题')
for (const i of issues) console.log(`  [${i.severity}] ${i.device}: ${i.message}`)
