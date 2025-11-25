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
}

async function getLeaderboard(): Promise<{ userId: string; count: number }[]> {
  // Get top 10 users by usage count (descending)
  const results = (await redis.send('ZREVRANGE', [LEADERBOARD_KEY, '0', '9', 'WITHSCORES'])) as string[]

  const leaderboard: { userId: string; count: number }[] = []
  for (let i = 0; i + 1 < results.length; i += 2) {
    const userId = results[i]
    const countStr = results[i + 1]
    if (userId && countStr) {
      leaderboard.push({
        userId,
        count: parseInt(countStr, 10)
      })
    }
  }
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
  seedream: Result<Buffer, Error>
  nanoBanana: Result<Buffer, Error>
}

export function generateImage(
  prompt: string,
  imageUrls: string[],
  userId?: string
): ResultAsync<GenerationResult, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      const seedreamInput = {
        prompt: prompt,
        image_input: imageUrls
      } as const

      const seedreamResult = await ResultAsync.fromPromise(
        replicate.run('bytedance/seedream-4', { input: seedreamInput }),
        (e) =>
          e instanceof Error ? e : new Error('Seedream generation failed')
      )
        .andThen((output) =>
          ResultAsync.fromPromise(
            // @ts-expect-error - yes it does
            fetch(output[0].url()),
            (e) => (e instanceof Error ? e : new Error('Seedream fetch failed'))
          )
        )
        .andThen((response) =>
          ResultAsync.fromPromise(
            response.arrayBuffer().then((ab) => Buffer.from(ab)),
            (e) =>
              e instanceof Error ? e : new Error('Seedream buffer failed')
          )
        )

      // Check rate limit before making nano-banana-pro request
      let nanoBananaResult: Result<Buffer, Error>

      const canUse = await canUseNanoBanana()
      if (!canUse) {
        const leaderboard = await getLeaderboard()
        const leaderboardText = formatLeaderboard(leaderboard)
        nanoBananaResult = err(
          new Error(
            `Rate limit exceeded (10/hour). Try again later.\n\n${leaderboardText}`
          )
        )
      } else {
        const nanoBananaInput = {
          prompt: prompt,
          image_input: imageUrls,
          aspect_ratio: imageUrls.length > 0 ? 'match_input_image' : '1:1',
          resolution: '2K',
          output_format: 'jpg',
          safety_filter_level: 'block_only_high'
        } as const

        nanoBananaResult = await ResultAsync.fromPromise(
          replicate.run('google/nano-banana-pro', { input: nanoBananaInput }),
          (e) =>
            e instanceof Error
              ? e
              : new Error('Nano-Banana Pro generation failed')
        )
          .andThen((output) => {
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
          .andThen((response) =>
            ResultAsync.fromPromise(
              response.arrayBuffer().then((ab) => Buffer.from(ab)),
              (e) =>
                e instanceof Error
                  ? e
                  : new Error('Nano-Banana Pro buffer failed')
            )
          )
          .match(
            (buffer) => ok(buffer),
            (error) => err(error)
          )
      }

      return {
        seedream: seedreamResult.match(
          (buffer) => ok(buffer),
          (error) => err(error)
        ),
        nanoBanana: nanoBananaResult
      }
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown error'))
  )
}

export { getLeaderboard, formatLeaderboard, getRemainingRequests }
