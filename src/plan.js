/**
 * Turn detected faults into concrete edit operations.
 */

import { detectIssues, collectAddresses, routingProtocols, parseIntentNotes } from './model.js'

const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
const ipToInt = (ip) => {
  const p = String(ip).split('.').map(Number)
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}
const maskOf = (prefix) => (prefix === 0 ? '0.0.0.0' : intToIp((0xffffffff << (32 - prefix)) >>> 0))

/** RIP declares classful networks: no wildcard, no area. */
function classfulNetwork (ip, mask) {
  const n = ipToInt(ip)
  if (n === null) return null
  const first = n >>> 24
  if (first < 128) return intToIp(n & 0xff000000)
  if (first < 192) return intToIp(n & 0xffff0000)
  return intToIp(n & 0xffffff00)
}

const CABLE_LABEL = { eStraightThrough: '直通线', eCrossOver: '交叉线' }

/**
 * Build an edit plan for a model.
 * @param {object} model
 * @param {{routing?: boolean}} [opts]
 */
export function planFixes (model, opts = {}) {
  const issues = detectIssues(model)
  const ops = []
  const notes = []
  const skipped = []

  const byName = new Map(model.devices.map((d) => [d.name, d]))
  const intent = parseIntentNotes(model)

  // ---- 1. cable types ----------------------------------------------------
  const linkIssues = issues.filter((i) => /线缆类型错误/.test(i.message))
  for (const i of linkIssues) {
    const m = /^(\S+)\s+(\S+)\s*↔\s*(\S+)\s+(\S+)$/.exec(i.device.trim())
    if (!m) { skipped.push(`无法解析链路标识: ${i.device}`); continue }
    const want = /应当用(直通线|交叉线)/.exec(i.message)?.[1]
    const to = want === '直通线' ? 'eStraightThrough' : 'eCrossOver'
    const idx = model.links.findIndex((l) =>
      l.from.device === m[1] && l.from.port === m[2] && l.to.device === m[3] && l.to.port === m[4])
    if (idx === -1) { skipped.push(`找不到链路: ${i.device}`); continue }
    ops.push({
      kind: 'cable',
      linkIndex: idx,
      to,
      describe: [`线缆 ${m[1]} ${m[2]} ↔ ${m[3]} ${m[4]}: 改为${CABLE_LABEL[to]}`]
    })
  }

  // ---- 2. shutdown interfaces that carry a link ---------------------------
  const downIssues = issues.filter((i) => /处于 shutdown/.test(i.message))
  const configOps = new Map() // deviceIndex -> op

  const ensureConfigOp = (deviceIndex) => {
    if (!configOps.has(deviceIndex)) {
      const op = { kind: 'config', deviceIndex, interfaces: [], describe: [] }
      configOps.set(deviceIndex, op)
      ops.push(op)
    }
    return configOps.get(deviceIndex)
  }

  for (const i of downIssues) {
    const dev = byName.get(i.device)
    if (!dev) continue
    const iface = /^(\S+)\s+接了链路/.exec(i.message)?.[1]
    if (!iface) continue
    const short = iface.replace(/[^0-9/]/g, '')
    const hint = intent.find((x) => x.iface && x.iface.replace(/[^0-9/]/g, '') === short)
    const want = { shutdown: false }
    if (hint && /未配置 IP|no ip address/.test(i.message)) {
      want.ip = hint.ip
      want.mask = hint.prefix ? maskOf(hint.prefix) : '255.255.255.0'
    }
    const op = ensureConfigOp(dev.index)
    op.interfaces.push({ name: iface, want })
    op.describe.push(
      `${dev.name} ${iface}: no shutdown` + (want.ip ? ` + ip address ${want.ip} ${want.mask}` : ''))
  }

  // ---- 3. endpoint gateways ----------------------------------------------
  const gwIssues = issues.filter((i) => /网关/.test(i.message))
  for (const i of gwIssues) {
    const dev = byName.get(i.device)
    if (!dev?.ipConfig?.ip) continue
    // find the router interface that owns this subnet
    const ip = ipToInt(dev.ipConfig.ip)
    let gw = null
    for (const other of model.devices) {
      for (const it of other.interfaces) {
        if (!it.ip || !it.mask || it.shutdown) continue
        const oip = ipToInt(it.ip)
        const om = ipToInt(it.mask)
        if (oip === null || om === null) continue
        if ((oip & om) === (ip & om)) { gw = it.ip; break }
      }
      if (gw) break
    }
    if (!gw) { skipped.push(`${dev.name}: 找不到同网段的路由器接口，无法自动推断网关`); continue }
    if (gw === dev.ipConfig.gateway) continue
    ops.push({
      kind: 'endpoint',
      deviceIndex: dev.index,
      want: { gateway: gw },
      describe: [`${dev.name} 默认网关: ${dev.ipConfig.gateway || '(空)'} → ${gw}`]
    })
  }

  // ---- 4. duplicate addresses --------------------------------------------
  const dupIssues = issues.filter((i) => /IP 地址重复/.test(i.message))
  for (const i of dupIssues) {
    const ip = /IP 地址重复:\s*(\S+)/.exec(i.message)?.[1]
    if (!ip) continue
    const holders = model.devices.filter((d) =>
      d.interfaces.some((it) => it.ip === ip) || d.ipConfig?.ip === ip)
    if (holders.length < 2) continue
    // keep the first holder, move the rest to the next free address
    const used = new Set(collectAddresses(model).map((a) => a.ip))
    for (const h of holders.slice(1)) {
      const iface = h.interfaces.find((it) => it.ip === ip)
      if (!iface) continue
      const base = ipToInt(ip)
      let candidate = null
      for (let n = 1; n < 255; n++) {
        const cand = intToIp(((base & 0xffffff00) >>> 0) + n)
        if (!used.has(cand)) { candidate = cand; break }
      }
      if (!candidate) { skipped.push(`${h.name}: ${ip} 所在网段没有空闲地址`); continue }
      used.add(candidate)
      const op = ensureConfigOp(h.index)
      op.interfaces.push({ name: iface.name, want: { ip: candidate, mask: iface.mask } })
      op.describe.push(`${h.name} ${iface.name}: ${ip} → ${candidate}（消除地址冲突）`)
    }
  }

  // ---- 5. routing protocol alignment -------------------------------------
  if (opts.routing !== false) {
    const routeIssues = issues.filter((i) => /路由协议不一致/.test(i.message))
    for (const i of routeIssues) {
      const pair = i.device.split('↔').map((s) => s.trim())
      // Prefer the side with the more complete configuration (more declared
      // networks); ties go to OSPF, which is what these labs usually converge on.
      const candidates = []
      for (const name of pair) {
        const d = byName.get(name)
        if (!d) continue
        for (const b of routingProtocols(d)) {
          candidates.push({ device: name, proto: b.proto, networks: b.networks.length })
        }
      }
      if (!candidates.length) {
        skipped.push(`${pair.join(' ↔ ')}: 两侧都没有路由配置，需人工决定协议`)
        continue
      }
      candidates.sort((a, b) => {
        if (b.networks !== a.networks) return b.networks - a.networks
        const rank = (p) => (p === 'ospf' ? 1 : 0)
        return rank(b.proto) - rank(a.proto)
      })
      const target = candidates[0]

      for (const name of pair) {
        const d = byName.get(name)
        if (!d) continue
        const blocks = routingProtocols(d)
        if (blocks.some((b) => b.proto === target.proto && b.networks.length)) continue
        const networks = d.interfaces
          .filter((it) => it.ip && it.mask)
          .map((it) => {
            const p = ipToInt(it.mask)
            if (p === null) return null
            return target.proto === 'rip'
              ? classfulNetwork(it.ip, p)
              : `${intToIp((ipToInt(it.ip) & p) >>> 0)} ${intToIp((~p) >>> 0)} area 0`
          })
          .filter(Boolean)
        if (!networks.length) { skipped.push(`${d.name}: 没有可宣告的直连网段`); continue }
        const op = ensureConfigOp(d.index)
        op.routing = { proto: target.proto, networks }
        op.describe.push(`${d.name}: 路由改为 ${target.proto}，宣告 ${networks.join(' / ')}`)
      }
    }
  }

  return { ops, issues, skipped }
}
