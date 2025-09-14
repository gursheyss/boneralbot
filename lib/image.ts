import Replicate from 'replicate'
import { ResultAsync } from 'neverthrow'

const replicate = new Replicate()

export function generateImage(
  prompt: string,
  imageUrls: string[]
): ResultAsync<{ seedream: Buffer; nanoBanana: Buffer }, Error> {
  return ResultAsync.fromPromise(
    (async () => {
      // Generate with seedream-4
      const seedreamInput = {
        prompt: prompt,
        image_input: imageUrls
      } as const

      const seedreamOutput = await replicate.run('bytedance/seedream-4', {
        input: seedreamInput
      })

      // Generate with nano-banana
      const nanoBananaInput = {
        prompt: prompt,
        image_input: imageUrls,
        output_format: 'jpg'
      } as const

      const nanoBananaOutput = await replicate.run('google/nano-banana', {
        input: nanoBananaInput
      })

      // @ts-expect-error - yes it does
      const seedreamResponse = await fetch(seedreamOutput[0].url())
      const seedreamBuffer = Buffer.from(await seedreamResponse.arrayBuffer())

      // @ts-expect-error - yes it does
      const nanoBananaResponse = await fetch(nanoBananaOutput.url())
      const nanoBananaBuffer = Buffer.from(
        await nanoBananaResponse.arrayBuffer()
      )

      return {
        seedream: seedreamBuffer,
        nanoBanana: nanoBananaBuffer
      }
    })(),
    (e) => (e instanceof Error ? e : new Error('Unknown error'))
  )
}
