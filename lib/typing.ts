type TypingCapableChannel = {
  sendTyping: () => Promise<unknown>
}

export function startTyping(channel: TypingCapableChannel): () => void {
  let stopped = false
  let intervalId: ReturnType<typeof setInterval>
  let timeoutId: ReturnType<typeof setTimeout>

  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(intervalId)
    clearTimeout(timeoutId)
  }

  channel.sendTyping().catch(() => {
    stop()
  })

  intervalId = setInterval(() => {
    channel.sendTyping().catch(() => {
      stop()
    })
  }, 8000)

  timeoutId = setTimeout(() => {
    stop()
  }, 60_000)

  return stop
}
