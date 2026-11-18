import fs from 'node:fs/promises'
import vm from 'node:vm'

// This script creates games.json

// Do `npm i` before running

/* GO to `podium.hackclub.com/haven-[CITY]/poc`, open inspector, refresh, click on the `/poc` request,
then copy the exact contents of the `Cookie` inside `Request Headers` down below, then run this script
*/
const COOKIE = ''

const POC_URL = 'https://podium.hackclub.com/haven-lahore/poc'
const BASE_URL = `${POC_URL}/games`
const DELAY_MS = 300

const REQUEST_HEADERS = {
  Cookie: COOKIE,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml'
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function extractSvelteKitData (html) {
  const match = html.match(/data:\s*(\[\{type:"data"[\s\S]*)/)
  if (!match) {
    throw new Error('Could not locate SvelteKit data block in HTML.')
  }

  const str = match[1]
  let depth = 0
  let inString = false
  let quoteChar = ''
  let escape = false
  let endIndex = -1

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]

    if (escape) {
      escape = false
      continue
    }

    if (ch === '\\') {
      escape = true
      continue
    }

    if (inString) {
      if (ch === quoteChar) {
        inString = false
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true
      quoteChar = ch
    } else if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) {
        endIndex = i
        break
      }
    }
  }

  if (endIndex === -1) {
    throw new Error('Unbalanced brackets in SvelteKit data block.')
  }

  const arrayLiteral = str.slice(0, endIndex + 1)
  return vm.runInNewContext(`(${arrayLiteral})`, Object.create(null))
}

async function fetchGamesList () {
  const res = await fetch(POC_URL, { headers: REQUEST_HEADERS })

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} while fetching games list from ${POC_URL}`
    )
  }

  const html = await res.text()
  const dataNodes = extractSvelteKitData(html)
  const gamesList = dataNodes[2]?.data?.results

  if (!Array.isArray(gamesList)) {
    throw new Error('Could not find results array in SvelteKit data.')
  }

  return gamesList
}

async function fetchGameDetails (baseGame) {
  const url = `${BASE_URL}/${baseGame.id}`
  const res = await fetch(url, { headers: REQUEST_HEADERS })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ID ${baseGame.id}`)
  }

  const html = await res.text()
  const dataNodes = extractSvelteKitData(html)

  const pageData = dataNodes[2]?.data
  if (!pageData || !pageData.game) {
    throw new Error(
      `Missing game payload in SvelteKit data for ID ${baseGame.id}`
    )
  }

  const { game, voteCount, people } = pageData

  const teamMembers = (people || [])
    .filter(person => person.onTeam === true)
    .map(person => person.name.trim())

  return {
    id: baseGame.id,
    gameName: game.name ?? baseGame.name,
    gameDescription: game.description ?? '',
    gameUrl: game.playableUrl ?? baseGame.playableUrl,
    githubUrl: game.codeUrl ?? baseGame.codeUrl,
    gamePhoto: game.screenshotUrl ?? null,
    teamMembers,
    voteCount: voteCount ?? baseGame.votes
  }
}

async function main () {
  if (COOKIE == '') {
    console.log("COOKIE not found, please read the comments at the top of the script thank you :P");
    return;
  }
  console.log('Fetching games list...')
  const gamesList = await fetchGamesList()

  const results = []
  const errors = []

  console.log(`Starting scrape for ${gamesList.length} games...`)

  for (let i = 0; i < gamesList.length; i++) {
    const item = gamesList[i]
    try {
      const details = await fetchGameDetails(item)
      results.push(details)
      console.log(
        `[${i + 1}/${gamesList.length}] ✔ ${details.gameName} (${
          details.teamMembers.length
        } members, ${details.voteCount} votes)`
      )
    } catch (err) {
      console.error(
        `[${i + 1}/${gamesList.length}] ✖ Failed ${item.name} (${item.id}): ${
          err.message
        }`
      )
      errors.push({ id: item.id, name: item.name, error: err.message })
    }

    if (i < gamesList.length - 1) {
      await sleep(DELAY_MS)
    }
  }

  await fs.writeFile('games.json', JSON.stringify(results, null, 2), 'utf8')
  console.log(`\nDone! Saved ${results.length} games to games.json P:`)

  if (errors.length > 0) {
    await fs.writeFile('errors.json', JSON.stringify(errors, null, 2), 'utf8')
    console.warn(`${errors.length} games failed. Check errors.json :sobson:`)
  }
}

main()
