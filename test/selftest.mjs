/**
 * Smoke test: Twofish known-answer test + container round-trip.
 *
 * Run with:  node test/selftest.mjs
 *
 * Needs no Packet Tracer file: it validates the cryptographic core against the
 * designers' published test vector and checks that encode/decode is lossless.
 */
import { Twofish, encryptPkt, decryptPkt } from '../src/twofish-eax.js'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

// 1. Twofish known-answer test: all-zero key, all-zero block
const tf = new Twofish(Buffer.alloc(16))
const kat = tf.encryptBlock(Buffer.alloc(16)).toString('hex').toUpperCase()
check('Twofish KAT', kat === '9F589F5CF6122C32B6BFEC2F2AE8C35A', kat)

// 2. subkeys must match the designers' ecb_ival.txt
const k0_7 = tf.k.slice(0, 8).map((w) => w.toString(16).toUpperCase().padStart(8, '0')).join(' ')
check('subkeys K0..K7', k0_7 === '52C54DDE 11F0626D 7CAC9D4A 4D1B4AAA B7B83A10 1E7D0BEB EE9C341F CFE14BE4')

// 3. container round-trip on a synthetic document
const xml = Buffer.from('<PACKETTRACER5>\n <VERSION>6.2.0.0052</VERSION>\n</PACKETTRACER5>\n', 'utf8')
const packed = encryptPkt(xml)
const back = decryptPkt(packed)
check('container round-trip', back.xml.equals(xml), `${packed.length} bytes`)

// 4. tampering must be detected by the EAX tag
const broken = Buffer.from(packed)
broken[Math.floor(broken.length / 2)] ^= 0xff
let detected = false
try { decryptPkt(broken) } catch { detected = true }
check('EAX detects corruption', detected)

console.log('')
if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
