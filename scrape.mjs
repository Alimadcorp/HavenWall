import fs from 'node:fs/promises'
import vm from 'node:vm'
import path from 'node:path'
import readline from 'node:readline'

const BASE_PROXY_URL = 'https://proxy.alimad.co/api/proxy?url='
const ASSETS_DIR = 'assets'
const CONCURRENCY_LIMIT = 5

const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
}

function prompt(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans.trim()); }))
}

function getBaseLocalPath(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    let cleanPath = decodeURIComponent(parsed.pathname).replace(/^\//, '')
    
    if (!cleanPath || cleanPath.endsWith('/')) {
      cleanPath += 'index'
    }
    
    const domain = parsed.host.replace(/:/g, '_')
    return path.join(ASSETS_DIR, domain, cleanPath)
  } catch {
    return null
  }
}

async function downloadViaProxy(targetUrl, headers) {
  if (!targetUrl || typeof targetUrl !== 'string' || targetUrl.startsWith('data:') || targetUrl.startsWith('blob:')) {
    return targetUrl
  }

  let fetchUrl = targetUrl.startsWith('//') ? `https:${targetUrl}` : targetUrl
  if (!fetchUrl.startsWith('http://') && !fetchUrl.startsWith('https://')) {
    return targetUrl
  }

  if (fetchUrl.startsWith(BASE_PROXY_URL)) {
    fetchUrl = decodeURIComponent(fetchUrl.slice(BASE_PROXY_URL.length))
  }

  const baseLocalPath = getBaseLocalPath(fetchUrl)
  if (!baseLocalPath) return targetUrl

  const dir = path.dirname(baseLocalPath)
  const baseName = path.basename(baseLocalPath)
  try {
    const files = await fs.readdir(dir)
    const existing = files.find(f => path.parse(f).name === baseName)
    if (existing) {
      return path.join(dir, existing).replace(/\\/g, '/')
    }
  } catch {}

  const proxyUrl = `${BASE_PROXY_URL}${encodeURIComponent(fetchUrl)}`
  try {
    const res = await fetch(proxyUrl, { headers, signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    let destPath = baseLocalPath
    if (!path.extname(destPath)) {
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim()
      const ext = MIME_EXTENSIONS[contentType] || '.png'
      destPath += ext
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true })
    const arrayBuffer = await res.arrayBuffer()
    await fs.writeFile(destPath, Buffer.from(arrayBuffer))

    console.log(`[OK] Asset Downloaded: ${fetchUrl} -> ${destPath}`)
    return destPath.replace(/\\/g, '/')
  } catch (err) {
    console.error(`[ERR] Failed downloading asset ${fetchUrl}: ${err.message}`)
    return targetUrl
  }
}

function extractSvelteKitData(html) {
  const match = html.match(/data:\s*(\[\{type:"data"[\s\S]*)/)
  if (!match) throw new Error('Could not locate SvelteKit data block in HTML.')

  const str = match[1]
  let depth = 0, inString = false, quoteChar = '', escape = false, endIndex = -1

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (inString) { if (ch === quoteChar) inString = false; continue }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true
      quoteChar = ch
    } else if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) { endIndex = i; break }
    }
  }

  if (endIndex === -1) throw new Error('Unbalanced brackets in SvelteKit data block.')
  return vm.runInNewContext(`(${str.slice(0, endIndex + 1)})`, Object.create(null))
}

