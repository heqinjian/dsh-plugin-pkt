/**
 * Build new topology elements by cloning existing device blocks.
 *
 * Packet Tracer stores opaque memory addresses (MEM_ADDR, DEV_ADDR,
 * PORT_MEM_ADDR) that must stay unique. Cloning keeps every structural detail
 * PT needs (module trees, port tables, file manager state) and only renumbers
 * the addresses, which is far safer than synthesising a device from scratch.
 */

let addrCounter = 0
function nextAddr (used) {
  // PT addresses look like small integers; any unused value works.
  for (;;) {
    addrCounter++
    const candidate = 210000000 + addrCounter * 8
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

const ADDR_TAGS = ['MEM_ADDR', 'DEV_ADDR', 'PORT_MEM_ADDR', 'FROM_DEVICE_MEM_ADDR',
  'TO_DEVICE_MEM_ADDR', 'FROM_PORT_MEM_ADDR', 'TO_PORT_MEM_ADDR', 'DEVCLUSTERID']

/** Collect every numeric memory address already present. */
export function collectAddresses (xml) {
  const used = new Set()
  for (const tag of ADDR_TAGS) {
    const re = new RegExp(`<${tag}>(\\d+)</${tag}>`, 'g')
    let m
    while ((m = re.exec(xml)) !== null) used.add(Number(m[1]))
  }
  return used
}

/** Renumber every memory address inside one block so it does not collide. */
function renumber (block, used) {
  let out = block
  for (const tag of ['MEM_ADDR', 'DEV_ADDR', 'PORT_MEM_ADDR']) {
    out = out.replace(new RegExp(`<${tag}>(\\d+)</${tag}>`, 'g'),
      (_m, _old) => `<${tag}>${nextAddr(used)}</${tag}>`)
  }
  return out
}

/**
 * Clone a device block.
 * @param {string} xml full document
 * @param {number} templateIndex index into the DEVICE sequence
 * @param {{name: string, sysName?: string, ip?: string, mask?: string, gateway?: string}} opts
 */
export function cloneDevice (xml, templateIndex, opts) {
  const used = collectAddresses(xml)
  const blocks = [...xml.matchAll(/<DEVICE>[\s\S]*?<\/DEVICE>/g)]
  const tpl = blocks[templateIndex]
  if (!tpl) throw new Error(`no DEVICE at index ${templateIndex}`)

  let block = renumber(tpl[0], used)

  // identity: the ENGINE-level NAME carries a translate attribute; module and
  // email-client NAME elements must not be touched.
  block = block.replace(/(<NAME translate="[^"]*">)[^<]*(<\/NAME>)/, `$1${opts.name}$2`)
  if (opts.sysName) block = block.replace(/(<SYS_NAME>)[^<]*(<\/SYS_NAME>)/, `$1${opts.sysName}$2`)
  // fresh serial number so PT does not treat it as a duplicate
  block = block.replace(/<SERIALNUMBER>[^<]*<\/SERIALNUMBER>/,
    `<SERIALNUMBER>PTT${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}</SERIALNUMBER>`)

  // endpoint addressing on the PORT element
  if (opts.ip) {
    block = block.replace(/<IP>[^<]*<\/IP>/, `<IP>${opts.ip}</IP>`)
    block = block.replace(/<SUBNET>[^<]*<\/SUBNET>/, `<SUBNET>${opts.mask ?? '255.255.255.0'}</SUBNET>`)
    block = block.replace(/<PORT_GATEWAY>[\s\S]*?<\/PORT_GATEWAY>/,
      `<PORT_GATEWAY>${opts.gateway ?? ''}</PORT_GATEWAY>`)
    block = block.replace(/<PORT_GATEWAY\/>/, `<PORT_GATEWAY>${opts.gateway ?? ''}</PORT_GATEWAY>`)
  }

  // nudge the logical position so the new device is not stacked on the template
  const shift = 80 + Math.floor(Math.random() * 60)
  block = block.replace(/<X>([\d.]+)<\/X>/, (_m, v) => `<X>${Number(v) + shift}</X>`)
  block = block.replace(/<Y>([\d.]+)<\/Y>/, (_m, v) => `<Y>${Number(v) + shift}</Y>`)

  // append after the last DEVICE block
  const last = blocks[blocks.length - 1]
  const insertAt = last.index + last[0].length
  const newXml = xml.slice(0, insertAt) + '\n   ' + block + xml.slice(insertAt)
  return { xml: newXml, newIndex: blocks.length }
}

/**
 * Add a link between two devices by index.
 * @param {string} xml
 * @param {{from:number, fromPort:string, to:number, toPort:string, medium?:string, cable?:string}} spec
 */
export function addLink (xml, spec) {
  const used = collectAddresses(xml)
  const blocks = [...xml.matchAll(/<DEVICE>[\s\S]*?<\/DEVICE>/g)]
  const devAddr = (i) => {
    const m = /<MEM_ADDR>(\d+)<\/MEM_ADDR>/.exec(blocks[i]?.[0] ?? '')
    return m ? m[1] : '0'
  }
  const medium = spec.medium ?? 'eCopper'
  const cable = spec.cable ?? 'eStraightThrough'
  const link = `   <LINK>
    <TYPE>${medium}</TYPE>
    <CABLE>
     <LENGTH>1</LENGTH>
     <FROM>${spec.from}</FROM>
     <PORT>${spec.fromPort}</PORT>
     <TO>${spec.to}</TO>
     <PORT>${spec.toPort}</PORT>
     <FROM_DEVICE_MEM_ADDR>${devAddr(spec.from)}</FROM_DEVICE_MEM_ADDR>
     <TO_DEVICE_MEM_ADDR>${devAddr(spec.to)}</TO_DEVICE_MEM_ADDR>
     <FROM_PORT_MEM_ADDR>${nextAddr(used)}</FROM_PORT_MEM_ADDR>
     <TO_PORT_MEM_ADDR>${nextAddr(used)}</TO_PORT_MEM_ADDR>
     <GEO_VIEW_COLOR>#000000</GEO_VIEW_COLOR>
     <TYPE>${cable}</TYPE>
    </CABLE>
   </LINK>`

  const close = xml.indexOf('</LINKS>')
  if (close === -1) throw new Error('no </LINKS> element')
  return xml.slice(0, close) + link + '\n  ' + xml.slice(close)
}

/**
 * Create a brand-new topology by keeping only the named devices from a template
 * file, dropping every existing link and canvas note, then wiring the kept
 * devices as requested.
 *
 * Packet Tracer device blocks carry opaque structure that cannot be synthesised
 * from scratch, so a new lab is assembled by subsetting a known-good file.
 *
 * @param {string} xml
 * @param {import('./model.js').Model} model
 * @param {string[]} keepNames device names to retain
 * @param {Array<{from:string,fromPort:string,to:string,toPort:string,cable?:string}>} links
 */
export function retainOnly (xml, model, keepNames, links) {
  const keep = new Set(keepNames)
  const blocks = [...xml.matchAll(/<DEVICE>[\s\S]*?<\/DEVICE>/g)]

  const kept = []
  const newIndex = new Map()
  blocks.forEach((b, i) => {
    const name = model.devices[i]?.name
    if (!keep.has(name)) return
    newIndex.set(name, kept.length)
    kept.push(b[0])
  })

  const missing = [...keep].filter((n) => !newIndex.has(n))
  if (missing.length) throw new Error(`模板中没有这些设备: ${missing.join(', ')}`)
  if (!kept.length) throw new Error('没有保留任何设备')

  let doc = xml

  // --- devices -----------------------------------------------------------
  const devOpen = doc.indexOf('<DEVICES>')
  const devClose = doc.indexOf('</DEVICES>')
  if (devOpen === -1 || devClose === -1) throw new Error('no <DEVICES> element')
  const newDevices = '  <DEVICES>\n   ' + kept.join('\n   ') + '\n  </DEVICES>'
  doc = doc.slice(0, devOpen) + newDevices + doc.slice(devClose + '</DEVICES>'.length)

  // --- links -------------------------------------------------------------
  const linkOpen = doc.indexOf('<LINKS>')
  const linkClose = doc.indexOf('</LINKS>')
  if (linkOpen === -1 || linkClose === -1) throw new Error('no <LINKS> element')
  const used = collectAddresses(doc)
  const devMem = (name) => {
    const m = /<MEM_ADDR>(\d+)<\/MEM_ADDR>/.exec(kept[newIndex.get(name)])
    return m ? m[1] : '0'
  }
  const linkXml = links.map((l) => {
    const cable = l.cable ?? 'eStraightThrough'
    return `   <LINK>
    <TYPE>eCopper</TYPE>
    <CABLE>
     <LENGTH>1</LENGTH>
     <FROM>${newIndex.get(l.from)}</FROM>
     <PORT>${l.fromPort}</PORT>
     <TO>${newIndex.get(l.to)}</TO>
     <PORT>${l.toPort}</PORT>
     <FROM_DEVICE_MEM_ADDR>${devMem(l.from)}</FROM_DEVICE_MEM_ADDR>
     <TO_DEVICE_MEM_ADDR>${devMem(l.to)}</TO_DEVICE_MEM_ADDR>
     <FROM_PORT_MEM_ADDR>${nextAddr(used)}</FROM_PORT_MEM_ADDR>
     <TO_PORT_MEM_ADDR>${nextAddr(used)}</TO_PORT_MEM_ADDR>
     <GEO_VIEW_COLOR>#000000</GEO_VIEW_COLOR>
     <TYPE>${cable}</TYPE>
    </CABLE>
   </LINK>`
  }).join('\n')
  const newLinks = '  <LINKS>\n' + linkXml + '\n  </LINKS>'
  doc = doc.slice(0, linkOpen) + newLinks + doc.slice(linkClose + '</LINKS>'.length)

  // --- drop canvas notes (they describe the old layout) -------------------
  doc = doc.replace(/<NOTES>[\s\S]*?<\/NOTES>/g, '<NOTES></NOTES>')

  return doc
}
