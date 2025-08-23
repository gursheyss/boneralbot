type TypingCapableChannel = {
  sendTyping: () => Promise<unknown>
}

export function startTyping(channel: TypingCapableChannel): () => void {
  void channel.sendTyping()

  const interval = setInterval(() => {
    channel.sendTyping().catch(() => {
      clearInterval(interval)
    })
  }, 8000)

  return () => clearInterval(interval)
}
