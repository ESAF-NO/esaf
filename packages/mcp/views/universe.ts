/**
 * «ES-universet» som MCP App: kullene ligger på en spiral (tiden går utover),
 * selskapene mellom gründerne sine, og tidslinjen spiller historien. Dataene
 * kommer fra verktøyet `show_universe` (`structuredContent`), eller fra
 * `window.__ESAF_UNIVERSE__` når siden åpnes alene. Bygges til én HTML-fil med
 * `pnpm --filter @esaf/mcp build:views`.
 */
import { App } from '@modelcontextprotocol/ext-apps'
import type { Universe } from '@esaf/core'

type Data = Universe & { appUrl?: string }

type P = {
  kind: 'p'
  id: string
  name: string
  cohort: number | null
  appear: number
  links: L[]
  x: number
  y: number
  vx: number
  vy: number
  a: number
}
type C = {
  kind: 'c'
  id: string
  slug: string
  name: string
  tagline: string | null
  status: string
  founded: number | null
  closed: number | null
  acquired: number | null
  endUncertain: boolean
  milestones: { year: number; type: string; text: string; uncertain: boolean }[]
  appear: number
  links: L[]
  parent: C | null
  spinoffs: C[]
  x: number
  y: number
  vx: number
  vy: number
  a: number
}
type L = { p: P; c: C; role: 'founder' | 'es' | 'employee'; from: number; to: number | null }
type N = P | C

