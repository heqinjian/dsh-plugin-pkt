/**
 * Extract a usable model from a decrypted Packet Tracer document.
 *
 * Covers what a reader actually wants from a .pkt/.pka:
 *   - topology: devices (name, model, type), links (endpoints, cable type)
 *   - addressing: interface IPs from running-config, PC desktop settings
 *   - configs: running-config as text
 *   - annotations: canvas notes (often the exercise's addressing plan)
 *   - activity: instructor scripts, task/instruction text when present
 */

const text = (node, tag) => {
  const c = node?.child(tag)
  return c ? c.text.trim() : undefined
}

const linesOf = (node) => (node ? node.all('LINE').map((l) => l.text) : [])

/** Group running-config lines into interface blocks and global settings. */
function parseConfig (lines) {
  const interfaces = []
  const globals = []
  let current = null
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (!trimmed) continue
    const iface = /^interface\s+(\S+)/.exec(trimmed)
    if (iface) {
      current = { name: iface[1], lines: [] }
      interfaces.push(current)
      continue
    }
    if (/^[a-z]/.test(trimmed) && !/^\s/.test(line)) {
      // top-level command ends the current interface block
      if (/^(line|router|ip route|ip classless|spanning-tree|access-list|vlan|hostname|version|no |ip cef|ip flow|license|end|!)/.test(trimmed)) {
        current = null
      }
    }
    if (current && !/^(line|router|access-list|vlan|hostname|version|end|!)/.test(trimmed)) {
      current.lines.push(trimmed)
    } else if (trimmed !== '!') {
      globals.push(trimmed)
    }
  }
  return { interfaces, globals }
}

/** Pull addressing details out of one interface block. */
function interfaceAddress (iface) {
  const ip = iface.lines.find((l) => l.startsWith('ip address ') && !l.includes('dhcp'))
  const shutdown = iface.lines.includes('shutdown')
  if (!ip) return { ip: null, mask: null, shutdown }
  const parts = ip.split(/\s+/)
  return { ip: parts[2] ?? null, mask: parts[3] ?? null, shutdown }
}

function parseDevice (dev, index) {
  const engine = dev.child('ENGINE')
  if (!engine) return null
  const cfgNode = engine.child('RUNNINGCONFIG')
  const lines = linesOf(cfgNode)
  const { interfaces } = parseConfig(lines)

  const model = text(engine, 'MODEL') ||
    text(engine.child('MODULE') ?? new (Object)(), 'MODEL') || ''

  const workspace = dev.child('WORKSPACE')?.child('LOGICAL')

  const device = {
    index,
    name: text(engine, 'NAME') ?? '',
    hostname: text(engine, 'SYS_NAME') ?? '',
    type: text(engine, 'TYPE') ?? '',
    serial: text(engine, 'SERIALNUMBER') ?? '',
    model,
    power: text(engine, 'POWER') === 'true',
    position: workspace ? { x: Number(text(workspace, 'X')), y: Number(text(workspace, 'Y')) } : null,
    interfaces: interfaces.map((i) => ({ name: i.name, ...interfaceAddress(i) })),
    runningConfig: lines.join('\n')
  }

  // Endpoint settings live on the PORT nodes of the host module. Devices that
  // carry a running-config already expose their addressing through interfaces,
  // so only fall back to PORT data when there is no config.
  const port = engine.find('PORT').find((p) => p.textOf('IP'))
  if (port && !lines.length) {
    device.ipConfig = {
      ip: port.textOf('IP') ?? '',
      mask: port.textOf('SUBNET') ?? '',
      gateway: port.textOf('PORT_GATEWAY') ?? '',
      dns: port.textOf('PORT_DNS') ?? '',
      dhcp: port.textOf('PORT_DHCP_ENABLE') === 'true'
    }
  }
  return device
}

function parseLink (link, devices) {
  const cable = link.child('CABLE')
  if (!cable) return null
  const fromIdx = Number(text(cable, 'FROM'))
  const toIdx = Number(text(cable, 'TO'))
  const ports = cable.all('PORT').map((p) => p.text.trim())
  return {
    cableType: text(link, 'TYPE') ?? '',
    medium: text(cable, 'TYPE') ?? '',
    length: text(cable, 'LENGTH') ?? '',
    from: { device: devices[fromIdx]?.name ?? `#${fromIdx}`, port: ports[0] ?? '' },
    to: { device: devices[toIdx]?.name ?? `#${toIdx}`, port: ports[1] ?? '' }
  }
}