async function fetchPocData(pocUrl, headers) {
  const res = await fetch(pocUrl, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} while fetching data from ${pocUrl}`)

  const html = await res.text()
  const dataNodes = extractSvelteKitData(html)
  const pageData = dataNodes[2]?.data
  const gamesList = pageData?.results
  const roster = pageData?.roster || []

  if (!Array.isArray(gamesList)) throw new Error('Could not find results array in SvelteKit data.')
  
  const checkedInCount = roster.filter(person => person.checkedIn === true).length
  return { gamesList, checkedInCount }
}

async function fetchGameDetailsAndLocalize(baseGame, baseUrl, headers) {
  const url = `${baseUrl}/${baseGame.id}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ID ${baseGame.id}`)

  const html = await res.text()
  const dataNodes = extractSvelteKitData(html)
  const pageData = dataNodes[2]?.data
  
  if (!pageData || !pageData.game) {
    throw new Error(`Missing game payload in SvelteKit data for ID ${baseGame.id}`)
  }

  const { game, voteCount, people } = pageData
  const teamMembers = (people || [])
    .filter(person => person.onTeam === true)
    .map(person => person.name.trim())

  let rawPhotoUrl = game.screenshotUrl ?? null
  let localPhotoPath = null
  if (rawPhotoUrl) {
    localPhotoPath = await downloadViaProxy(rawPhotoUrl, headers)
  }

  return {
    id: baseGame.id,
    gameName: game.name ?? baseGame.name,
    gameDescription: game.description ?? '',
    gameUrl: game.playableUrl ?? baseGame.playableUrl,
    githubUrl: game.codeUrl ?? baseGame.codeUrl,
    gamePhoto: localPhotoPath,
    teamMembers,
    voteCount: voteCount ?? baseGame.votes
  }
}

async function main() {
  let city = (await prompt('Enter your city slug (e.g., lahore): ')).toLowerCase();
  while (!city) {
    city = (await prompt('City slug cannot be empty. Please enter city slug: ')).toLowerCase();
  }

  console.log('\n--- How to retrieve your Cookie ---')
  console.log(`1. Go to https://podium.hackclub.com/haven-${city}/poc`)
  console.log('2. Open browser inspector (F12) -> Network tab')
  console.log('3. Refresh the page, click on the "/poc" network item')
  console.log('4. Look under "Request Headers" and copy the entire string to the right of "Cookie:"\n')

  let cookie = await prompt('Paste your Cookie string here: ')
  while (!cookie) {
    cookie = await prompt('Cookie is required to proceed. Please paste your Cookie: ')
  }

  const POC_URL = `https://podium.hackclub.com/haven-${city}/poc`
  const BASE_URL = `${POC_URL}/games`

  const REQUEST_HEADERS = {
    Cookie: cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml'
  }

  console.log('\nFetching event & games data...')
  let gamesList, checkedInCount
  try {
    ({ gamesList, checkedInCount } = await fetchPocData(POC_URL, REQUEST_HEADERS))
  } catch (err) {
    console.error(`Failed to fetch initial event data: ${err.message}`)
    return
  }

  const results = new Array(gamesList.length)
  const errors = []
  console.log(`Found ${checkedInCount} checked-in attendees. Starting download for ${gamesList.length} games...\n`)

  for (let i = 0; i < gamesList.length; i += CONCURRENCY_LIMIT) {
    const chunk = gamesList.slice(i, i + CONCURRENCY_LIMIT)
    
    await Promise.all(chunk.map(async (item, chunkIdx) => {
      const globalIdx = i + chunkIdx
      try {
        const details = await fetchGameDetailsAndLocalize(item, BASE_URL, REQUEST_HEADERS)
        results[globalIdx] = details
        console.log(`[${globalIdx + 1}/${gamesList.length}] ✔ Processed: ${details.gameName}`)
      } catch (err) {
        console.error(`[${globalIdx + 1}/${gamesList.length}] ✖ Failed ${item.name} (${item.id}): ${err.message}`)
        errors.push({ id: item.id, name: item.name, error: err.message })
      }
    }))
  }

  const finalCleanResults = results.filter(Boolean);
  const output = {
    games: finalCleanResults,
    event: {
      slug: city,
      attendees: checkedInCount,
      shippers: finalCleanResults.reduce((acc, game) => acc + game.teamMembers.length, 0),
      games: finalCleanResults.length
    }
  }

  await fs.writeFile('games.json', JSON.stringify(output, null, 2), 'utf8')
  console.log(`\nSaved ${finalCleanResults.length} games to games.json :P`)

  if (errors.length > 0) {
    await fs.writeFile('errors.json', JSON.stringify(errors, null, 2), 'utf8')
    console.warn(`⚠️ ${errors.length} items failed. Details saved to errors.json`)
  }
}

main()
