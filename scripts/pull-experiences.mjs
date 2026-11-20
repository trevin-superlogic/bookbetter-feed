#!/usr/bin/env node
/**
 * Pulls the experiences listing through Jina Reader, follows each experience one level down,
 * and writes a small public-safe JSON file: title, kind, city/date line, image, two bullets.
 *
 * Nothing that should stay private is written out: no prices, no blocklisted names, no source URLs.
 * If a run finds nothing, the previous file is left untouched and the job fails loudly.
 *
 * Env:
 *   SOURCE_URL      required  listing page to read (keep it in a repo secret)
 *   JINA_API_KEY    optional  raises Jina's rate limit
 *   DETAIL_PATTERN  optional  regex a link must match to count as an experience page
 *   BLOCKLIST       optional  comma-separated names to strip (client names, partner names)
 *   MAX_ITEMS       optional  default 9
 *   MAX_POINTS      optional  default 2
 *   OUT             optional  default data/experiences.json
 *   DEBUG_DIR       optional  if set, raw page text is saved there for tuning (contains prices: keep private)
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const SOURCE_URL = process.env.SOURCE_URL
const JINA_BASE = process.env.JINA_BASE || "https://r.jina.ai/"
const DETAIL_PATTERN = new RegExp(process.env.DETAIL_PATTERN || "/experiences?/[^/?#]+/?$", "i")
const BLOCKLIST = (process.env.BLOCKLIST || "").split(",").map((s) => s.trim()).filter(Boolean)
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 9)
const MAX_POINTS = Number(process.env.MAX_POINTS || 2)
const OUT = process.env.OUT || "data/experiences.json"
const DEBUG_DIR = process.env.DEBUG_DIR || ""

const PRICE = /[$€£¥]\s?\d|\d[\d,.]*\s?(usd|eur|gbp|usdc|usdt|btc|eth|cro)\b|\b(price|priced|pricing|per person|pp|from \d|cost|fee|deposit|refund)\b/i
const INCLUDED_HEADING = /(what.?s included|includes?|included|what you get|your experience|the experience|highlights|package)/i
const SKIP_IMAGE = /(logo|icon|avatar|favicon|sprite|badge|flag|placeholder)|\.svg(\?|$)/i
const KINDS = [
    ["Motorsport", /\b(f1|formula|grand prix|paddock|race|racing|motogp|nascar|indycar|pit lane)\b/i],
    ["Music", /\b(concert|artist|tour|festival|studio|song|backstage|soundcheck|dj|band|album)\b/i],
    ["Dining", /\b(chef|dinner|dining|tasting|restaurant|michelin|wine|omakase|table)\b/i],
    ["Sport", /\b(match|game|stadium|league|cup|final|courtside|pitchside|tennis|golf|football|basketball|ufc|fight|boxing)\b/i],
    ["Culture", /\b(museum|gallery|theatre|theater|premiere|fashion|film|art)\b/i],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function read(url, attempt = 1) {
    const headers = { Accept: "application/json", "X-With-Links-Summary": "true", "X-With-Images-Summary": "true" }
    if (process.env.JINA_API_KEY) headers.Authorization = "Bearer " + process.env.JINA_API_KEY
    const res = await fetch(JINA_BASE + url, { headers })
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(attempt * 4000)
        return read(url, attempt + 1)
    }
    if (!res.ok) throw new Error("Reader returned " + res.status + " for a page")
    const body = await res.json()
    return body.data || body
}

/** Jina returns summaries as { label: url }; older responses use arrays. Accept both. */
function pairs(summary) {
    if (!summary) return []
    if (Array.isArray(summary)) return summary.map((x) => (Array.isArray(x) ? x : [x.text || x.alt || "", x.url || x.href || x.src || ""]))
    return Object.entries(summary)
}

export function plain(s) {
    return String(s || "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_`>#]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

export function scrub(s) {
    let out = plain(s)
    for (const name of BLOCKLIST) out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
    out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/^[\s,.;:·|–-]+|[\s,;:·|–-]+$/g, "").trim()
    // a removed name can leave a dangling joiner: "Paddock Club with", "x Paddock Club"
    if (BLOCKLIST.length) out = out.replace(/\s+(with|by|for|at|from|and|x|×|&)$/i, "").replace(/^(with|by|x|×|&)\s+/i, "")
    return out
}

function clip(s, max = 90) {
    if (s.length <= max) return s
    const cut = s.slice(0, max)
    return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s]+$/, "") + "…"
}

