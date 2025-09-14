import Replicate from 'replicate'
import { ResultAsync } from 'neverthrow'

const replicate = new Replicate()

export function generateImage(
  prompt: string,
  imageUrls: string[]
): ResultAsync<{ seedream: Buffer; nanoBanana: Buffer }, Error> {
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

      const [seedreamOutput, nanoBananaOutput] = await Promise.all([
        replicate.run('bytedance/seedream-4', {
          input: seedreamInput
        }),
        replicate.run('google/nano-banana', {
          input: nanoBananaInput
        })
      ])

      // Fetch both images in parallel
      const [seedreamResponse, nanoBananaResponse] = await Promise.all([
        // @ts-expect-error - yes it does
        fetch(seedreamOutput[0].url()),
        // @ts-expect-error - yes it does
        fetch(nanoBananaOutput.url())
      ])

      const [seedreamBuffer, nanoBananaBuffer] = await Promise.all([
        seedreamResponse.arrayBuffer().then((ab) => Buffer.from(ab)),
        nanoBananaResponse.arrayBuffer().then((ab) => Buffer.from(ab))
      ])

      return {
        seedream: seedreamBuffer,
        nanoBanana: nanoBananaBuffer
      }
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown error'))
  )
}
