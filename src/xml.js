/**
 * Minimal, dependency-free XML parser sufficient for Packet Tracer documents.
 *
 * Packet Tracer XML is machine-generated: no DTDs, no namespaces in practice,
 * and no mixed content beyond plain text. This parser builds a compact tree of
 * { tag, attrs, children, text } nodes.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities (s) {
  if (!s.includes('&')) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[body] ?? m
  })
}

export class XmlNode {
  constructor (tag, attrs) {
    this.tag = tag
    this.attrs = attrs ?? {}
    this.children = []
    this.text = ''
  }

  /** First direct child with the given tag. */
  child (tag) {
    return this.children.find((c) => c.tag === tag)
  }

  /** All direct children with the given tag. */
  all (tag) {
    return this.children.filter((c) => c.tag === tag)
  }

  /** Text of the first direct child with the given tag, trimmed. */
  textOf (tag) {
    const c = this.child(tag)
    return c ? c.text.trim() : undefined
  }

  /** Depth-first search for every descendant with the given tag. */
  find (tag, out = []) {
    for (const c of this.children) {
      if (c.tag === tag) out.push(c)
      c.find(tag, out)
    }
    return out
  }
}

/**
 * Parse an XML document into an XmlNode tree.
 * @param {string} src
 * @returns {XmlNode}
 */
export function parseXml (src) {
  const root = new XmlNode('#document')
  const stack = [root]
  let i = 0
  const n = src.length

  const top = () => stack[stack.length - 1]

  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      top().text += decodeEntities(src.slice(i))
      break
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt))

    // comment / CDATA / declaration / doctype
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      top().text += src.slice(lt + 9, end === -1 ? n : end)
      i = end === -1 ? n : end + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2)
      i = end === -1 ? n : end + 1
      continue
    }

    const gt = src.indexOf('>', lt + 1)
    if (gt === -1) {
      top().text += decodeEntities(src.slice(lt))
      break
    }
    let inner = src.slice(lt + 1, gt)
    i = gt + 1

    if (inner.startsWith('/')) {
      if (stack.length > 1) stack.pop()
      continue
    }

    let selfClosing = false
    if (inner.endsWith('/')) {
      selfClosing = true
      inner = inner.slice(0, -1)
    }

    const spaceAt = inner.search(/[\s]/)
    const tag = spaceAt === -1 ? inner : inner.slice(0, spaceAt)
    const attrs = {}
    if (spaceAt !== -1) {
      const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
      let m
      const attrSrc = inner.slice(spaceAt)
      while ((m = re.exec(attrSrc)) !== null) {
        attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '')
      }
    }

    const node = new XmlNode(tag, attrs)
    top().children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return root
}
