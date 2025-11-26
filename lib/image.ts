import Replicate from 'replicate'
import { ResultAsync, type Result, ok, err } from 'neverthrow'
import { RedisClient } from 'bun'

const replicate = new Replicate()
const redis = new RedisClient(process.env.REDIS_URL)

// Rate limiting for nano-banana-pro: 10 requests per hour
const NANO_BANANA_RATE_LIMIT = 10
const NANO_BANANA_RATE_WINDOW_SECONDS = 60 * 60 // 1 hour

const RATE_LIMIT_KEY = 'nano-banana-pro:requests'
const LEADERBOARD_KEY = 'nano-banana-pro:leaderboard'

async function canUseNanoBanana(): Promise<boolean> {
  const now = Date.now()
  const windowStart = now - NANO_BANANA_RATE_WINDOW_SECONDS * 1000

  // Remove old entries and count current ones
  await redis.send('ZREMRANGEBYSCORE', [RATE_LIMIT_KEY, '-inf', String(windowStart)])
  const count = await redis.send('ZCARD', [RATE_LIMIT_KEY])

  console.log('[image] nano-banana rate limit check:', count, '/', NANO_BANANA_RATE_LIMIT)
  return (count as number) < NANO_BANANA_RATE_LIMIT
}

async function recordNanoBananaRequest(userId: string): Promise<void> {
  const now = Date.now()

  // Add to rate limit tracking (score = timestamp, member = unique id)
  await redis.send('ZADD', [RATE_LIMIT_KEY, String(now), `${userId}:${now}`])
  // Set expiry on the key to auto-cleanup
  await redis.expire(RATE_LIMIT_KEY, NANO_BANANA_RATE_WINDOW_SECONDS + 60)

  // Increment user's count in leaderboard
  await redis.send('ZINCRBY', [LEADERBOARD_KEY, '1', userId])
  console.log('[image] recorded nano-banana request for user:', userId)
}

async function getLeaderboard(): Promise<{ userId: string; count: number }[]> {
  // Get top 10 users by usage count (descending)
  const rawResults = (await redis.send('ZREVRANGE', [
    LEADERBOARD_KEY,
    '0',
    '9',
    'WITHSCORES'
  ])) as unknown

  /**
   * Bun's Redis client can return either a flat string array
   * or an array of string tuples for WITHSCORES. Normalize to a flat array.
   */
  const flatResults: string[] = Array.isArray(rawResults)
    ? rawResults.flatMap((entry) =>
        Array.isArray(entry) ? entry.map((v) => String(v)) : [String(entry)]
      )
    : []

  const leaderboard: { userId: string; count: number }[] = []
  for (let i = 0; i + 1 < flatResults.length; i += 2) {
    const userId = flatResults[i]
    const countStr = flatResults[i + 1]
    const count = parseInt(countStr, 10)

    if (userId && Number.isFinite(count)) {
      leaderboard.push({
        userId,
        count
      })
    }
  }
  console.log('[image] leaderboard entries:', leaderboard.length)
  return leaderboard
}

async function getRemainingRequests(): Promise<number> {
  const now = Date.now()
  const windowStart = now - NANO_BANANA_RATE_WINDOW_SECONDS * 1000

  await redis.send('ZREMRANGEBYSCORE', [RATE_LIMIT_KEY, '-inf', String(windowStart)])
  const count = await redis.send('ZCARD', [RATE_LIMIT_KEY])

  return Math.max(0, NANO_BANANA_RATE_LIMIT - (count as number))
}

function formatLeaderboard(
  leaderboard: { userId: string; count: number }[]
): string {
  if (leaderboard.length === 0) {
    return 'No usage yet!'
  }

  const lines = leaderboard.map(
    (entry) => `<@${entry.userId}>: ${entry.count}`
  )

  return `Image generation count:\n${lines.join('\n')}`
}

export interface GenerationResult {
  nanoBanana: Result<Buffer, Error>
}

export function generateImage(
  prompt: string,
  imageUrls: string[],
  userId?: string
): ResultAsync<GenerationResult, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      console.log('[image] starting generation')
      console.log('[image] prompt:', prompt)
      console.log('[image] image urls:', imageUrls.length)
      console.log('[image] user id:', userId ?? 'none')

      // Check rate limit before making nano-banana-pro request
      let nanoBananaResult: Result<Buffer, Error>

      const canUse = await canUseNanoBanana()
      if (!canUse) {
        console.log('[image] nano-banana rate limited')
        const leaderboard = await getLeaderboard()
        const leaderboardText = formatLeaderboard(leaderboard)
        nanoBananaResult = err(
          new Error(
            `Rate limit exceeded (10/hour). Try again later.\n\n${leaderboardText}`
          )
        )
      } else {
        console.log('[image] starting nano-banana-pro generation')
        const nanoBananaInput = {
          prompt: prompt,
          image_input: imageUrls,
          aspect_ratio: imageUrls.length > 0 ? 'match_input_image' : '1:1',
          resolution: '2K',
          output_format: 'jpg',
          safety_filter_level: 'block_only_high'
        } as const
        console.log('[image] nano-banana input:', JSON.stringify(nanoBananaInput))

        nanoBananaResult = await ResultAsync.fromPromise(
          replicate.run('google/nano-banana-pro', { input: nanoBananaInput }),
          (e) =>
            e instanceof Error
              ? e
              : new Error('Nano-Banana Pro generation failed')
        )
          .andThen((output) => {
            console.log('[image] nano-banana replicate response received')
            if (userId) {
              recordNanoBananaRequest(userId)
            }
            return ResultAsync.fromPromise(
              // @ts-expect-error - yes it does
              fetch(output.url()),
              (e) =>
                e instanceof Error
                  ? e
                  : new Error('Nano-Banana Pro fetch failed')
            )
          })
          .andThen((response) => {
            console.log('[image] nano-banana fetch complete, status:', response.status)
            return ResultAsync.fromPromise(
              response.arrayBuffer().then((ab) => Buffer.from(ab)),
              (e) =>
                e instanceof Error
                  ? e
                  : new Error('Nano-Banana Pro buffer failed')
            )
          })
          .match(
            (buffer) => {
              console.log('[image] nano-banana success, buffer size:', buffer.length)
              return ok(buffer)
            },
            (error) => {
              console.error('[image] nano-banana failed:', error.message)
              return err(error)
            }
          )
      }

      console.log('[image] generation complete')
      console.log('[image] nano-banana:', nanoBananaResult.isOk() ? 'success' : 'failed')

      return {
        nanoBanana: nanoBananaResult
      }
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown error'))
  )
}

export { getLeaderboard, formatLeaderboard, getRemainingRequests }