/** Two short bullets: the list under a "what's included" style heading, else the first list, else the first sentences. */
export function points(markdown) {
    const lines = String(markdown || "").split(/\r?\n/)
    const isItem = (l) => /^\s*([-*+•]|\d+[.)])\s+\S/.test(l)
    const isHeading = (l) => /^\s{0,3}#{1,6}\s+\S/.test(l) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(l)
    const lists = []
    let current = null
    let lastHeading = ""
    for (const line of lines) {
        if (isHeading(line)) { lastHeading = plain(line); current = null; continue }
        if (isItem(line)) {
            if (!current) { current = { heading: lastHeading, items: [] }; lists.push(current) }
            current.items.push(line.replace(/^\s*([-*+•]|\d+[.)])\s+/, ""))
        } else if (line.trim() && current && current.items.length) current = null
    }
    const usable = (items) => items.map(scrub).filter((t) => t.length > 12 && t.length < 400 && !PRICE.test(t) && !/^(home|log ?in|sign ?up|menu|terms|privacy|contact|share|book now)/i.test(t))
    const preferred = lists.find((l) => INCLUDED_HEADING.test(l.heading) && usable(l.items).length)
    const fallback = lists.map((l) => usable(l.items)).filter((u) => u.length >= 2).sort((a, b) => b.length - a.length)[0]
    let picked = preferred ? usable(preferred.items) : fallback || []
    if (!picked.length) {
        const prose = lines.filter((l) => !isHeading(l) && !isItem(l) && plain(l).length > 60).map(scrub).join(" ")
        picked = (prose.match(/[^.!?]+[.!?]/g) || []).map((s) => s.trim()).filter((s) => s.length > 30 && !PRICE.test(s))
    }
    return [...new Set(picked)].slice(0, MAX_POINTS).map((t) => clip(t))
}

export function meta(markdown) {
    const text = plain(markdown)
    const date = text.match(/\b(?:\d{1,2}\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?,?\s+20\d{2}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+20\d{2}\b/i)
    const place = String(markdown || "").match(/^\s*(?:\*\*)?(?:location|venue|where|city)(?:\*\*)?\s*:\s*(.+)$/im)
    return [place ? scrub(place[1]) : "", date ? date[0] : ""].filter(Boolean).join(" · ")
}

export function kind(text) {
    const hit = KINDS.find(([, re]) => re.test(text))
    return hit ? hit[0] : "Experience"
}

function image(page) {
    const fromSummary = pairs(page.images).map(([, url]) => url).filter((u) => /^https:\/\//.test(u) && !SKIP_IMAGE.test(u))
    const inline = [...String(page.content || "").matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1]).filter((u) => !SKIP_IMAGE.test(u))
    return fromSummary[0] || inline[0] || ""
}

function title(page) {
    const h1 = String(page.content || "").match(/^\s{0,3}#\s+(.+)$/m)
    const raw = (h1 ? h1[1] : page.title || "").split(/\s[|–—-]\s/)[0]
    return scrub(raw)
}

async function main() {
    if (!SOURCE_URL) throw new Error("SOURCE_URL is not set")
    const origin = new URL(SOURCE_URL).origin
    const listing = await read(SOURCE_URL)
    if (DEBUG_DIR) { await mkdir(DEBUG_DIR, { recursive: true }); await writeFile(join(DEBUG_DIR, "listing.md"), String(listing.content || "")) }

    const candidates = [
        ...pairs(listing.links).map(([, url]) => url),
        ...[...String(listing.content || "").matchAll(/\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g)].map((m) => m[1]),
    ]
    const detailUrls = [...new Set(candidates.map((u) => { try { return new URL(u, origin).href.split("#")[0] } catch { return "" } }))]
        .filter((u) => u.startsWith(origin) && DETAIL_PATTERN.test(new URL(u).pathname))
        .slice(0, MAX_ITEMS)
    console.log("Listing read. Experience pages found: " + detailUrls.length)

    const items = []
    for (const [i, url] of detailUrls.entries()) {
        try {
            const page = await read(url)
            if (DEBUG_DIR) await writeFile(join(DEBUG_DIR, "detail-" + (i + 1) + ".md"), String(page.content || ""))
            const t = title(page)
            if (!t || PRICE.test(t)) { console.log("Skipped page " + (i + 1) + ": no usable title"); continue }
            const p = points(page.content)
            items.push({ title: t, kind: kind(t + " " + p.join(" ")), meta: meta(page.content), image: image(page), points: p })
            console.log("Read " + (i + 1) + "/" + detailUrls.length + ": " + t + " (" + p.length + " bullets)")
        } catch (err) {
            console.log("Skipped page " + (i + 1) + ": " + err.message)
        }
        await sleep(1500)
    }

    if (!items.length) throw new Error("No experiences extracted. Previous file left as is. Run with DEBUG_DIR to see what the reader returned, then adjust DETAIL_PATTERN.")
    const out = { asOf: new Date().toISOString().slice(0, 10), count: items.length, items }
    const serialised = JSON.stringify(out, null, 2) + "\n"
    if (PRICE.test(JSON.stringify(items.map((x) => [x.title, x.points])))) throw new Error("A price slipped through the filter. Nothing written.")
    for (const name of BLOCKLIST) if (serialised.toLowerCase().includes(name.toLowerCase()) && !items.some((x) => (x.image || "").toLowerCase().includes(name.toLowerCase()))) throw new Error("A blocklisted name slipped through. Nothing written.")
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, serialised)
    console.log("Wrote " + items.length + " experiences to " + OUT)
}

if (!process.env.FEED_IMPORT_ONLY) {
    main().catch((err) => { console.error(err.message); process.exit(1) })
}
