/**
 * dsh-plugin-pkt
 *
 * Reads Cisco Packet Tracer .pkt/.pka/.pta files and drives the installed
 * Packet Tracer Instructor application.
 *
 * This module deliberately imports nothing outside Node's standard library and
 * its own files: the DSH profile that hosts it does not carry
 * `@deepseek-ai/dsh-tools`, so the tool definition is assembled directly in the
 * shape the registry expects.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, basename, extname, dirname, join } from 'node:path'
import { decryptPkt, encryptPkt } from './twofish-eax.js'
import { parseXml } from './xml.js'
import {
  buildModel, renderSummary, collectAddresses, detectIssues,
  renderConfigs, renderFixPlan, routingProtocols
} from './model.js'
import { planFixes } from './plan.js'
import { applyOps } from './edit.js'
import { cloneDevice, addLink, retainOnly } from './build.js'

export const name = 'dsh-plugin-pkt'
export const inject = ['tools']

/** Candidate install locations for the Packet Tracer executable. */
const PT_CANDIDATES = [
  'D:\\CISCOPACKETTRACER\\Cisco Packet Tracer 6.2iv\\bin\\PacketTracer6.exe',
  'C:\\Program Files\\Cisco Packet Tracer 9.0.0\\bin\\PacketTracer.exe',
  'C:\\Program Files\\Cisco Packet Tracer 8.2.2\\bin\\PacketTracer.exe',
  'C:\\Program Files\\Cisco Packet Tracer 8.2.1\\bin\\PacketTracer.exe',
  'C:\\Program Files\\Cisco Packet Tracer 8.1.1\\bin\\PacketTracer.exe',
  'C:\\Program Files\\Cisco Packet Tracer 8.0.1\\bin\\PacketTracer.exe',
  'C:\\Program Files\\Cisco Packet Tracer 7.3.1\\bin\\PacketTracer.exe',
  'C:\\Program Files (x86)\\Cisco Packet Tracer 6.2\\bin\\PacketTracer6.exe'
]

function findPacketTracer (explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null
  for (const p of PT_CANDIDATES) if (existsSync(p)) return p
  return null
}

async function loadModel (filePath) {
  const abs = resolve(filePath)
  let raw
  try {
    raw = await readFile(abs)
  } catch (err) {
    throw new Error(`cannot read ${abs}: ${err.message}`)
  }
  let decoded
  try {
    decoded = decryptPkt(raw)
  } catch (err) {
    throw new Error(`not a decodable Packet Tracer file (${err.message})`)
  }
  const xml = decoded.xml.toString('utf8')
  return { model: buildModel(parseXml(xml)), xml, abs }
}

// ------------------------------------------------------------------ views --
function renderTopology (model) {
  const out = [`设备 ${model.devices.length} 台 · 链路 ${model.links.length} 条`, '']
  for (const d of model.devices) {
    out.push(`[${d.index}] ${d.name}${d.hostname && d.hostname !== d.name ? ` (${d.hostname})` : ''} — ${d.type}` +
      (d.serial ? ` · SN ${d.serial}` : ''))
  }
  out.push('', '链路:')
  for (const l of model.links) {
    out.push(`  ${l.from.device} ${l.from.port} <--> ${l.to.device} ${l.to.port} [${l.medium || l.cableType}]`)
  }
  return out.join('\n')
}

function renderAddresses (model) {
  const rows = collectAddresses(model)
  if (!rows.length) return '未找到任何 IP 配置。'
  const pad = (s, n) => String(s).padEnd(n)
  const out = [`${pad('设备', 12)}${pad('接口', 24)}${pad('地址', 22)}网关`]
  for (const r of rows) {
    out.push(`${pad(r.device, 12)}${pad(r.iface, 24)}${pad(`${r.ip}/${r.prefix ?? '?'}`, 22)}${r.gateway ?? ''}` +
      (r.shutdown ? '  [shutdown]' : ''))
  }
  return out.join('\n')
}