function collectNotes (root) {
  const notes = []
  for (const notesNode of root.find('NOTES')) {
    for (const note of notesNode.all('NOTE')) {
      const t = text(note, 'TEXT')
      if (t) notes.push({ text: t, x: Number(text(note, 'X')), y: Number(text(note, 'Y')) })
    }
  }
  return notes
}

/** Instructor activity content: scripts, instructions, assessment hooks. */
function collectActivity (root) {
  const activity = { instructions: [], scripts: [], meta: null, hasScripts: false }

  for (const sm of root.find('SCRIPT_MODULE')) {
    const meta = sm.child('PT_APP_META')
    if (meta) {
      activity.meta = {
        name: text(meta, 'NAME'),
        author: text(meta, 'AUTHOR'),
        description: text(meta, 'DESCRIPTION'),
        version: text(meta, 'VERSION')
      }
    }
    const scripts = sm.child('SCRIPTS')
    if (scripts) {
      // Script payloads may be nested arbitrarily; keep non-empty text blobs.
      const walk = (node) => {
        for (const c of node.children) {
          const t = c.text.trim()
          if (t.length > 0 && c.children.length === 0) {
            activity.scripts.push({ tag: c.tag, text: t })
            activity.hasScripts = true
          }
          walk(c)
        }
      }
      walk(scripts)
    }
  }

  // Some builds store task text in dedicated elements
  for (const tag of ['INSTRUCTIONS', 'TASK', 'ACTIVITY']) {
    for (const node of root.find(tag)) {
      const t = node.text.trim()
      if (t) activity.instructions.push(t)
    }
  }
  return activity
}

/**
 * Build the full model from decrypted XML.
 * @param {import('./xml.js').XmlNode} root
 */
export function buildModel (root) {
  // `root` may be the #document wrapper; descend to the real document element.
  const doc = root.tag === '#document' ? (root.children[0] ?? root) : root
  const network = doc.child('NETWORK')
  const devicesNode = network?.child('DEVICES')
  const linksNode = network?.child('LINKS')

  const devices = []
  if (devicesNode) {
    devicesNode.all('DEVICE').forEach((d, i) => {
      const parsed = parseDevice(d, i)
      if (parsed) devices.push(parsed)
    })
  }

  const links = []
  if (linksNode) {
    for (const l of linksNode.all('LINK')) {
      const parsed = parseLink(l, devices)
      if (parsed) links.push(parsed)
    }
  }

  return {
    version: text(doc, 'VERSION') ?? '',
    devices,
    links,
    notes: collectNotes(doc),
    activity: collectActivity(doc)
  }
}

/** Human-readable topology summary. */
export function renderSummary (model) {
  const out = []
  out.push(`Packet Tracer 文件  ·  版本 ${model.version || '未知'}`)
  out.push(`设备 ${model.devices.length} 台  ·  链路 ${model.links.length} 条`)

  out.push('')
  out.push('== 设备 ==')
  for (const d of model.devices) {
    const label = d.hostname && d.hostname !== d.name ? `${d.name} (${d.hostname})` : d.name
    const bits = [d.type]
    if (d.serial) bits.push(`SN ${d.serial}`)
    out.push(`  [${d.index}] ${label}  —  ${bits.join(' · ')}`)
    const addrs = d.interfaces.filter((i) => i.ip)
    for (const a of addrs) {
      const state = a.shutdown ? ' (shutdown)' : ''
      out.push(`        ${a.name}: ${a.ip}${a.mask ? '/' + a.mask : ''}${state}`)
    }
    const downIfaces = d.interfaces.filter((i) => !i.ip && i.shutdown)
    if (downIfaces.length) {
      out.push(`        未配置且已关闭: ${downIfaces.map((i) => i.name).join(', ')}`)
    }
    if (d.ipConfig?.ip) {
      const g = d.ipConfig.gateway ? `, 网关 ${d.ipConfig.gateway}` : ''
      out.push(`        IP ${d.ipConfig.ip}${d.ipConfig.mask ? ' / ' + d.ipConfig.mask : ''}${g}`)
    }
  }

  out.push('')
  out.push('== 链路 ==')
  for (const l of model.links) {
    out.push(`  ${l.from.device} ${l.from.port}  <-->  ${l.to.device} ${l.to.port}   [${l.medium || l.cableType}]`)
  }

  if (model.notes.length) {
    out.push('')
    out.push('== 画布标注 ==')
    for (const nt of model.notes) out.push(`  ${nt.text.replace(/\s+/g, ' ').trim()}`)
  }

  return out.join('\n')
}

