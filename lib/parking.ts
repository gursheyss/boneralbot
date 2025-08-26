import { ok, err } from 'neverthrow'
import type { Result } from 'neverthrow'
import * as cheerio from 'cheerio'
import { formatDistanceToNow } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'

export type ParkingData = {
  name: string
  fullness: string
}

export type ParkingResponse = {
  data: ParkingData[]
  websiteTimestamp: string
}

interface CachedData {
  data: ParkingData[]
  websiteTimestamp: string
  timestamp: number
}

const CACHE_DURATION_MS = 60_000
let cache: CachedData | null = null

export async function fetchParkingData(): Promise<
  Result<ParkingResponse, Error>
> {
  if (cache && Date.now() - cache.timestamp < CACHE_DURATION_MS) {
    return ok({ data: cache.data, websiteTimestamp: cache.websiteTimestamp })
  }

  try {
    const response = await fetch('https://sjsuparkingstatus.sjsu.edu/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    })

    if (!response.ok) {
      return err(new Error(`HTTP error! status: ${response.status}`))
    }

    const html = await response.text()
    const $ = cheerio.load(html)

    // Extract website timestamp
    const timestampText = $('p.timestamp').text()
    const websiteTimestamp =
      timestampText
        .replace(/Last updated\s*/i, '')
        .replace(/\s*Refresh\s*$/i, '')
        .trim() || 'Unknown'

    // Extract parking data
    const parkingData: ParkingData[] = []

    // Parse garage data - find each h2 and its corresponding span
    $('.garage h2.garage__name').each((index, element) => {
      const $nameElement = $(element)
      const name = $nameElement
        .text()
        .replace(/\s+Garage\s*$/, '')
        .trim()

      // Find the corresponding fullness span in the next p element
      const $nextP = $nameElement.next('p.garage__text')
      const rawFullness = $nextP.find('span.garage__fullness').text().trim()

      if (name && rawFullness) {
        let fullness =
          rawFullness.toLowerCase() === 'full' ? '100%' : rawFullness
        // Clean up the percentage (remove extra spaces)
        fullness = fullness.replace(/\s+/g, '').trim()

        // Ensure it has % if it's a number
        if (!fullness.includes('%') && !Number.isNaN(parseInt(fullness))) {
          fullness = fullness + '%'
        }

        parkingData.push({ name, fullness })
      }
    })

    cache = { data: parkingData, websiteTimestamp, timestamp: Date.now() }
    return ok({ data: parkingData, websiteTimestamp })
  } catch (e) {
    const error = e instanceof Error ? e : new Error('Unknown error')
    return err(error)
  }
}

export function formatParkingResponse(data: ParkingData[]): string {
  return data.map((garage) => `${garage.name} ${garage.fullness}`).join('\n')
}

export function createTextChart(
  data: ParkingData[],
  websiteTimestamp: string
): string {
  if (data.length === 0) return 'No parking data available'

  const maxNameLength = Math.max(...data.map((d) => d.name.length))
  const chart = data
    .map((garage) => {
      const fullness = parseInt(garage.fullness.replace('%', ''))
      const barLength = Math.floor(fullness / 5)
      const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength)
      const paddedName = garage.name.padEnd(maxNameLength + 2)
      return `${paddedName} ${bar} ${garage.fullness}`
    })
    .join('\n')

  // Format timestamp to show relative time using date-fns
  const formatTimestamp = (timestamp: string) => {
    if (timestamp === 'Unknown') return 'Unknown'
    try {
      const date = new Date(timestamp)

      if (Number.isNaN(date.getTime())) {
        return timestamp
      }

      const pstTimeZone = 'America/Los_Angeles'
      const zonedDate = toZonedTime(date, pstTimeZone)

      // Get relative time (e.g., "5 minutes ago")
      const relativeTime = formatDistanceToNow(zonedDate, { addSuffix: true })

      return relativeTime
    } catch {
      return timestamp
    }
  }

  return `SJSU Parking Garage Status\n${'='.repeat(50)}\n${chart}\n\nWebsite last updated ${formatTimestamp(websiteTimestamp)}`
}