function renderIssues (model) {
  const issues = detectIssues(model)
  if (!issues.length) return '未发现明显的配置矛盾。'
  return issues.map((i) => `[${i.severity}] ${i.device}: ${i.message}`).join('\n')
}

function renderRouting (model) {
  const out = []
  for (const d of model.devices) {
    const blocks = routingProtocols(d)
    if (!blocks.length) continue
    out.push(`${d.name}:`)
    for (const b of blocks) {
      out.push(`  router ${b.proto}${b.id ? ' ' + b.id : ''}${b.networks.length ? '' : '  (无 network)'}`)
      for (const n of b.networks) out.push(`    network ${n}`)
    }
  }
  return out.length ? out.join('\n') : '未发现路由协议配置。'
}

function renderActivity (model) {
  const a = model.activity
  const out = []
  if (a.meta && (a.meta.name || a.meta.description)) {
    out.push('== 活动元信息 ==')
    if (a.meta.name) out.push(`  名称: ${a.meta.name}`)
    if (a.meta.description) out.push(`  描述: ${a.meta.description}`)
    if (a.meta.author) out.push(`  作者: ${a.meta.author}`)
    out.push('')
  }
  for (const t of a.instructions) out.push(t)
  for (const s of a.scripts) out.push(`--- <${s.tag}> ---\n${s.text}`)
  if (!out.length) {
    return '此文件不含 Instructor 活动脚本或说明文本。\n' +
      '（.pkt 是保存的网络拓扑；题干与评分点通常只存在于 .pka 活动文件中。）'
  }
  return out.join('\n').trimEnd()
}

// ------------------------------------------------------------------ tools --
const SECTIONS = ['summary', 'topology', 'addresses', 'issues', 'routing', 'configs', 'activity', 'fixplan', 'xml']

const READ_DEF = {
  name: 'pkt_read',
  description:
    'Read a Cisco Packet Tracer file (.pkt/.pka/.pta). Decrypts the container in-process and returns ' +
    'topology, IP addressing, detected configuration faults, routing protocols, running-configs, ' +
    'instructor activity content, a repair plan, or the raw decrypted XML.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the .pkt/.pka/.pta file.'
      },
      section: {
        type: 'string',
        enum: SECTIONS,
        description: 'summary (default) | topology | addresses | issues | routing | configs | activity | fixplan | xml'
      },
      device: {
        type: 'string',
        description: 'For section=configs, restrict to this device name or hostname.'
      }
    },
    required: ['path']
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        section: { type: 'string' },
        version: { type: 'string' },
        deviceCount: { type: 'number' },
        linkCount: { type: 'number' },
        text: { type: 'string' }
      },
      required: ['text']
    },
    render: (_args, value) => [{ type: 'text', text: value.text }]
  },
  async execute (args) {
    if (!args?.path) throw new Error('path is required')
    const { model, xml } = await loadModel(args.path)
    const section = args.section ?? 'summary'

    let text
    switch (section) {
      case 'topology': text = renderTopology(model); break
      case 'addresses': text = renderAddresses(model); break
      case 'issues': text = renderIssues(model); break
      case 'routing': text = renderRouting(model); break
      case 'configs': text = renderConfigs(model, args.device); break
      case 'activity': text = renderActivity(model); break
      case 'fixplan': text = renderFixPlan(model); break
      case 'xml': text = xml; break
      default: text = renderSummary(model)
    }

    return {
      path: args.path,
      section,
      version: model.version,
      deviceCount: model.devices.length,
      linkCount: model.links.length,
      text
    }
  }
}

