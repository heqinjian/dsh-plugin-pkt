# dsh-plugin-pkt — Cisco Packet Tracer read/write & automation plugin

**English** | [中文](README.md)

A Packet Tracer plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
read and diagnose `.pkt` / `.pka` / `.pta` files, **repair** them, **build new topologies
from a template**, and launch the local Packet Tracer (Instructor) to open a file.

Pure JavaScript, **zero third-party dependencies**: the container format is encoded and
decoded in-process (Twofish-EAX + zlib).

> Works as a standalone command-line tool without installing the plugin — see
> [section 5](#5-command-line-no-install-required).

---

## 1. Tools

| Tool | What it does |
|---|---|
| `pkt_read` | Read a file; returns a different view per `section` |
| `pkt_fix` | **Detect and repair faults**, write a new file and re-verify it |
| `pkt_new` | **Build a topology from a template**: keep only the named devices, rebuild links |
| `pkt_build` | **Clone devices + add links** on an existing topology |
| `pkt_open` | Open a file in the local Packet Tracer |

### pkt_read sections

| section | Contents |
|---|---|
| `summary` | Overview: devices, links, canvas notes (default) |
| `topology` | Device and link inventory |
| `addresses` | IP address table |
| `issues` | Detected configuration faults |
| `routing` | Routing protocol and `network` statements per device |
| `configs` | running-config text (optionally narrowed by `device`) |
| `activity` | Instructor activity script and instructions |
| `fixplan` | Repair plan + copy-pasteable CLI commands (read-only, does not touch the file) |
| `xml` | Raw decrypted XML |

---

## 2. What it detects and repairs automatically

| Category | Rule | Automatic fix |
|---|---|---|
| **Cable type** | MDI/MDI-X: Router↔PC needs a crossover; Router↔Switch and Switch↔PC need straight-through | rewrite `CABLE/TYPE` |
| **Interface shut down** | A cabled interface is `shutdown` | `no shutdown`, plus an IP taken from the canvas notes |
| **Wrong gateway** | Set to the device's own address / absent from the topology / outside the subnet | change to the router interface address on that subnet |
| **Address conflict** | The same IP on several devices | move every holder after the first to a free address |
| **Routing protocol mismatch** | Directly connected routers run different protocols | unify on the more fully configured side (ties go to OSPF) and emit correct `network` syntax |
| **Missing route statement** | `router x` with no `network` | rewritten together with the item above |
| **Mask mismatch** | Endpoint mask differs from the router interface on the same subnet | reported only, not auto-fixed |

---

## 3. Building topologies automatically

There are two ways, both resting on the same constraint: **Packet Tracer device nodes
cannot be synthesised from scratch.** A device block carries a module tree, a port table,
file-manager state and a pile of opaque memory addresses; a hand-assembled node is not
accepted by PT. So you either clone an existing device or take a subset of a template.

### 3.1 `pkt_new` — build from a template (recommended)

Keep only the named devices from the template, drop everything else (other devices, all
links, canvas notes), then rebuild the links you ask for. Good for "I want a clean new lab".

```jsonc
{
  "template": "some-existing.pkt",
  "out": "new-topology.pkt",
  "keep": ["R1", "Switch0"],
  "links": [
    { "from": "R1", "fromPort": "GigabitEthernet0/0",
      "to": "Switch0", "toPort": "FastEthernet0/1",
      "cable": "eStraightThrough" }
  ]
}
```

### 3.2 `pkt_build` — append to an existing topology

Clone existing devices as new nodes, then wire them up.

```jsonc
{
  "path": "lab.pkt",
  "devices": [
    { "name": "PC3", "like": "PC1", "ip": "172.16.1.50",
      "mask": "255.255.255.0", "gateway": "172.16.1.1" }
  ],
  "links": [
    { "from": "PC3", "fromPort": "FastEthernet0",
      "to": "Switch0", "toPort": "FastEthernet0/3",
      "cable": "eStraightThrough" }
  ]
}
```

**Shared limitation**: both methods can only use device types already present in the
template. To add a 2911 router, the source file must already contain a 2911 to clone.

---

## 4. File format

`.pkt/.pka/.pta` from Packet Tracer 6.x onward is a four-stage envelope:

| Stage | Operation | Notes |
|---|---|---|
| 1 | position-dependent XOR + byte reversal | `out[i] = data[n-1-i] ^ ((n - i*n) & 0xFF)` |
| 2 | Twofish-EAX decryption | key = `0x89`×16, nonce = `0x10`×16; CMAC auth + CTR |
| 3 | position-dependent XOR | `buf[i] ^= (len - i) & 0xFF` |
| 4 | zlib decompression | first 4 bytes = big-endian original length |

**Stage 2 is EAX, not CBC.** CTR is a stream mode, so the ciphertext length need not be a
multiple of 16; EAX's authentication tag verifies integrity at the same time.

Writes are **text-level surgical replacements only** — the XML is never re-serialised, so
every structural detail PT relies on is preserved exactly as it was.

### ⚠️ The first 4 bytes are a BYTE count, not a character count

The length prefix must be the **UTF-8 byte count**. If you use a JS string's `.length`
(UTF-16 code units) instead, then any document containing non-ASCII text (Chinese canvas
notes, device descriptions, ...) gets a prefix that is short by
`2 × (number of non-ASCII characters)` bytes — and **PT reads only the number of bytes the
prefix declares, so it silently truncates the tail of the document**, which shows up as some
elements of the last device going missing (the interface IP survives, `DNS_SERVER` does not).

Therefore `encryptPkt()` normalises either a string or a Buffer to a Buffer before writing
the prefix, and `decryptPkt()` additionally returns a `sizeMismatch` flag that `pkt_fix`,
`pkt_build` and `pkt_new` assert is `false` after writing.

---

## 5. Command line (no install required)

```bash
node bin/pkt.mjs <file.pkt> <section> [--device NAME] [--out FILE]

# read
node bin/pkt.mjs lab.pkt summary
node bin/pkt.mjs lab.pkt issues
node bin/pkt.mjs lab.pkt configs --device R1
node bin/pkt.mjs lab.pkt xml --out lab.xml

# repair
node bin/pkt.mjs lab.pkt fix --out lab-fixed.pkt

# build
node bin/pkt.mjs lab.pkt build --spec spec.json --out lab-built.pkt

# build from a template (keep + links live in the spec)
node bin/pkt.mjs template.pkt new --spec spec.json --out lab-new.pkt
```

---

## 6. Installation

### 6.1 From GitHub (recommended)

```bash
git clone https://github.com/heqinjian/dsh-plugin-pkt.git
cd dsh-plugin-pkt
powershell -ExecutionPolicy Bypass -File install.ps1
```

The script copies the package into `<profile>\node_modules\dsh-plugin-pkt` and appends the
loader entry to `cordis.patch.yml` (backing that file up first).

Target a different profile:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"
```

### 6.2 Via the DSH plugin manager

```bash
plugin_manager install_bundle target="github:heqinjian/dsh-plugin-pkt"
```

### 6.3 Command line only

No plugin needed: clone the repo and run `node bin/pkt.mjs` (see section 5). Requires
Node.js ≥ 18.

### 6.4 Updating an installed plugin

The plugin is pure JavaScript with **no third-party dependencies and no build step**, so
"updating" comes down to two things: **replace the files under
`<profile>\node_modules\dsh-plugin-pkt`** and **restart DSH**.

First check which version is currently installed:

```powershell
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-pkt\package.json" |
  ConvertFrom-Json).version
