import Replicate from 'replicate'
import { ResultAsync, Result, ok, err } from 'neverthrow'

const replicate = new Replicate()

export interface GenerationResult {
  seedream: Result<Buffer, Error>
  nanoBanana: Result<Buffer, Error>
}

export function generateImage(
  prompt: string,
  imageUrls: string[]
): ResultAsync<GenerationResult, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      const seedreamInput = {
        prompt: prompt,
        image_input: imageUrls
      } as const

      const nanoBananaInput = {
        prompt: prompt,
        image_input: imageUrls,
        output_format: 'jpg'
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

      const nanoBananaResult = await ResultAsync.fromPromise(
        replicate.run('google/nano-banana', { input: nanoBananaInput }),
        (e) =>
          e instanceof Error ? e : new Error('Nano-Banana generation failed')
      )
        .andThen((output) =>
          ResultAsync.fromPromise(
            // @ts-expect-error - yes it does
            fetch(output.url()),
            (e) =>
              e instanceof Error ? e : new Error('Nano-Banana fetch failed')
          )
        )
        .andThen((response) =>
          ResultAsync.fromPromise(
            response.arrayBuffer().then((ab) => Buffer.from(ab)),
            (e) =>
              e instanceof Error ? e : new Error('Nano-Banana buffer failed')
          )
        )

      return {
        seedream: seedreamResult.match(
          (buffer) => ok(buffer),
          (error) => err(error)
        ),
        nanoBanana: nanoBananaResult.match(
          (buffer) => ok(buffer),
          (error) => err(error)
        )
      }
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown error'))
  )
}