const OPEN_DEF = {
  name: 'pkt_open',
  description:
    'Launch the installed Cisco Packet Tracer (Instructor) application with a .pkt/.pka file, ' +
    'so the user can inspect or edit it interactively. Returns the executable used and its PID.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the .pkt/.pka file to open.'
      },
      exe: {
        type: 'string',
        description: 'Optional explicit path to the Packet Tracer executable. Auto-detected when omitted.'
      }
    },
    required: ['path']
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        exe: { type: 'string' },
        file: { type: 'string' },
        pid: { type: 'number' },
        text: { type: 'string' }
      },
      required: ['text']
    },
    render: (_args, value) => [{ type: 'text', text: value.text }]
  },
  async execute (args) {
    if (!args?.path) throw new Error('path is required')
    const abs = resolve(args.path)
    if (!existsSync(abs)) throw new Error(`file not found: ${abs}`)
    const ext = extname(abs).toLowerCase()
    if (!['.pkt', '.pka', '.pta', '.pkz'].includes(ext)) {
      throw new Error(`unsupported extension: ${ext}`)
    }
    const exe = findPacketTracer(args.exe)
    if (!exe) {
      throw new Error(
        'Packet Tracer executable not found. Pass exe=<path to PacketTracer*.exe>; ' +
        'searched: ' + PT_CANDIDATES.join(', ')
      )
    }
    const child = spawn(exe, [abs], { detached: true, stdio: 'ignore' })
    child.unref()
    return {
      exe,
      file: abs,
      pid: child.pid ?? 0,
      text: `已启动 ${basename(exe)} 打开 ${basename(abs)}（PID ${child.pid ?? '?'}）。`
    }
  }
}

const FIX_DEF = {
  name: 'pkt_fix',
  description:
    'Repair a Cisco Packet Tracer file: detect faults and rewrite the file with fixes applied ' +
    '(cable types, shutdown interfaces, interface IPs, endpoint gateways, duplicate addresses, ' +
    'routing protocol alignment). Writes a new .pkt and verifies the result by re-decoding it. ' +
    'Use write=false to preview the plan only.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Source .pkt/.pka file.'
      },
      out: {
        type: 'string',
        description: 'Output path. Defaults to "<name>-fixed.pkt" next to the source.'
      },
      write: {
        type: 'boolean',
        description: 'Write the repaired file (default true). false = dry run, plan only.'
      },
      routing: {
        type: 'boolean',
        description: 'Also align routing protocols (default true).'
      }
    },
    required: ['path']
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        out: { type: 'string' },
        written: { type: 'boolean' },
        changeCount: { type: 'number' },
        remainingIssues: { type: 'number' },
        text: { type: 'string' }
      },
      required: ['text']
    },
    render: (_args, value) => [{ type: 'text', text: value.text }]
  },
  async execute (args) {
    if (!args?.path) throw new Error('path is required')
    const abs = resolve(args.path)
    const raw = await readFile(abs)
    const { xml } = decryptPkt(raw)
    const text = xml.toString('utf8')
    const model = buildModel(parseXml(text))

    const before = detectIssues(model)
    const { ops, skipped } = planFixes(model, { routing: args.routing !== false })

    const out = []
    out.push(`源文件: ${abs}`)
    out.push(`修复前: ${before.length} 处问题`)
    for (const i of before) out.push(`  [${i.severity}] ${i.device}: ${i.message}`)
    out.push('')
    out.push(`修复计划: ${ops.reduce((n, o) => n + (o.describe?.length ?? 0), 0)} 项变更`)
    for (const op of ops) for (const d of op.describe ?? []) out.push(`  · ${d}`)
    for (const s of skipped) out.push(`  ! 跳过: ${s}`)

    if (args.write === false) {
      return { out: '', written: false, changeCount: 0, remainingIssues: before.length, text: out.join('\n') }
    }

    const { xml: edited, changes } = applyOps(text, model, ops)
    const outPath = args.out
      ? resolve(args.out)
      : join(dirname(abs), `${basename(abs, extname(abs))}-fixed.pkt`)
    await writeFile(outPath, encryptPkt(Buffer.from(edited, 'utf8')))

    // verify by decoding what we just wrote
    const check = decryptPkt(await readFile(outPath))
    const after = detectIssues(buildModel(parseXml(check.xml.toString('utf8'))))

    out.push('')
    out.push(`已写入: ${outPath}`)
    out.push(`修复后: ${after.length} 处问题`)
    for (const i of after) out.push(`  [${i.severity}] ${i.device}: ${i.message}`)
    if (!after.length) out.push('  ✓ 未检出剩余问题')

    return {
      out: outPath,
      written: true,
      changeCount: changes.length,
      remainingIssues: after.length,
      text: out.join('\n')
    }
  }
}