```

#### A. Installed with git clone + install.ps1 (recommended)

```bash
cd dsh-plugin-pkt
git pull
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` is safe to re-run for updates:

- it `Remove-Item -Recurse -Force`s the destination directory before copying, so **no stale
  files are left behind**;
- it skips the loader entry when `id: pkt-reader` is already present, so it **will not
  insert a duplicate entry** (a duplicate causes `tool "pkt_read" is already registered`).

#### B. Installed via plugin_manager

```bash
plugin_manager remove_bundle target="dsh-plugin-pkt"
plugin_manager install_bundle target="github:heqinjian/dsh-plugin-pkt"
```

⚠️ If you run `install_bundle` immediately after `remove_bundle`, the new loader entry can
get stuck in `failed` (see "Restarting DSH is mandatory" below). The safe order is:
**remove → restart DSH → install → restart DSH**.

#### C. Command line only

```bash
git pull
```

`bin/pkt.mjs` does not depend on a profile, so updating the clone is enough.

#### Verifying the update

1. **You must restart DSH** — the loader does not hot-reload plugins, so without a restart
   the old code keeps running;
2. after restarting, confirm all five tools are present: `pkt_read`, `pkt_fix`, `pkt_new`,
   `pkt_build`, `pkt_open`;
3. run the self-tests:

```bash
node test/selftest.mjs        # crypto core + container round-trip
node test/plugin.test.mjs     # tool registration
```

**Run the self-tests from the git clone, not from the profile directory** — `install.ps1`
only copies `src`, `bin`, `package.json`, `cordis.patch.yml`, `README.md`, `README.en.md`
and `LICENSE`; it does **not** copy `test/` or `examples/`, so running them from the profile
fails with file-not-found.

#### Updated but behaviour did not change?

Check in this order:

1. **DSH was not restarted** — by far the most common cause;
2. **more than one copy** — installed by hand once and again via the plugin manager. Check:
   ```powershell
   Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules" -Filter "*pkt*" -Directory
   ```
   there should be exactly one `dsh-plugin-pkt`;
3. **the version did not change** — verify with the `package.json` command above; do not
   rely on `git log`.

### ⚠️ Restarting DSH is mandatory

The DSH loader leaves plugin entries added **at runtime** permanently in
`fiberPhase: failed`, regardless of the code — the same code placed in an entry that
existed when the host started works fine. Therefore:

1. after installing, **restart DSH** so the five tools appear;
2. restart again after updating the code;
3. if an entry is stuck in `failed`, insert it again under a different `id` (the same name
   is never retried).

### Installation troubleshooting

**"Plugin not found"**

The package really is not in the profile. Check:

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-pkt"
```