/** Convert a dotted-quad netmask to a prefix length. */
function maskToPrefix (mask) {
  if (!mask) return null
  const parts = mask.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  let bits = 0
  for (const p of parts) bits += p.toString(2).split('').filter((c) => c === '1').length
  return bits
}

const ipToInt = (ip) => {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}

const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/** Every IP assignment in the file, normalised. */
export function collectAddresses (model) {
  const out = []
  for (const d of model.devices) {
    for (const i of d.interfaces) {
      if (!i.ip) continue
      out.push({
        device: d.name, hostname: d.hostname, iface: i.name,
        ip: i.ip, mask: i.mask, prefix: maskToPrefix(i.mask), shutdown: i.shutdown, kind: 'interface'
      })
    }
    if (d.ipConfig?.ip) {
      out.push({
        device: d.name, hostname: d.hostname, iface: '(NIC)',
        ip: d.ipConfig.ip, mask: d.ipConfig.mask,
        prefix: maskToPrefix(d.ipConfig.mask), gateway: d.ipConfig.gateway, kind: 'endpoint'
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- cabling --
// Ethernet pinning: MDI (router, PC, server) versus MDI-X (switch, hub).
// MDI-MDI and MDI-X-MDI-X need a crossover; MDI-MDI-X needs straight-through.
const MDI_TYPES = new Set(['router', 'pc', 'server', 'printer', 'ip phone', 'tablet', 'smartphone', 'pda', 'tv'])
const MDIX_TYPES = new Set(['switch', 'hub', 'bridge', 'accesspoint', 'multilayer switch', 'laptop'])

function wiringClass (deviceType) {
  const t = String(deviceType || '').toLowerCase().trim()
  if (MDI_TYPES.has(t)) return 'mdi'
  if (MDIX_TYPES.has(t)) return 'mdix'
  return null
}

const CABLE_LABEL = {
  eStraightThrough: '直通线',
  eCrossOver: '交叉线',
  eFiber: '光纤',
  eSerial: '串口线',
  ePhone: '电话线',
  eConsole: 'Console 线'
}

/** Parse `router <proto>` blocks (with their network statements) out of a config. */
const TOP_LEVEL = /^(interface|line|router|ip route|ip classless|ip cef|ip flow|no |hostname|end|!|spanning-tree|access-list|vlan|banner|clock|crypto|enable|license|logging|service|username|aaa|archive|controller|dial-peer|ntp|snmp-server|vtp|mpls|policy-map|class-map|route-map)\b/

export function routingProtocols (device) {
  const blocks = []
  let cur = null
  for (const raw of device.runningConfig.split('\n')) {
    const ln = raw.trim()
    if (!ln || ln === '!') continue
    const m = /^router\s+(\S+)(?:\s+(\S+))?/.exec(ln)
    if (m) {
      cur = { proto: m[1].toLowerCase(), id: m[2] ?? '', networks: [] }
      blocks.push(cur)
      continue
    }
    if (/^network\s+/.test(ln)) {
      if (cur) cur.networks.push(ln.replace(/^network\s+/, ''))
      continue
    }
    if (TOP_LEVEL.test(ln)) cur = null
  }
  return blocks
}

/**
 * Heuristic consistency checks. These are hints, not verdicts: Packet Tracer
 * labs often leave ports shut down on purpose.
 */
export function detectIssues (model) {
  const issues = []
  const addrs = collectAddresses(model)
  const byName = new Map(model.devices.map((d) => [d.name, d]))

  const linkedPorts = new Set()
  for (const l of model.links) {
    linkedPorts.add(`${l.from.device}|${l.from.port}`)
    linkedPorts.add(`${l.to.device}|${l.to.port}`)
  }

  // ---- 1. interfaces that carry a link but are administratively down -------
  for (const d of model.devices) {
    for (const i of d.interfaces) {
      if (i.shutdown && linkedPorts.has(`${d.name}|${i.name}`)) {
        issues.push({
          severity: 'high',
          device: d.name,
          message: `${i.name} 接了链路但处于 shutdown${i.ip ? '' : '，且未配置 IP'}，链路无法 up`
        })
      }
    }
  }

  // ---- 2. cable type against the MDI / MDI-X rule -------------------------
  for (const l of model.links) {
    const medium = l.medium || l.cableType
    if (medium !== 'eStraightThrough' && medium !== 'eCrossOver') continue
    const a = byName.get(l.from.device)
    const b = byName.get(l.to.device)
    if (!a || !b) continue
    const ca = wiringClass(a.type)
    const cb = wiringClass(b.type)
    if (!ca || !cb) continue
    const expected = ca === cb ? 'eCrossOver' : 'eStraightThrough'
    if (medium !== expected) {
      issues.push({
        severity: 'high',
        device: `${l.from.device} ${l.from.port} ↔ ${l.to.device} ${l.to.port}`,
        message: `线缆类型错误：当前是${CABLE_LABEL[medium] ?? medium}，` +
          `${a.type} ↔ ${b.type} 应当用${CABLE_LABEL[expected]}`
      })
    }
  }

  // ---- 3. routing protocol mismatch across a router-to-router link --------
  const protoByName = new Map()
  for (const d of model.devices) {
    const blocks = routingProtocols(d)
    if (blocks.length) protoByName.set(d.name, blocks)
  }
  for (const d of model.devices) {
    for (const b of routingProtocols(d)) {
      if (!b.networks.length) {
        issues.push({
          severity: 'medium',
          device: d.name,
          message: `router ${b.proto} 没有任何 network 声明，不会学习或通告任何路由`
        })
      }
    }
  }
  for (const l of model.links) {
    const pa = protoByName.get(l.from.device)
    const pb = protoByName.get(l.to.device)
    if (!pa || !pb) continue
    const sa = new Set(pa.map((b) => b.proto))
    const sb = new Set(pb.map((b) => b.proto))
    const shared = [...sa].filter((p) => sb.has(p))
    if (!shared.length) {
      issues.push({
        severity: 'high',
        device: `${l.from.device} ↔ ${l.to.device}`,
        message: `路由协议不一致：${l.from.device} 运行 ${[...sa].join('/')}，` +
          `${l.to.device} 运行 ${[...sb].join('/')}，两者不会建立邻居、也不会交换路由`
      })
    }
  }

  // ---- 4. endpoint default-gateway sanity ---------------------------------
  const interfaceIps = new Map()
  for (const a of addrs) {
    if (a.kind !== 'interface') continue
    if (!interfaceIps.has(a.ip)) interfaceIps.set(a.ip, a)
  }

  for (const a of addrs) {
    if (a.kind !== 'endpoint') continue
    const ip = ipToInt(a.ip)
    const gw = a.gateway ? ipToInt(a.gateway) : null

    if (!a.gateway) {
      issues.push({
        severity: 'medium',
        device: a.device,
        message: '未配置默认网关，无法与非直连网段通信'
      })
      continue
    }
    if (gw === null) continue

    if (a.gateway === a.ip) {
      issues.push({
        severity: 'high',
        device: a.device,
        message: `默认网关 ${a.gateway} 填成了本机地址`
      })
      continue
    }

    if (!interfaceIps.has(a.gateway)) {
      issues.push({
        severity: 'high',
        device: a.device,
        message: `默认网关 ${a.gateway} 在拓扑中没有任何接口使用该地址，ARP 不会得到响应`
      })
    }

    if (ip !== null && a.prefix) {
      const mask = a.prefix === 0 ? 0 : (0xffffffff << (32 - a.prefix)) >>> 0
      if ((ip & mask) !== (gw & mask)) {
        issues.push({
          severity: 'high',
          device: a.device,
          message: `默认网关 ${a.gateway} 不在本机网段 ${intToIp(ip & mask)}/${a.prefix} 内`
        })
      }
    }

    // mask disagreement with the router interface on the same segment
    if (ip !== null && a.prefix) {
      for (const [, iface] of interfaceIps) {
        const ifInt = ipToInt(iface.ip)
        if (ifInt === null || !iface.prefix) continue
        const im = iface.prefix === 0 ? 0 : (0xffffffff << (32 - iface.prefix)) >>> 0
        const sameSegment = (ifInt & im) === (ip & ((0xffffffff << (32 - iface.prefix)) >>> 0))
        if (sameSegment && iface.prefix !== a.prefix) {
          issues.push({
            severity: 'medium',
            device: a.device,
            message: `子网掩码 /${a.prefix} 与同网段 ${iface.device} ${iface.iface} 的 /${iface.prefix} 不一致`
          })
          break
        }
      }
    }
  }

  // ---- 5. duplicate addresses ---------------------------------------------
  const seen = new Map()
  for (const a of addrs) {
    if (!seen.has(a.ip)) seen.set(a.ip, new Set())
    seen.get(a.ip).add(a.device)
  }
  for (const [ip, who] of seen) {
    if (who.size > 1) {
      issues.push({ severity: 'high', device: [...who].join(', '), message: `IP 地址重复: ${ip}` })
    }
  }

  return issues
}

/**
 * Intended addressing parsed from canvas annotations, e.g.
 * "g0/1IP地址：12.0.0.1/24" or a bare "172.16.3.1".
 */
export function parseIntentNotes (model) {
  const out = []
  for (const n of model.notes) {
    const t = n.text.replace(/\s+/g, ' ').trim()
    const m = /^(\S*?)\s*IP\s*地址\s*[:：]\s*([\d.]+)(?:\/(\d+))?/.exec(t)
    if (m) {
      out.push({ iface: m[1] || null, ip: m[2], prefix: m[3] ? Number(m[3]) : null, raw: t })
      continue
    }
    const bare = /^([\d.]+)(?:\/(\d+))?$/.exec(t)
    if (bare) out.push({ iface: null, ip: bare[1], prefix: bare[2] ? Number(bare[2]) : null, raw: t })
  }
  return out
}

/** Turn detected issues into an ordered, actionable repair plan. */
export function renderFixPlan (model) {
  const issues = detectIssues(model)
  if (!issues.length) return '未发现需要修复的问题。'

  const intent = parseIntentNotes(model)
  const byName = new Map(model.devices.map((d) => [d.name, d]))
  const steps = []

  const cableIssues = issues.filter((i) => /线缆类型错误/.test(i.message))
  const downIssues = issues.filter((i) => /处于 shutdown/.test(i.message))
  const gwIssues = issues.filter((i) => /网关/.test(i.message))
  const dupIssues = issues.filter((i) => /IP 地址重复/.test(i.message))
  const routeIssues = issues.filter((i) => /路由协议不一致|没有任何 network/.test(i.message))

  let n = 0
  const step = (title, body) => steps.push(`${++n}. ${title}\n${body}`)

  for (const i of cableIssues) {
    const want = /应当用(直通线|交叉线)/.exec(i.message)?.[1] ?? '正确线型'
    step(`更换线缆（${i.device}）`,
      `   现状: ${i.message}\n` +
      `   操作: 在 PT 中删除这条连线，改用「${want}」重新连接两端，确认端口指示灯变绿。`)
  }

  for (const i of dupIssues) {
    const ip = /IP 地址重复:\s*(\S+)/.exec(i.message)?.[1]
    step(`消除地址冲突 ${ip}`,
      `   涉及: ${i.device}\n` +
      `   操作: 保留一端，另一端改成同网段的空闲地址（通常把一侧 .2 改成 .1）。\n` +
      `   参考命令: configure terminal / interface <互联口> / ip address <新地址> 255.255.255.0 / no shutdown`)
  }

  for (const i of downIssues) {
    const dev = byName.get(i.device)
    const iface = /(\S+)\s+接了链路/.exec(i.message)?.[1]
    // Annotations abbreviate interfaces ("g0/1"), so compare on the trailing number.
    const shortIface = iface ? iface.replace(/[^0-9/]/g, '') : null
    const hint = intent.find((x) => {
      if (!x.iface || !shortIface) return false
      const a = x.iface.toLowerCase().replace(/[^0-9/]/g, '')
      return a === shortIface
    })
    const host = dev?.hostname || i.device
    let cmds = `   ${host}> enable\n   ${host}# configure terminal\n   ${host}(config)# interface ${iface}\n`
    if (hint && /未配置 IP|no ip address/.test(i.message)) {
      const mask = hint.prefix ? intToIp(hint.prefix === 0 ? 0 : (0xffffffff << (32 - hint.prefix)) >>> 0) : '255.255.255.0'
      cmds += `   ${host}(config-if)# ip address ${hint.ip} ${mask}\n`
    }
    cmds += `   ${host}(config-if)# no shutdown\n   ${host}(config-if)# end`
    step(`启用 ${i.device} ${iface}`, `   现状: ${i.message}\n   参考命令:\n${cmds}`)
  }

  for (const i of gwIssues) {
    const dev = byName.get(i.device)
    const cur = dev?.ipConfig?.gateway || '(空)'
    step(`修正 ${i.device} 的默认网关`,
      `   现状: ${i.message}\n` +
      `   操作: PT 中双击 ${i.device} → Desktop → IP Configuration → Default Gateway 改为同网段路由器接口地址。\n` +
      `   当前值: ${cur}`)
  }

  if (routeIssues.length) {
    const routers = [...new Set(routeIssues.flatMap((i) => i.device.split('↔').map((s) => s.trim())))]
    const body = routers.map((r) => {
      const d = byName.get(r)
      if (!d) return ''
      const blocks = routingProtocols(d)
      const nets = []
      for (const it of d.interfaces) {
        if (!it.ip || !it.mask) continue
        const p = maskToPrefix(it.mask)
        if (p === null) continue
        const base = intToIp((ipToInt(it.ip) & ((0xffffffff << (32 - p)) >>> 0)) >>> 0)
        nets.push(`${base} ${intToIp((0xffffffff << (32 - p)) >>> 0)} area 0`)
      }
      const cur = blocks.length ? blocks.map((b) => `router ${b.proto}${b.id ? ' ' + b.id : ''}`).join(', ') : '无'
      return `   ${r}（当前 ${cur}）\n` +
        `     no router ${blocks[0]?.proto ?? 'rip'}\n` +
        `     router ospf 1\n` +
        nets.map((x) => `     network ${x}`).join('\n')
    }).filter(Boolean).join('\n')
    step('统一路由协议', `   现状: ${routeIssues.map((i) => i.message).join(' / ')}\n   参考命令:\n${body}`)
  }

  const other = issues.filter((i) => ![...cableIssues, ...downIssues, ...gwIssues, ...dupIssues, ...routeIssues].includes(i))
  for (const i of other) {
    step(`检查 ${i.device}`, `   ${i.message}`)
  }

  return `共 ${issues.length} 处问题，建议按下面顺序修复:\n\n` + steps.join('\n\n')
}

/** Render the running-config of one device, or of every device that has one. */
export function renderConfigs (model, deviceName) {
  const targets = deviceName
    ? model.devices.filter((d) => d.name === deviceName || d.hostname === deviceName)
    : model.devices.filter((d) => d.runningConfig.trim().length > 0)

  if (!targets.length) {
    return deviceName ? `未找到设备 ${deviceName}，或该设备没有 running-config。` : '此文件中没有设备保存了 running-config。'
  }

  const out = []
  for (const d of targets) {
    out.push(`===== ${d.name}${d.hostname && d.hostname !== d.name ? ` (${d.hostname})` : ''} — ${d.type} =====`)
    out.push(d.runningConfig || '(空)')
    out.push('')
  }
  return out.join('\n').trimEnd()
}