const BUILD_DEF = {
  name: 'pkt_build',
  description:
    'Build onto a Cisco Packet Tracer file: clone existing devices as new ones (optionally setting ' +
    'IP/mask/gateway) and wire them up with links. Devices are cloned from a template already in the ' +
    'file, so Packet Tracer keeps accepting the result. Writes a new .pkt and re-verifies it.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Source .pkt file to build from.'
      },
      out: {
        type: 'string',
        description: 'Output path. Defaults to "<name>-built.pkt" next to the source.'
      },
      devices: {
        type: 'array',
        description: 'Devices to add. Each is cloned from the first device whose type matches "template" (default: same as "like").',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Device display name, e.g. PC3.' },
            like: { type: 'string', description: 'Existing device name to clone (e.g. PC1).' },
            sysName: { type: 'string', description: 'Optional hostname.' },
            ip: { type: 'string', description: 'Optional IP address.' },
            mask: { type: 'string', description: 'Optional subnet mask.' },
            gateway: { type: 'string', description: 'Optional default gateway.' }
          },
          required: ['name']
        }
      },
      links: {
        type: 'array',
        description: 'Links to add between devices (by name).',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Device name.' },
            fromPort: { type: 'string', description: 'Port on "from", e.g. FastEthernet0.' },
            to: { type: 'string', description: 'Device name.' },
            toPort: { type: 'string', description: 'Port on "to", e.g. FastEthernet0/3.' },
            cable: {
              type: 'string',
              enum: ['eStraightThrough', 'eCrossOver'],
              description: 'Cable type. Defaults to straight-through; use eCrossOver for like-device links.'
            }
          },
          required: ['from', 'fromPort', 'to', 'toPort']
        }
      },
      write: {
        type: 'boolean',
        description: 'Write the result (default true).'
      }
    },
    required: ['path']
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        out: { type: 'string' },
        written: { type: 'boolean' },
        deviceCount: { type: 'number' },
        linkCount: { type: 'number' },
        text: { type: 'string' }
      },
      required: ['text']
    },
    render: (_args, value) => [{ type: 'text', text: value.text }]
  },
  async execute (args) {
    if (!args?.path) throw new Error('path is required')
    const abs = resolve(args.path)
    const { xml } = decryptPkt(await readFile(abs))
    let text = xml.toString('utf8')
    let model = buildModel(parseXml(text))
    const log = []

    const indexOf = (name) => model.devices.findIndex((d) => d.name === name || d.hostname === name)

    for (const spec of args.devices ?? []) {
      const like = spec.like ?? model.devices.find((d) => d.type.toLowerCase() === 'pc')?.name
      const tpl = indexOf(like)
      if (tpl === -1) { log.push(`! 跳过 ${spec.name}: 找不到模板设备 ${like}`); continue }
      const { xml: next, newIndex } = cloneDevice(text, tpl, spec)
      text = next
      model = buildModel(parseXml(text))
      log.push(`+ 设备 ${spec.name}（克隆自 ${like}，索引 ${newIndex}）` +
        (spec.ip ? ` ip ${spec.ip}` : ''))
    }

    for (const spec of args.links ?? []) {
      const a = indexOf(spec.from)
      const b = indexOf(spec.to)
      if (a === -1 || b === -1) { log.push(`! 跳过链路 ${spec.from}↔${spec.to}: 设备不存在`); continue }
      text = addLink(text, {
        from: a, fromPort: spec.fromPort, to: b, toPort: spec.toPort, cable: spec.cable
      })
      model = buildModel(parseXml(text))
      log.push(`+ 链路 ${spec.from} ${spec.fromPort} ↔ ${spec.to} ${spec.toPort} [${spec.cable ?? 'eStraightThrough'}]`)
    }

    if (args.write === false) {
      return { out: '', written: false, deviceCount: model.devices.length, linkCount: model.links.length, text: log.join('\n') }
    }

    const outPath = args.out
      ? resolve(args.out)
      : join(dirname(abs), `${basename(abs, extname(abs))}-built.pkt`)
    await writeFile(outPath, encryptPkt(Buffer.from(text, 'utf8')))

    const check = buildModel(parseXml(decryptPkt(await readFile(outPath)).xml.toString('utf8')))
    log.push('')
    log.push(`已写入 ${outPath}`)
    log.push(`结果: ${check.devices.length} 台设备 / ${check.links.length} 条链路`)
    const issues = detectIssues(check)
    if (issues.length) {
      log.push(`新拓扑中检出 ${issues.length} 处问题:`)
      for (const i of issues) log.push(`  [${i.severity}] ${i.device}: ${i.message}`)
    } else {
      log.push('✓ 新拓扑未检出配置问题')
    }

    return {
      out: outPath,
      written: true,
      deviceCount: check.devices.length,
      linkCount: check.links.length,
      text: log.join('\n')
    }
  }
}

