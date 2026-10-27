/**
 * Smoke test for the plugin entry point, without a DSH runtime.
 *
 * The two host packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`)
 * are stubbed through a Node module resolve hook, so this runs anywhere.
 *
 *   node test/plugin.test.mjs              # registration only
 *   node test/plugin.test.mjs lab.pkt      # also run pkt_read against a file
 */
import { register } from 'node:module'

const stubs = {
  '@deepseek-ai/schemastery': `
    const chain = (def) => ({
      default: () => chain(def),
      description: () => chain(def),
      _def: def
    })
    export default {
      object: () => chain({}),
      number: () => chain(0),
      string: () => chain(''),
      boolean: () => chain(false)
    }
  `,
  '@deepseek-ai/dsh-tools': `
    export function defineTool (options) { return options }
  `
}

const hooks = `
export async function resolve (spec, ctx, next) {
  if (spec === '@deepseek-ai/schemastery') return { url: 'stub:schemastery', shortCircuit: true }
  if (spec === '@deepseek-ai/dsh-tools') return { url: 'stub:tools', shortCircuit: true }
  return next(spec, ctx)
}
export async function load (url, ctx, next) {
  if (url === 'stub:schemastery') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(stubs['@deepseek-ai/schemastery'])} }
  if (url === 'stub:tools') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(stubs['@deepseek-ai/dsh-tools'])} }
  return next(url, ctx)
}
`

register('data:text/javascript,' + encodeURIComponent(hooks))

const mod = await import('../src/index.js')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

check('plugin exports name', typeof mod.name === 'string' && mod.name.length > 0, mod.name)
check('inject declares tools', Array.isArray(mod.inject) && mod.inject.includes('tools'))
check('apply is a function', typeof mod.apply === 'function')

const registered = []
const ctx = { tools: { register: (def) => { registered.push(def); return () => {} } } }
const dispose = mod.apply(ctx)

for (const name of ['pkt_read', 'pkt_open', 'pkt_fix', 'pkt_build', 'pkt_new']) {
  check(`registers ${name}`, registered.some((d) => d.name === name))
}
for (const def of registered) {
  check(`${def.name} declares output{render,schema}`,
    Boolean(def.output && typeof def.output.render === 'function' && def.output.schema))
}
check('apply returns a disposer', typeof dispose === 'function')

// optional end-to-end run against a real file
const file = process.argv[2]
if (file) {
  const read = registered.find((d) => d.name === 'pkt_read')
  const res = await read.execute({ path: file, section: 'summary' }, {})
  check('pkt_read summary on sample',
    typeof res.text === 'string' && res.text.length > 0,
    `${res.deviceCount} devices / ${res.linkCount} links`)
}

console.log('')
if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
