/**
 * Surgical edits on decrypted Packet Tracer XML.
 *
 * Everything is done as targeted text replacement inside the original document
 * so every unrelated byte (memory addresses, port tables, module trees, file
 * manager state) stays exactly as Packet Tracer wrote it. Re-serialising a
 * parsed tree would risk dropping structural details PT relies on.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Split the document into per-DEVICE blocks, preserving order. */
function deviceBlocks (xml) {
  const out = []
  const re = /<DEVICE>[\s\S]*?<\/DEVICE>/g
  let m
  while ((m = re.exec(xml)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/** Split the document into per-LINK blocks, preserving order. */
function linkBlocks (xml) {
  const out = []
  const re = /<LINK>[\s\S]*?<\/LINK>/g
  let m
  while ((m = re.exec(xml)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/** Read the LINE entries of a RUNNINGCONFIG element as an array of strings. */
function configLines (deviceXml) {
  const start = deviceXml.indexOf('<RUNNINGCONFIG>')
  if (start === -1) return null
  const end = deviceXml.indexOf('</RUNNINGCONFIG>', start)
  if (end === -1) return null
  const inner = deviceXml.slice(start, end)
  const lines = []
  const re = /<LINE>([\s\S]*?)<\/LINE>/g
  let m
  while ((m = re.exec(inner)) !== null) lines.push(m[1])
  return { start, end, lines }
}

function writeConfigLines (deviceXml, lines) {
  const info = configLines(deviceXml)
  if (!info) return deviceXml
  const body = lines.map((l) => `      <LINE>${esc(l)}</LINE>`).join('\n')
  const replacement = `<RUNNINGCONFIG>\n${body}\n    </RUNNINGCONFIG>`
  return deviceXml.slice(0, info.start) + replacement + deviceXml.slice(info.end + '</RUNNINGCONFIG>'.length)
}

/**
 * Rewrite one interface stanza inside a config line array.
 * @param {string[]} lines
 * @param {string} iface full interface name, e.g. "GigabitEthernet0/1"
 * @param {{ip?: string, mask?: string, shutdown?: boolean}} want
 */
function editInterface (lines, iface, want) {
  const startIdx = lines.findIndex((l) => l.trim() === `interface ${iface}`)
  if (startIdx === -1) return false
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (/^interface\s/.test(t) || /^[a-z]/.test(lines[i]) === false && /^!$/.test(t)) { endIdx = i; break }
    if (/^(router|line|ip route|end|!)$/.test(t.split(' ')[0])) { endIdx = i; break }
  }
  // collect body lines (everything indented under the interface)
  const body = []
  let i = startIdx + 1
  for (; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.startsWith(' ')) break
    body.push(raw)
  }
  endIdx = i

  const hasIp = want.ip !== undefined && want.ip !== null
  const out = []
  if (hasIp) out.push(` ip address ${want.ip} ${want.mask ?? '255.255.255.0'}`)
  for (const b of body) {
    const t = b.trim()
    if (hasIp && t === 'no ip address') continue
    if (hasIp && /^ip address /.test(t)) continue
    if (want.shutdown === false && t === 'shutdown') continue
    if (want.shutdown === true && t === 'no shutdown') continue
    out.push(b)
  }
  if (want.shutdown === true && !out.some((b) => b.trim() === 'shutdown')) out.push(' shutdown')
  if (want.shutdown === false && !out.some((b) => b.trim() === 'no shutdown')) {
    // absence of "shutdown" already means enabled; nothing to add
  }

  lines.splice(startIdx + 1, endIdx - startIdx - 1, ...out)
  return true
}

/** Replace the routing protocol block(s) of a config line array. */
function setRouting (lines, proto, networks) {
  // drop every existing "router X" block
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^router\s+/.test(lines[i].trim())) {
      let j = i + 1
      while (j < lines.length && lines[j].startsWith(' ')) j++
      lines.splice(i, j - i)
    }
  }
  if (!proto) return
  // OSPF/EIGRP/BGP need a process/AS id; RIP does not.
  const needsId = ['ospf', 'eigrp', 'bgp'].includes(proto)
  const block = [`router ${proto}${needsId ? ' 1' : ''}`]
  if (proto === 'rip') block.push(' version 2')
  for (const n of networks) block.push(` network ${n}`)
  if (proto === 'rip') block.push(' no auto-summary')
  // insert before the trailing "!" that follows the interface stanzas
  let at = lines.findIndex((l) => /^ip classless$/.test(l.trim()))
  if (at === -1) at = lines.findIndex((l) => /^end$/.test(l.trim()))
  if (at === -1) at = lines.length
  lines.splice(at, 0, ...block, '!')
}

/** Set the IP/gateway recorded on an endpoint's PORT element. */
function setEndpointAddressing (deviceXml, want) {
  let out = deviceXml
  if (want.ip) out = out.replace(/<IP>[^<]*<\/IP>/, `<IP>${esc(want.ip)}</IP>`)
  if (want.mask) out = out.replace(/<SUBNET>[^<]*<\/SUBNET>/, `<SUBNET>${esc(want.mask)}</SUBNET>`)
  if (want.gateway !== undefined) {
    out = out.replace(/<PORT_GATEWAY>[^<]*<\/PORT_GATEWAY>/, `<PORT_GATEWAY>${esc(want.gateway)}</PORT_GATEWAY>`)
    out = out.replace(/<PORT_GATEWAY\/>/, `<PORT_GATEWAY>${esc(want.gateway)}</PORT_GATEWAY>`)
    // The ENGINE-level GATEWAY mirrors the port gateway in Packet Tracer's UI.
    out = out.replace(/<GATEWAY>[^<]*<\/GATEWAY>/, `<GATEWAY>${esc(want.gateway)}</GATEWAY>`)
    out = out.replace(/<GATEWAY\/>/, `<GATEWAY>${esc(want.gateway)}</GATEWAY>`)
  }
  return out
}

/**
 * Apply a list of edits to a document.
 *
 * @param {string} xml decrypted XML
 * @param {import('./model.js').Model} model parsed model
 * @param {Array} ops operations produced by planFixes()
 * @returns {{xml: string, changes: string[]}}
 */
export function applyOps (xml, model, ops) {
  let doc = xml
  const changes = []

  // Devices and links are edited by index; re-slice after each mutation by
  // working on the block text and splicing it back.
  for (const op of ops) {
    if (op.kind === 'config') {
      const blocks = deviceBlocks(doc)
      const b = blocks[op.deviceIndex]
      if (!b) continue
      const info = configLines(b.text)
      if (!info) continue
      const lines = [...info.lines]
      let touched = false
      for (const ifaceOp of op.interfaces ?? []) {
        if (editInterface(lines, ifaceOp.name, ifaceOp.want)) touched = true
      }
      if (op.routing) {
        setRouting(lines, op.routing.proto, op.routing.networks)
        touched = true
      }
      if (!touched) continue
      const newBlock = writeConfigLines(b.text, lines)
      doc = doc.slice(0, b.start) + newBlock + doc.slice(b.end)
      changes.push(...(op.describe ?? []))
    } else if (op.kind === 'endpoint') {
      const blocks = deviceBlocks(doc)
      const b = blocks[op.deviceIndex]
      if (!b) continue
      const newBlock = setEndpointAddressing(b.text, op.want)
      if (newBlock === b.text) continue
      doc = doc.slice(0, b.start) + newBlock + doc.slice(b.end)
      changes.push(...(op.describe ?? []))
    } else if (op.kind === 'cable') {
      const blocks = linkBlocks(doc)
      const b = blocks[op.linkIndex]
      if (!b) continue
      // only the TYPE nested inside CABLE, not the outer medium TYPE
      const newBlock = b.text.replace(
        /(<CABLE>[\s\S]*?<TYPE>)([^<]*)(<\/TYPE>)/,
        (_m, pre, _old, post) => `${pre}${op.to}${post}`
      )
      if (newBlock === b.text) continue
      doc = doc.slice(0, b.start) + newBlock + doc.slice(b.end)
      changes.push(...(op.describe ?? []))
    }
  }

  return { xml: doc, changes }
}