const NEW_DEF = {
  name: 'pkt_new',
  description:
    'Create a brand-new Packet Tracer topology from an existing template file: keep only the named ' +
    'devices (dropping all other devices, links and canvas notes), then wire the kept devices as ' +
    'requested. Use this to start a fresh lab containing just the devices you want.',
  parameters: {
    type: 'object',
    properties: {
      template: {
        type: 'string',
        description: 'Existing .pkt to borrow device definitions from.'
      },
      out: {
        type: 'string',
        description: 'Output path for the new .pkt (required).'
      },
      keep: {
        type: 'array',
        items: { type: 'string' },
        description: 'Device names to keep, e.g. ["R1","Switch0"]. Others are removed.'
      },
      links: {
        type: 'array',
        description: 'Links to create between kept devices.',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            fromPort: { type: 'string' },
            to: { type: 'string' },
            toPort: { type: 'string' },
            cable: { type: 'string', enum: ['eStraightThrough', 'eCrossOver'] }
          },
          required: ['from', 'fromPort', 'to', 'toPort']
        }
      }
    },
    required: ['template', 'out', 'keep']
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        out: { type: 'string' },
        deviceCount: { type: 'number' },
        linkCount: { type: 'number' },
        text: { type: 'string' }
      },
      required: ['text']
    },
    render: (_args, value) => [{ type: 'text', text: value.text }]
  },
  async execute (args) {
    if (!args?.template || !args?.out) throw new Error('template and out are required')
    const tplPath = resolve(args.template)
    const { xml } = decryptPkt(await readFile(tplPath))
    const text = xml.toString('utf8')
    const model = buildModel(parseXml(text))

    const newXml = retainOnly(text, model, args.keep ?? [], args.links ?? [])
    const outPath = resolve(args.out)
    await writeFile(outPath, encryptPkt(Buffer.from(newXml, 'utf8')))

    const check = buildModel(parseXml(decryptPkt(await readFile(outPath)).xml.toString('utf8')))
    const lines = [
      `模板: ${tplPath}`,
      `保留: ${args.keep.join(', ')}`,
      `已写入: ${outPath}`,
      '',
      renderSummary(check)
    ]
    const issues = detectIssues(check)
    lines.push('')
    lines.push(issues.length ? `检出 ${issues.length} 处问题:` : '✓ 未检出配置问题')
    for (const i of issues) lines.push(`  [${i.severity}] ${i.device}: ${i.message}`)

    return {
      out: outPath,
      deviceCount: check.devices.length,
      linkCount: check.links.length,
      text: lines.join('\n')
    }
  }
}

export function apply (ctx) {
  const disposers = []
  disposers.push(ctx.tools.register(READ_DEF))
  disposers.push(ctx.tools.register(OPEN_DEF))
  disposers.push(ctx.tools.register(FIX_DEF))
  disposers.push(ctx.tools.register(BUILD_DEF))
  disposers.push(ctx.tools.register(NEW_DEF))
  return () => {
    for (const d of disposers.reverse()) {
      try { d?.() } catch { /* ignore */ }
    }
  }
}