`False` means it was not installed — after removing a plugin the UI may still show the old
row, so just reinstall.

**Installing reports `tool "pkt_read" is already registered`**

Another copy is registering the same tool names. This usually happens when one copy was
installed by hand and another via the plugin manager. Look for leftovers:

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules" -Filter "*pkt*" -Directory
```

Delete the extra copy (together with its `- insert:` entry in `cordis.patch.yml`) and
reinstall.

**The entry stays `failed`**

An entry with the same `id` is never retried. Remove the plugin, restart DSH and install
again to get a fresh entry.

Recommended clean sequence:

```
remove plugin → restart DSH → install → restart DSH (if it does not activate on its own)
```

---

## 7. Layout

```
dsh-plugin-pkt/
├── bin/pkt.mjs            CLI entry point
├── src/
│   ├── index.js           plugin entry (registers the 5 tools)
│   ├── twofish-eax.js     Twofish + EAX + container codec
│   ├── xml.js             dependency-free XML parser
│   ├── model.js           modelling, fault detection, report rendering
│   ├── plan.js            faults → edit operations
│   ├── edit.js            surgical XML rewriting
│   └── build.js           device cloning, link adding, template subsetting
├── test/
│   ├── selftest.mjs       crypto core self-test (no sample file needed)
│   └── plugin.test.mjs    tool-registration smoke test
├── examples/
│   ├── 01-new-topology.mjs   build a topology from a template
│   ├── 02-two-lan-lab.mjs    two switches, two PCs
│   └── 03-fix-faults.mjs     batch fault repair
├── install.ps1
└── package.json
```

### Self-tests

```bash
node test/selftest.mjs                    # Twofish KAT + container round-trip
node test/plugin.test.mjs                 # tool registration
node test/plugin.test.mjs your-file.pkt   # run pkt_read once more
```

---

## 8. Limitations

- 128-bit Twofish only (the only variant PT uses); the older two-stage 5.x format is not
  implemented.
- It cannot replace clicking in PT: PT has no public automation API. The plugin achieves
  configuration by **rewriting the .pkt file**; the effect is equivalent to configuring by
  hand, but PT must reopen the file for the change to be visible.
- `pkt_new` / `pkt_build` can only reuse device types already present in the template; they
  cannot conjure a model the file does not contain.
- Routing protocol unification is heuristic (it picks the more fully configured side);
  complex cases need human judgement.
- Cloned devices keep the template's MAC addresses, so duplicate MACs can appear within one
  file; strict setups should change them by hand.
- STP takes about 15 seconds to converge after PT opens a file; the switch end showing amber
  until then is normal.

## 9. License

MIT. See [LICENSE](./LICENSE).

This project contains no Cisco code or resources; Packet Tracer is a trademark of Cisco.
The file-format implementation is based on publicly available reverse-engineering material.