declare global {
  interface Window {
    __ESAF_UNIVERSE__?: Data
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const fmt = (n: number) => n.toLocaleString('nb-NO')
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  )

let app: App | null = null
let appUrl = ''

function openApp(path: string) {
  if (!appUrl) return
  const url = appUrl + path
  if (app) void app.openLink({ url })
  else window.open(url, '_blank', 'noopener')
}

function start(data: Data) {
  appUrl = (data.appUrl ?? '').replace(/\/$/, '')
  const FIRST = data.firstYear
  const LAST = data.lastYear
  const SPAN = Math.max(1, LAST - FIRST)

  // ------------------------------------------------------------- modellen
  const people: P[] = data.people.map((p) => ({
    kind: 'p',
    id: p.id,
    name: p.name,
    cohort: p.cohort,
    appear: p.cohort ? p.cohort - 2 : FIRST,
    links: [],
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    a: 0,
  }))
  const peopleById = new Map(people.map((p) => [p.id, p]))
  const allCompanies: C[] = data.companies.map((c) => ({
    kind: 'c',
    ...c,
    appear: Math.max(FIRST, c.founded ?? FIRST),
    links: [],
    parent: null,
    spinoffs: [],
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    a: 0,
  }))
  const companyById = new Map(allCompanies.map((c) => [c.id, c]))
  const links: L[] = []
  for (const l of data.links) {
    const p = peopleById.get(l.personId)
    const c = companyById.get(l.companyId)
    if (!p || !c) continue
    const link: L = { p, c, role: l.role, from: l.from ?? c.appear, to: l.to }
    links.push(link)
    p.links.push(link)
    c.links.push(link)
  }
  // Uten grunnlagt-år: fra den første som var med, ellers kullet til ES-teamet.
  for (const c of allCompanies) {
    if (c.founded !== null) continue
    const starts = c.links.map((l) => l.from).filter((y) => y > FIRST)
    if (starts.length) c.appear = Math.min(...starts)
  }
  // Spinoffs: noen som startet selskapet, hadde startet eller vært ES-team i et annet før.
  for (const c of allCompanies) {
    for (const l of c.links) {
      if (l.role !== 'founder') continue
      const before = l.p.links
        .filter(
          (o) => o.c !== c && (o.role === 'founder' || o.role === 'es') && o.c.appear < c.appear,
        )
        .sort((a, b) => b.c.appear - a.c.appear)[0]
      if (before) {
        c.parent = before.c
        before.c.spinoffs.push(c)
        break
      }
    }
  }
  // Selskaper noen fra ES har startet eller hatt som ES-selskap, og arbeidsgivere med flere fra ES.
  const core = (c: C) => c.links.some((l) => l.role !== 'employee') || c.links.length >= 2
  let showAll = false
  let companies = allCompanies.filter(core)
  let nodes: N[] = [...people, ...companies]

  // ------------------------------------------------------------- oppsett
  const anchor = (year: number | null) => {
    if (year === null) return { x: 0, y: 0 }
    const t = Math.min(1, Math.max(0, (year - FIRST) / SPAN))
    const ang = ((-115 + t * 315) * Math.PI) / 180
    const r = 190 + t * 300
    return { x: Math.cos(ang) * r, y: Math.sin(ang) * r }
  }
  const statusAt = (c: C, Y: number) => {
    if (c.closed !== null && Y >= c.closed) return 'closed'
    if (c.acquired !== null && Y >= c.acquired) return 'acquired'
    if (Y >= LAST && (c.status === 'closed' || c.status === 'acquired')) return c.status
    return c.status === 'unknown' ? 'unknown' : 'active'
  }
  const weight = (c: C, Y: number) =>
    c.links.filter((l) => l.from <= Y).length + c.milestones.filter((m) => m.year <= Y).length * 1.5
  const radius = (n: N, Y: number) =>
    n.kind === 'p' ? 2.2 : Math.min(18, 3.5 + Math.sqrt(weight(n, Y)) * 2.4)

  const canvas = $<HTMLCanvasElement>('c')
  const ctx = canvas.getContext('2d')!
  const stage = $('stage')
  let W = 0
  let H = 0
  let dpr = 1
  const cam = { x: 0, y: 0, k: 1, fitted: false }
  let camTarget: { x: number; y: number; k: number } | null = null
  function resize() {
    dpr = window.devicePixelRatio || 1
    W = stage.clientWidth
    H = stage.clientHeight
    canvas.width = W * dpr
    canvas.height = H * dpr
    if (!cam.fitted) {
      cam.k = Math.min(W, H) / 1250
      cam.x = W > 560 ? -40 : 0
      cam.y = 30
      cam.fitted = true
    }
  }
  window.addEventListener('resize', resize)
  resize()

  let Y = LAST
  const visible = (n: N) => Y >= n.appear
  const linkOn = (l: L) => visible(l.p) && visible(l.c) && Y >= l.from && (showAll || core(l.c))
  const placed = new Set<N>()
  let seed = 7
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  function place(n: N) {
    if (n.kind === 'p') {
      const a = anchor(n.cohort)
      n.x = a.x + (rnd() - 0.5) * 30
      n.y = a.y + (rnd() - 0.5) * 30
    } else {
      const team = n.links.filter((l) => visible(l.p)).map((l) => l.p)
      const base = team.length ? team : [anchor(n.appear)]
      n.x = base.reduce((s, p) => s + p.x, 0) / base.length + (rnd() - 0.5) * 20
      n.y = base.reduce((s, p) => s + p.y, 0) / base.length + (rnd() - 0.5) * 20
    }
    n.vx = n.vy = 0
    placed.add(n)
  }

  function tick() {
    const vis = nodes.filter(visible)
    for (const n of vis) if (!placed.has(n)) place(n)
    for (const n of vis) {
      if (n.kind !== 'p') continue
      const a = anchor(n.cohort)
      n.vx += (a.x - n.x) * 0.004
      n.vy += (a.y - n.y) * 0.004
    }
    for (const l of links) {
      if (!linkOn(l)) continue
      const strong = l.role !== 'employee'
      const len = strong ? 16 : 34
      const k = strong ? 0.03 : 0.006
      const dx = l.c.x - l.p.x
      const dy = l.c.y - l.p.y
      const d = Math.hypot(dx, dy) || 1
      const f = ((d - len) * k) / d
      l.c.vx -= dx * f * 0.7
      l.c.vy -= dy * f * 0.7
      l.p.vx += dx * f * 0.3
      l.p.vy += dy * f * 0.3
    }
    const cell = 28
    const grid = new Map<string, N[]>()
    for (const n of vis) {
      const key = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`
      const list = grid.get(key)
      if (list) list.push(n)
      else grid.set(key, [n])
    }
    for (const n of vis) {
      const gx = Math.floor(n.x / cell)
      const gy = Math.floor(n.y / cell)
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const list = grid.get(`${gx + i},${gy + j}`)
          if (!list) continue
          for (const m of list) {
            if (m === n) continue
            const dx = n.x - m.x
            const dy = n.y - m.y
            const d2 = dx * dx + dy * dy || 0.01
            if (d2 >= cell * cell) continue
            const d = Math.sqrt(d2)
            const min = radius(n, Y) + radius(m, Y) + 3
            const f = ((d < min ? 0.5 : 0.06) * (cell - d)) / cell / d
            n.vx += dx * f
            n.vy += dy * f
          }
        }
      }
    }
    for (const n of vis) {
      n.vx *= 0.82
      n.vy *= 0.82
      n.x += n.vx
      n.y += n.vy
      n.a = Math.min(1, n.a + 0.06)
    }
    for (const n of nodes) {
      if (!visible(n)) {
        n.a = 0
        placed.delete(n)
      }
    }
  }

  // ------------------------------------------------------------- utvalg
  let selected: N | null = null
  let hovered: N | null = null
  let focusCohort: number | null = null
  let lit: Set<N> | null = null
  const cohortPeople = (year: number) => people.filter((p) => p.cohort === year)
  function computeLit() {
    if (!selected && focusCohort === null) {
      lit = null
      return
    }
    const set = new Set<N>()
    lit = set
    if (focusCohort !== null) {
      for (const p of cohortPeople(focusCohort)) {
        set.add(p)
        for (const l of p.links) if (l.role !== 'employee') set.add(l.c)
      }
      return
    }
    const s = selected!
    set.add(s)
    if (s.kind === 'c') {
      const walk = (c: C, depth: number) => {
        set.add(c)
        for (const l of c.links) set.add(l.p)
        if (depth < 3) for (const o of c.spinoffs) walk(o, depth + 1)
      }
      walk(s, 0)
      if (s.parent) set.add(s.parent)
    } else {
      for (const l of s.links) {
        set.add(l.c)
        for (const m of l.c.links) if (m.role !== 'employee') set.add(m.p)
      }
    }
  }
  const litOn = (n: N) => !lit || lit.has(n)

  // ------------------------------------------------------------- tegning
  const pulses: { c: C; rgb: string; t0: number }[] = []
  const cohortColor = (year: number | null, alpha: number) => {
    if (year === null) return `rgba(139,135,128,${alpha})`
    const t = (year - FIRST) / SPAN
    return `hsla(${200 - t * 170},${30 + t * 30}%,${62 + t * 6}%,${alpha})`
  }
  const statusColor: Record<string, string> = {
    active: '240,112,60',
    acquired: '233,196,106',
    closed: '74,72,69',
    unknown: '150,120,104',
  }
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
  const label = `${11}px ui-sans-serif, system-ui, sans-serif`

  function draw(time: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.save()
    ctx.translate(W / 2 + cam.x, H / 2 + cam.y)
    ctx.scale(cam.k, cam.k)

    ctx.beginPath()
    for (let y = FIRST; y <= Math.min(LAST, Y + 2); y += 0.1) {
      const a = anchor(y)
      if (y === FIRST) ctx.moveTo(a.x, a.y)
      else ctx.lineTo(a.x, a.y)
    }
    ctx.strokeStyle = 'rgba(233,230,223,0.05)'
    ctx.lineWidth = 1 / cam.k
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const years = [...new Set(people.map((p) => p.cohort).filter((y): y is number => y !== null))]
    for (const y of years) {
      if (Y < y - 2) continue
      const a = anchor(y)
      const out = Math.hypot(a.x, a.y) || 1
      const on = focusCohort === y
      if (!on && cam.k < 0.7 && (y - FIRST) % 2) continue
      ctx.font = `${(on ? 13 : 10.5) / cam.k}px ui-sans-serif, system-ui, sans-serif`
      ctx.fillStyle = on
        ? 'rgba(233,230,223,0.95)'
        : lit
          ? 'rgba(139,135,128,0.25)'
          : 'rgba(139,135,128,0.7)'
      ctx.fillText(`ES ${y}`, a.x + (a.x / out) * 58, a.y + (a.y / out) * 58)
    }

    for (const l of links) {
      if (!linkOn(l)) continue
      const on = !!lit && lit.has(l.p) && lit.has(l.c)
      const strong = l.role !== 'employee'
      const alpha = Math.min(l.p.a, l.c.a) * (on ? 0.7 : lit ? 0.025 : strong ? 0.16 : 0.05)
      ctx.strokeStyle = on && strong ? `rgba(240,140,90,${alpha})` : `rgba(233,230,223,${alpha})`
      ctx.lineWidth = (on ? 1.2 : 0.7) / cam.k
      ctx.beginPath()
      ctx.moveTo(l.p.x, l.p.y)
      ctx.lineTo(l.c.x, l.c.y)
      ctx.stroke()
    }
    for (const c of companies) {
      if (!c.parent || !visible(c) || !visible(c.parent) || !companies.includes(c.parent)) continue
      const on = !!lit && lit.has(c) && lit.has(c.parent)
      if (lit && !on) continue
      ctx.setLineDash([3 / cam.k, 4 / cam.k])
      ctx.strokeStyle = `rgba(233,196,106,${on ? 0.7 : 0.12})`
      ctx.lineWidth = 1 / cam.k
      ctx.beginPath()
      ctx.moveTo(c.parent.x, c.parent.y)
      const mx = (c.parent.x + c.x) / 2 - (c.y - c.parent.y) * 0.2
      const my = (c.parent.y + c.y) / 2 + (c.x - c.parent.x) * 0.2
      ctx.quadraticCurveTo(mx, my, c.x, c.y)
      ctx.stroke()
      ctx.setLineDash([])
    }
    for (const p of people) {
      if (!visible(p)) continue
      const r = radius(p, Y) * (p === hovered ? 1.8 : 1) * (0.4 + 0.6 * easeOut(p.a))
      ctx.fillStyle = cohortColor(p.cohort, p.a * (litOn(p) ? 0.9 : 0.1))
      ctx.beginPath()
      ctx.arc(p.x, p.y, r / Math.sqrt(cam.k), 0, Math.PI * 2)
      ctx.fill()
    }
    for (const c of companies) {
      if (!visible(c)) continue
      const st = statusAt(c, Y)
      const on = litOn(c)
      const r = radius(c, Y) * (0.3 + 0.7 * easeOut(c.a))
      const rgb = statusColor[st]!
      if (st === 'active' && on && weight(c, Y) >= 3) {
        const g = ctx.createRadialGradient(c.x, c.y, r * 0.6, c.x, c.y, r * 2.6)
        g.addColorStop(0, `rgba(${rgb},${0.2 * c.a})`)
        g.addColorStop(1, `rgba(${rgb},0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(c.x, c.y, r * 2.6, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = `rgba(${rgb},${c.a * (on ? 1 : 0.12)})`
      ctx.beginPath()
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2)
      ctx.fill()
      if (c === selected || c === hovered) {
        ctx.strokeStyle = 'rgba(233,230,223,0.9)'
        ctx.lineWidth = 1.5 / cam.k
        ctx.beginPath()
        ctx.arc(c.x, c.y, r + 3 / cam.k, 0, Math.PI * 2)
        ctx.stroke()
      }
      const show = c === selected || c === hovered || (lit ? lit.has(c) : r * cam.k > 10)
      if (show && c.a > 0.5) {
        ctx.font = `${11 / cam.k}px ui-sans-serif, system-ui, sans-serif`
        ctx.fillStyle = `rgba(233,230,223,${on ? 0.85 : 0.2})`
        ctx.fillText(c.name, c.x, c.y + r + 9 / cam.k)
      }
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pu = pulses[i]!
      const t = (time - pu.t0) / 1400
      if (t > 1) {
        pulses.splice(i, 1)
        continue
      }
      ctx.strokeStyle = `rgba(${pu.rgb},${(1 - t) * 0.9})`
      ctx.lineWidth = 2 / cam.k
      ctx.beginPath()
      ctx.arc(pu.c.x, pu.c.y, radius(pu.c, Y) + t * 40, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
    void label
  }

  // ------------------------------------------------------------- UI
  const yearInput = $<HTMLInputElement>('year')
  yearInput.min = String(FIRST)
  yearInput.max = String(LAST)
  yearInput.value = String(LAST)
  const panel = $('panel')
  const tip = $('tip')
  const bars = $('bars')
  const perYear: number[] = []
  for (let y = FIRST; y <= LAST; y++)
    perYear.push(allCompanies.filter((c) => core(c) && c.appear === y).length)
  const maxBar = Math.max(1, ...perYear)
  bars.innerHTML = perYear
    .map((n) => `<span style="height:${(n / maxBar) * 100}%"></span>`)
    .join('')

  function stats() {
    const Yi = Math.floor(Y)
    $('s-people').textContent = fmt(people.filter((p) => (p.cohort ?? FIRST) <= Yi).length)
    const vis = companies.filter(visible)
    $('s-active').textContent = fmt(vis.filter((c) => statusAt(c, Y) === 'active').length)
    $('s-acq').textContent = fmt(vis.filter((c) => statusAt(c, Y) === 'acquired').length)
    $('s-rounds').textContent = fmt(
      vis.reduce(
        (s, c) => s + c.milestones.filter((m) => m.type === 'funding' && m.year <= Yi).length,
        0,
      ),
    )
    ;[...bars.children].forEach((b, i) => b.classList.toggle('on', FIRST + i <= Yi))
    $('year-label').textContent = String(Yi)
  }

  const statusText: Record<string, string> = {
    active: 'Aktiv',
    acquired: 'Oppkjøpt',
    closed: 'Nedlagt',
    unknown: 'Ukjent status',
  }
  const milestoneText: Record<string, string> = {
    funding: 'Kapital',
    award: 'Pris',
    launch: 'Lansering',
  }
  const roleText = { founder: 'gründer', es: 'ES-team', employee: 'jobbet der' }
  const nodeLink = (n: N) => `<a data-id="${n.kind}:${esc(n.id)}">${esc(n.name)}</a>`
  const openLink = (path: string, text: string) =>
    appUrl ? `<p class="open"><a data-open="${esc(path)}">${text} ↗</a></p>` : ''
  const legend = `<div class="legend">
      <div><i style="background:#f0703c"></i>Aktivt selskap (størrelse: folk fra ES og milepæler)</div>
      <div><i style="background:#e9c46a"></i>Oppkjøpt</div>
      <div><i style="background:#4a4845"></i>Nedlagt</div>
      <div><i style="background:#967868"></i>Ukjent status</div>
      <div><i style="background:linear-gradient(90deg,hsl(200,30%,62%),hsl(30,60%,68%))"></i>Personer, farget etter kull</div>
      <div class="note">Stiplet gull: spinoff. Noen fra ett selskap startet et nytt.</div>
    </div>`

  function renderPanel() {
    const Yi = Math.floor(Y)
    if (focusCohort !== null && !selected) {
      const list = cohortPeople(focusCohort)
      const made = allCompanies.filter(
        (c) =>
          c.links.some((l) => l.role !== 'employee' && l.p.cohort === focusCohort) && visible(c),
      )
      panel.innerHTML = `<h2>ES ${focusCohort}</h2>
        <div class="meta">${focusCohort - 2}–${focusCohort} · ${list.length} personer</div>
        <h3>Selskaper de har startet eller hatt på ES (${made.length})</h3>
        <ul>${made
          .sort((a, b) => weight(b, Y) - weight(a, Y))
          .slice(0, 14)
          .map(
            (c) => `<li><span>${nodeLink(c)}</span><span>${statusText[statusAt(c, Y)]}</span></li>`,
          )
          .join('')}</ul>
        ${openLink(`/kull/${focusCohort}`, 'Åpne kullsiden')}`
    } else if (selected?.kind === 'c') {
      const c = selected
      const team = c.links.filter((l) => l.role !== 'employee')
      const staff = c.links.filter((l) => l.role === 'employee' && l.from <= Yi)
      const ms = c.milestones.filter((m) => m.year <= Yi)
      panel.innerHTML = `<h2>${esc(c.name)}</h2>
        <div class="meta">${c.founded ?? 'Ukjent år'} · ${statusText[statusAt(c, Y)]}${
          statusAt(c, Y) === 'acquired' && c.acquired ? ` ${c.acquired}` : ''
        }${statusAt(c, Y) === 'closed' && c.closed ? ` ${c.closed}` : ''}${
          c.endUncertain && (statusAt(c, Y) === 'closed' || statusAt(c, Y) === 'acquired')
            ? ' (usikker)'
            : ''
        }</div>
        ${c.tagline ? `<p>${esc(c.tagline)}</p>` : ''}
        ${team.length ? `<h3>Gründere og ES-team</h3><ul>${team.map((l) => `<li><span>${nodeLink(l.p)}</span><span>${l.p.cohort ? `ES ${l.p.cohort}` : ''}</span></li>`).join('')}</ul>` : ''}
        ${staff.length ? `<h3>Fra ES som har jobbet der (${staff.length})</h3><ul>${staff.map((l) => `<li><span>${nodeLink(l.p)}</span><span>${l.from}</span></li>`).join('')}</ul>` : ''}
        ${ms.length ? `<h3>Milepæler</h3><ul class="ms">${ms.map((m) => `<li><span>${esc(m.text)}${m.uncertain ? ' <em>(usikker)</em>' : ''}</span><span>${milestoneText[m.type] ?? ''} ${m.year}</span></li>`).join('')}</ul>` : ''}
        ${c.parent ? `<h3>Kom fra</h3><ul><li><span>${nodeLink(c.parent)}</span><span>${c.parent.appear}</span></li></ul>` : ''}
        ${c.spinoffs.length ? `<h3>Spinoffs</h3><ul>${c.spinoffs.map((o) => `<li><span>${nodeLink(o)}</span><span>${o.appear}</span></li>`).join('')}</ul>` : ''}
        ${openLink(`/selskaper/${c.slug}`, 'Åpne selskapssiden')}`
    } else if (selected?.kind === 'p') {
      const p = selected
      panel.innerHTML = `<h2>${esc(p.name)}</h2>
        <div class="meta">${p.cohort ? `ES ${p.cohort} (${p.cohort - 2}–${p.cohort})` : 'Uten kull'}</div>
        <h3>Selskaper</h3>
        <ul>${
          p.links.length
            ? p.links
                .map(
                  (l) =>
                    `<li><span>${nodeLink(l.c)}</span><span>${roleText[l.role]}${l.from ? ` ${l.from}` : ''}</span></li>`,
                )
                .join('')
            : '<li><span>Ingen registrert</span></li>'
        }</ul>
        ${openLink(`/medlemmer/${p.id}`, 'Åpne profilen')}`
    } else {
      panel.innerHTML = `<h2>${Yi}</h2><div class="meta">Trykk på et selskap for å se familietreet, eller spill av historien.</div>${legend}`
    }
    for (const a of panel.querySelectorAll<HTMLAnchorElement>('a[data-id]')) {
      a.addEventListener('click', () => {
        const [kind, id] = a.dataset.id!.split(':') as ['p' | 'c', string]
        const n = kind === 'p' ? peopleById.get(id) : companyById.get(id)
        if (n) select(n, true)
      })
    }
    for (const a of panel.querySelectorAll<HTMLAnchorElement>('a[data-open]')) {
      a.addEventListener('click', () => openApp(a.dataset.open!))
    }
  }

  function flyTo(x: number, y: number, k: number) {
    camTarget = { x: -x * k, y: -y * k + 30, k }
  }
  function select(n: N | null, fly: boolean) {
    if (n && n.kind === 'c' && !companies.includes(n)) setShowAll(true)
    selected = n
    focusCohort = null
    computeLit()
    renderPanel()
    if (n && fly) flyTo(n.x, n.y, Math.max(cam.k, 1.7))
  }
  function setShowAll(on: boolean) {
    showAll = on
    companies = on ? allCompanies : allCompanies.filter(core)
    nodes = [...people, ...companies]
    $<HTMLInputElement>('all').checked = on
  }

  let playing = false
  let lastT = 0
  function setYear(v: number, fromPlay: boolean) {
    const prev = Y
    Y = Math.max(FIRST, Math.min(LAST, v))
    if (!fromPlay) yearInput.value = String(Y)
    if (fromPlay && Y > prev) {
      for (const c of companies) {
        if (c.acquired !== null && prev < c.acquired && Y >= c.acquired) {
          pulses.push({ c, rgb: '233,196,106', t0: performance.now() })
        }
        for (const m of c.milestones) {
          if (m.type === 'funding' && prev < m.year && Y >= m.year) {
            pulses.push({ c, rgb: '240,112,60', t0: performance.now() })
          }
        }
      }
    }
    stats()
    if (Math.floor(prev) !== Math.floor(Y)) {
      computeLit()
      renderPanel()
    }
  }
  yearInput.addEventListener('input', () => setYear(+yearInput.value, false))
  const playBtn = $('play')
  const icon = $('play-icon')
  const PLAY = '<path d="M3 1.5v9l7-4.5z" fill="currentColor"/>'
  const PAUSE = '<path d="M3 1.5h2.2v9H3zM6.8 1.5H9v9H6.8z" fill="currentColor"/>'
  playBtn.addEventListener('click', () => {
    playing = !playing
    if (playing && Y >= LAST - 0.01) setYear(FIRST, false)
    icon.innerHTML = playing ? PAUSE : PLAY
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Spill av')
  })
  $<HTMLInputElement>('all').addEventListener('change', (e) =>
    setShowAll((e.target as HTMLInputElement).checked),
  )

  $<HTMLInputElement>('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase()
    if (!q) {
      select(null, false)
      return
    }
    const year = q.match(/(19|20)\d{2}/)
    if (year && people.some((p) => p.cohort === +year[0])) {
      selected = null
      focusCohort = +year[0]
      computeLit()
      renderPanel()
      const a = anchor(focusCohort)
      flyTo(a.x, a.y, 1.9)
      return
    }
    const hit =
      allCompanies.find((c) => c.name.toLowerCase().startsWith(q)) ??
      people.find((p) => p.name.toLowerCase().includes(q)) ??
      allCompanies.find((c) => c.name.toLowerCase().includes(q))
    if (hit) {
      if (!visible(hit)) setYear(LAST, false)
      select(hit, true)
    }
  })

  const toWorld = (sx: number, sy: number) => ({
    x: (sx - W / 2 - cam.x) / cam.k,
    y: (sy - H / 2 - cam.y) / cam.k,
  })
  function hit(sx: number, sy: number) {
    const w = toWorld(sx, sy)
    let best: N | null = null
    let bd = Infinity
    for (const n of nodes) {
      if (!visible(n)) continue
      const r = Math.max(radius(n, Y), 6 / cam.k)
      const d = Math.hypot(n.x - w.x, n.y - w.y)
      if (d < r && d < bd) {
        best = n
        bd = d
      }
    }
    return best
  }
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.offsetX, y: e.offsetY, cx: cam.x, cy: cam.y, moved: false }
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.offsetX - drag.x
      const dy = e.offsetY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true
        canvas.classList.add('dragging')
        camTarget = null
      }
      if (drag.moved) {
        cam.x = drag.cx + dx
        cam.y = drag.cy + dy
      }
      return
    }
    hovered = hit(e.offsetX, e.offsetY)
    if (hovered) {
      tip.style.opacity = '1'
      tip.style.left = `${Math.min(e.offsetX + 12, W - 200)}px`
      tip.style.top = `${e.offsetY + 12}px`
      tip.innerHTML =
        hovered.kind === 'c'
          ? `${esc(hovered.name)} <span>· ${statusText[statusAt(hovered, Y)]}${hovered.tagline ? ` · ${esc(hovered.tagline.slice(0, 60))}` : ''}</span>`
          : `${esc(hovered.name)} <span>· ${hovered.cohort ? `ES ${hovered.cohort}` : 'uten kull'}</span>`
      canvas.style.cursor = 'pointer'
    } else {
      tip.style.opacity = '0'
      canvas.style.cursor = ''
    }
  })
  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging')
    if (drag && !drag.moved) {
      const n = hit(e.offsetX, e.offsetY)
      if (n) select(n, false)
      else {
        selected = null
        focusCohort = null
        computeLit()
        renderPanel()
      }
    }
    drag = null
  })
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      camTarget = null
      const k = Math.max(0.3, Math.min(5, cam.k * Math.exp(-e.deltaY * 0.0015)))
      const w = toWorld(e.offsetX, e.offsetY)
      cam.x = e.offsetX - W / 2 - w.x * k
      cam.y = e.offsetY - H / 2 - w.y * k
      cam.k = k
    },
    { passive: false },
  )

  // Forvarm oppsettet, så bildet står stille når det vises.
  for (let i = 0; i < 300; i++) tick()
  for (const n of nodes) n.a = 1
  stats()
  renderPanel()
  $('loading').remove()

  function frame(t: number) {
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0)
    lastT = t
    if (playing) {
      setYear(Y + dt * 1.1, true)
      yearInput.value = String(Y)
      if (Y >= LAST) {
        playing = false
        icon.innerHTML = PLAY
      }
    }
    if (camTarget) {
      cam.x += (camTarget.x - cam.x) * 0.1
      cam.y += (camTarget.y - cam.y) * 0.1
      cam.k += (camTarget.k - cam.k) * 0.1
      if (Math.abs(camTarget.k - cam.k) < 0.002 && Math.abs(camTarget.x - cam.x) < 0.5)
        camTarget = null
    }
    tick()
    draw(t)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// Alene (forhåndsvisning): dataene ligger i siden. I en MCP-klient: fra verktøyet.
if (window.__ESAF_UNIVERSE__) {
  start(window.__ESAF_UNIVERSE__)
} else {
  app = new App({ name: 'ES-universet', version: '1.0.0' })
  let started = false
  app.ontoolresult = (result) => {
    const data = result.structuredContent as Data | undefined
    if (data && !started) {
      started = true
      start(data)
    }
  }
  void app.connect()
}
