# dsh-plugin-pkt — Cisco Packet Tracer 读写与自动化插件

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 Packet Tracer 插件：
读取、诊断、**修复** `.pkt` / `.pka` / `.pta` 文件，**从模板搭建新拓扑**，并直接启动本机
Packet Tracer (Instructor) 打开文件。

纯 JavaScript，**无第三方依赖**：容器格式在本进程内编解码（Twofish-EAX + zlib）。

> 不装插件也能当命令行工具用，见[第 5 节](#5-命令行不装插件也能用)。

---

## 1. 工具一览

| 工具 | 作用 |
|---|---|
| `pkt_read` | 读取文件，按 `section` 返回不同视图 |
| `pkt_fix` | **检测并修复故障**，写出新文件并自动复验 |
| `pkt_new` | **从模板新建拓扑**：只保留指定设备，重建连线 |
| `pkt_build` | 在现有拓扑上**克隆设备 + 加链路** |
| `pkt_open` | 用本机 Packet Tracer 打开文件 |

### pkt_read 的 section

| section | 内容 |
|---|---|
| `summary` | 概览：设备、链路、画布标注（默认） |
| `topology` | 设备与链路清单 |
| `addresses` | IP 地址表 |
| `issues` | 检测到的配置故障 |
| `routing` | 各设备路由协议与 network 声明 |
| `configs` | running-config 文本（可配 `device`） |
| `activity` | Instructor 活动脚本与说明 |
| `fixplan` | 修复方案 + 可照抄的 CLI 命令（只读，不改文件） |
| `xml` | 解密后的原始 XML |

---

## 2. 能检出并自动修复什么

| 类别 | 判据 | 自动修复 |
|---|---|---|
| **线缆类型** | MDI/MDI-X 规则：Router/PC 之间要交叉线；Router↔Switch、Switch↔PC 要直通线 | 改 `CABLE/TYPE` |
| **接口关闭** | 接了链路却 `shutdown` | `no shutdown`，并按画布标注补 IP |
| **网关错误** | 填成本机地址 / 拓扑中不存在 / 不在本网段 | 改为同网段路由器接口地址 |
| **地址冲突** | 同一 IP 在多台设备上 | 把非首个持有者改到空闲地址 |
| **路由协议不一致** | 直连路由器跑不同协议 | 统一为配置更完整的一方（平局取 OSPF），按协议生成正确 network 语法 |
| **路由声明缺失** | `router x` 下无 `network` | 随上一条一并重写 |
| **掩码不一致** | 终端掩码与同网段路由器接口不同 | 仅提示，不自动改 |

验证记录（`故障排查及修复二.pkt` 原始版，人工报告 4 处故障）：

```
修复前: 5 处
  · 线缆 R1 Gi0/1 ↔ R2 Gi0/0: 改为交叉线
  · PC1 默认网关: 172.16.1.254 → 172.16.1.1
  · R2 Gi0/0: 172.16.3.2 → 172.16.3.1（消除地址冲突）
  · R1: 路由改为 ospf，宣告 172.16.1.0 / 172.16.3.0
修复后: 0 处
```

生成的文件已用 Packet Tracer 6.2 Instructor 实际打开验证，无报错。

---

## 3. 自动搭建拓扑

有两种方式，都基于同一个前提：**Packet Tracer 的设备节点无法从零合成**。设备块里
包含模块树、端口表、文件管理器状态和一堆不透明的内存地址，凭空拼一个 PT 不会认。
所以要么克隆已有设备，要么从模板里挑选子集。

### 3.1 `pkt_new` — 从模板新建（推荐）

只保留模板里的指定设备，丢弃其余设备、全部连线和画布标注，再按需重建连线。
适合"我要一个干净的新实验"。

```jsonc
{
  "template": "某份现成.pkt",
  "out": "新拓扑.pkt",
  "keep": ["R1", "Switch0"],
  "links": [
    { "from": "R1", "fromPort": "GigabitEthernet0/0",
      "to": "Switch0", "toPort": "FastEthernet0/1",
      "cable": "eStraightThrough" }
  ]
}
```

实测（模板 6 台设备 → 新文件 2 台 / 1 条链路）：

```
== 设备 ==
  [0] Switch0 (Switch)  —  Switch · SN CAT101008Z4
  [1] R1  —  Router · SN FTX1524C5P2
        GigabitEthernet0/0: 172.16.1.1/255.255.255.0

== 链路 ==
  R1 GigabitEthernet0/0  <-->  Switch0 FastEthernet0/1   [eStraightThrough]
```

用 PT 6.2 Instructor 打开后截图确认：画布上只有 R1(2911) 与 Switch0(2960-24TT)，
连线两端均为绿色（链路 up）。**注意 PT 打开后 STP 收敛约需 15 秒，此前交换机端
显示橙色属正常现象。**

### 3.2 `pkt_build` — 在现有拓扑上追加

克隆已有设备为新节点，再接线。

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

实测：6 台设备 / 5 条链路 → 7 台 / 6 条，PT 正常打开。

**共同限制**：两种方式都只能使用模板里已存在的设备形态。想加一台 2911 路由器，
源文件里必须已经有一台 2911 可克隆。

---

## 4. 文件格式

Packet Tracer 6.x 及以后版本的 `.pkt/.pka/.pta` 是四段式封装：

| 阶段 | 处理 | 说明 |
|---|---|---|
| 1 | 按位置异或 + 字节反转 | `out[i] = data[n-1-i] ^ ((n - i*n) & 0xFF)` |
| 2 | Twofish-EAX 解密 | key = `0x89`×16，nonce = `0x10`×16；CMAC 认证 + CTR |
| 3 | 按位置异或 | `buf[i] ^= (len - i) & 0xFF` |
| 4 | zlib 解压 | 前 4 字节为大端原始长度 |

**第 2 段是 EAX 不是 CBC**。CTR 是流模式，密文长度不必是 16 的倍数；EAX 的认证标签
同时校验完整性。

Twofish 用设计者测试向量校验：全零密钥 + 全零明文 → `9F589F5CF6122C32B6BFEC2F2AE8C35A`，
40 个轮密钥与 `ecb_ival.txt` 一致。

写回时**只做文本级精确替换**，不重新序列化 XML，因此 PT 需要的所有结构细节原样保留。

---

## 5. 命令行（不装插件也能用）

```bash
node bin/pkt.mjs <file.pkt> <section> [--device NAME] [--out FILE]

# 读写
node bin/pkt.mjs lab.pkt summary
node bin/pkt.mjs lab.pkt issues
node bin/pkt.mjs lab.pkt configs --device R1
node bin/pkt.mjs lab.pkt xml --out lab.xml

# 修复
node bin/pkt.mjs lab.pkt fix --out lab-fixed.pkt

# 搭建
node bin/pkt.mjs lab.pkt build --spec spec.json --out lab-built.pkt

# 从模板新建（keep + links 写在 spec 里）
node bin/pkt.mjs template.pkt new --spec spec.json --out lab-new.pkt
```

---

## 6. 安装

### 6.1 从 GitHub 安装（推荐）

```bash
git clone https://github.com/heqinjian/dsh-plugin-pkt.git
cd dsh-plugin-pkt
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本会把包复制到 `<profile>\node_modules\dsh-plugin-pkt`，并在
`cordis.patch.yml` 里追加加载条目（先备份原文件）。

指定其他 profile：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"
```

### 6.2 用 DSH 插件管理器

```bash
plugin_manager install_bundle target="github:heqinjian/dsh-plugin-pkt"
```

### 6.3 只想要命令行

不需要装插件，直接 clone 后运行 `node bin/pkt.mjs`（见上一节）。要求 Node.js ≥ 18。

### ⚠️ 装完必须重启 DSH

DSH loader 在**运行期新增的插件条目一律 `fiberPhase: failed`**，与代码无关——
把同一份代码装进宿主启动时就存在的条目则正常。因此：

1. 装好后**重启 DSH**，五个工具才会出现；
2. 后续更新代码也要重启才生效；
3. 如果条目卡在 `failed`，换个 `id` 重新插入即可（同名不会重试）。

---

## 7. 目录结构

```
dsh-plugin-pkt/
├── bin/pkt.mjs            命令行入口
├── src/
│   ├── index.js           插件入口（注册 5 个工具）
│   ├── twofish-eax.js     Twofish + EAX + 容器编解码
│   ├── xml.js             无依赖 XML 解析
│   ├── model.js           建模、故障检测、报告渲染
│   ├── plan.js            故障 → 编辑操作
│   ├── edit.js            XML 精确改写
│   └── build.js           设备克隆、链路添加、模板子集抽取
├── test/
│   ├── selftest.mjs       加密内核自检（无需样本文件）
│   └── plugin.test.mjs    工具注册冒烟测试
├── examples/
│   ├── 01-new-topology.mjs   从模板新建拓扑
│   ├── 02-two-lan-lab.mjs    双交换机双 PC 实验
│   └── 03-fix-faults.mjs     批量修复故障
├── install.ps1
└── package.json
```

### 自检

```bash
node test/selftest.mjs                        # Twofish KAT + 容器往返
node test/plugin.test.mjs                     # 工具注册
node test/plugin.test.mjs 你的文件.pkt         # 再跑一次 pkt_read
```

---

## 8. 限制

- 仅 128 位 Twofish（PT 只用这一种）；5.x 及更早的两段式格式未实现。
- 不能替代人工在 PT 里点按钮：PT 没有公开自动化 API。本插件通过**改写 .pkt 文件**
  达成配置，效果等价于手工配置，但需要 PT 重新打开文件才可见。
- `pkt_new` / `pkt_build` 只能复用模板里已有的设备形态，不能凭空造出文件里不存在的型号。
- 路由协议统一是启发式的（选配置更完整的一方），复杂场景需人工判断。
- 克隆设备的 MAC 地址沿用模板，同一文件内可能出现重复 MAC；PT 6.2 实测可正常打开，
  但严格场景建议手工改。
- PT 打开文件后 STP 收敛约需 15 秒，此前交换机端显示橙色，属正常现象。

## 9. 许可

MIT。见 [LICENSE](./LICENSE)。

本项目不包含任何 Cisco 的代码或资源；Packet Tracer 是 Cisco 的商标。
文件格式的实现来自公开的逆向工程资料。
