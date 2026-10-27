#!/usr/bin/env node
/**
 * Standalone CLI for reading Cisco Packet Tracer files.
 *
 *   node bin/pkt.mjs <file.pkt> [section] [--device NAME] [--out FILE]
 *
 * sections: summary (default) | topology | addresses | issues | configs |
 *           activity | xml | json
 */

import { readFile, writeFile } from 'node:fs/promises'
import { decryptPkt } from '../src/twofish-eax.js'
import { parseXml } from '../src/xml.js'
import { buildModel, renderSummary, collectAddresses, detectIssues, renderConfigs, renderFixPlan, routingProtocols } from '../src/model.js'

const argv = process.argv.slice(2)
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log(`用法: node bin/pkt.mjs <file.pkt|pka|pta> [section] [选项]

section:
  summary    概览：设备、链路、画布标注（默认）
  topology   设备与链路清单
  addresses  IP 地址表
  issues     地址/端口一致性提示
  configs    running-config 文本
  activity   Instructor 活动脚本与说明
  xml        解密后的原始 XML
  json       完整结构化数据

选项:
  --device NAME   仅输出指定设备的 configs
  --out FILE      写入文件而不是打印到标准输出`)
  process.exit(0)
}

const SECTIONS = ['summary', 'topology', 'addresses', 'issues', 'routing', 'configs', 'activity', 'fixplan', 'fix', 'build', 'xml', 'json']
const file = argv[0]
const section = argv.find((a, i) => i > 0 && !a.startsWith('--') && SECTIONS.includes(a)) ?? 'summary'
const devIdx = argv.indexOf('--device')
const device = devIdx !== -1 ? argv[devIdx + 1] : undefined
const outIdx = argv.indexOf('--out')
const outFile = outIdx !== -1 ? argv[outIdx + 1] : undefined

const { xml } = decryptPkt(await readFile(file))
const root = parseXml(xml.toString('utf8'))
const model = buildModel(root)

let output
switch (section) {
  case 'topology': {
    const rows = [`设备 ${model.devices.length} 台 · 链路 ${model.links.length} 条`, '']
    for (const d of model.devices) {
      rows.push(`[${d.index}] ${d.name}${d.hostname && d.hostname !== d.name ? ` (${d.hostname})` : ''} — ${d.type}` +
        (d.serial ? ` · SN ${d.serial}` : ''))
    }
    rows.push('', '链路:')
    for (const l of model.links) {
      rows.push(`  ${l.from.device} ${l.from.port} <--> ${l.to.device} ${l.to.port} [${l.medium || l.cableType}]`)
    }
    output = rows.join('\n')
    break
  }
  case 'addresses': {
    const rows = collectAddresses(model)
    const pad = (s, n) => String(s).padEnd(n)
    output = [pad('设备', 12) + pad('接口', 24) + pad('地址', 22) + '网关']
      .concat(rows.map((r) => pad(r.device, 12) + pad(r.iface, 24) +
        pad(`${r.ip}/${r.prefix ?? '?'}`, 22) + (r.gateway ?? '') + (r.shutdown ? '  [shutdown]' : '')))
      .join('\n')
    break
  }
  case 'issues': {
    const issues = detectIssues(model)
    output = issues.length
      ? issues.map((i) => `[${i.severity}] ${i.device}: ${i.message}`).join('\n')
      : '未发现明显的地址/端口配置矛盾。'
    break
  }
  case 'configs': output = renderConfigs(model, device); break
  case 'routing': {
    const rows = []
    for (const d of model.devices) {
      const blocks = routingProtocols(d)
      if (!blocks.length) continue
      rows.push(`${d.name}:`)
      for (const b of blocks) {
        rows.push(`  router ${b.proto}${b.id ? ' ' + b.id : ''}${b.networks.length ? '' : '  (无 network)'}`)
        for (const n of b.networks) rows.push(`    network ${n}`)
      }
    }
    output = rows.length ? rows.join('\n') : '未发现路由协议配置。'
    break
  }
  case 'fixplan': output = renderFixPlan(model); break
  case 'fix': {
    const { planFixes } = await import('../src/plan.js')
    const { applyOps } = await import('../src/edit.js')
    const { encryptPkt } = await import('../src/twofish-eax.js')
    const { ops, skipped } = planFixes(model)
    const rows = [`修复前: ${detectIssues(model).length} 处问题`]
    for (const op of ops) for (const d of op.describe ?? []) rows.push(`  · ${d}`)
    for (const s2 of skipped) rows.push(`  ! 跳过: ${s2}`)
    const target = outFile ?? file.replace(/\.pkt$/i, '') + '-fixed.pkt'
    const { xml: edited } = applyOps(xml.toString('utf8'), model, ops)
    await writeFile(target, encryptPkt(Buffer.from(edited, 'utf8')))
    rows.push(`已写入 ${target}`)
    process.stdout.write(rows.join('\n') + '\n')
    process.exit(0)
  }
  case 'build': {
    const specPath = device
    if (!specPath) throw new Error('build 需要 --spec <json文件>')
    const spec = JSON.parse(await readFile(specPath, 'utf8'))
    const { cloneDevice, addLink } = await import('../src/build.js')
    const { encryptPkt } = await import('../src/twofish-eax.js')
    let text = xml.toString('utf8')
    let m = model
    const idx = (n) => m.devices.findIndex((d) => d.name === n || d.hostname === n)
    for (const d of spec.devices ?? []) {
      const tpl = idx(d.like ?? m.devices.find((x) => x.type.toLowerCase() === 'pc').name)
      const r = cloneDevice(text, tpl, d)
      text = r.xml
      m = buildModel(parseXml(text))
    }
    for (const l of spec.links ?? []) {
      text = addLink(text, { from: idx(l.from), fromPort: l.fromPort, to: idx(l.to), toPort: l.toPort, cable: l.cable })
      m = buildModel(parseXml(text))
    }
    if (!outFile) throw new Error('build 需要 --out <输出.pkt>')
    await writeFile(outFile, encryptPkt(Buffer.from(text, 'utf8')))
    output = `已写入 ${outFile}\n结果: ${m.devices.length} 台设备 / ${m.links.length} 条链路`
    break
  }
  case 'activity': {
    const a = model.activity
    if (!a.instructions.length && !a.scripts.length) {
      output = '此文件不含 Instructor 活动脚本或说明文本。'
    } else {
      const rows = []
      for (const t of a.instructions) rows.push(t)
      for (const s of a.scripts) rows.push(`--- <${s.tag}> ---\n${s.text}`)
      output = rows.join('\n')
    }
    break
  }
  case 'xml': output = xml.toString('utf8'); break
  case 'json': output = JSON.stringify(model, null, 2); break
  default: output = renderSummary(model)
}

if (outFile) {
  await writeFile(outFile, output, 'utf8')
  console.error(`已写入 ${outFile} (${output.length} 字符)`)
} else {
  process.stdout.write(output + '\n')
}
