import type { Message, ThreadChannel, TextChannel } from 'discord.js'
import type { BuildSession } from './types'
import { createSandbox, deleteSandbox } from './daytona'
import {
  cloneRepo,
  createBranch,
  createDraftPR,
  commitAll,
  markPRReady
} from './git'
import {
  installOpenCode,
  configureOpenCode,
  createOpenCodeSession,
  sendPromptToOpenCode,
  cleanupOpenCodeSession
} from './opencode'
import { startTyping } from '../typing'

const activeSessions = new Map<string, BuildSession>()
const threadToSession = new Map<string, string>()

export function getSessionByThread(threadId: string): BuildSession | undefined {
  const sessionId = threadToSession.get(threadId)
  return sessionId ? activeSessions.get(sessionId) : undefined
}

export async function startBuildSession(
  message: Message,
  description: string
): Promise<BuildSession | null> {
  const sessionId = `build-${Date.now()}`
  const branch = `build/${sessionId}`

  const thread = await message.startThread({
    name: `Build: ${description.slice(0, 50)}`,
    autoArchiveDuration: 1440
  })

  await thread.send(
    `Starting build session...\n\n**Description:** ${description}`
  )

  try {
    await thread.send('Creating development environment...')
    const sandbox = await createSandbox(sessionId, message.author.id)

    await thread.send('Cloning repository...')
    await cloneRepo(sandbox)

    await thread.send(`Creating branch \`${branch}\`...`)
    await createBranch(sandbox, branch)

    await thread.send('Creating draft PR...')
    const { prNumber, prUrl } = await createDraftPR(
      sandbox,
      branch,
      `Build: ${description.slice(0, 60)}`,
      `Automated build session started by <@${message.author.id}>\n\n**Description:**\n${description}`
    )

    await thread.send('Setting up OpenCode...')
    await installOpenCode(sandbox)
    await configureOpenCode(sandbox)
    await createOpenCodeSession(sandbox)

    const session: BuildSession = {
      id: sessionId,
      discordThreadId: thread.id,
      discordUserId: message.author.id,
      discordUsername: message.author.username,
      sandbox,
      sandboxId: sandbox.id,
      branch,
      prNumber,
      prUrl,
      repoPath: 'workspace',
      createdAt: new Date(),
      status: 'active'
    }

    activeSessions.set(sessionId, session)
    threadToSession.set(thread.id, sessionId)

    await thread.send(
      `Build environment ready!\n\n` +
        `**PR:** ${prUrl}\n\n` +
        `Send messages in this thread to instruct OpenCode. ` +
        `Say \`done\` when finished to mark the PR ready for review.`
    )

    await handleThreadMessage(thread, description, session)

    return session
  } catch (error) {
    await thread.send(`Failed to start build session: ${error}`)
    return null
  }
}

export async function handleThreadMessage(
  channel: ThreadChannel | TextChannel,
  content: string,
  session?: BuildSession
): Promise<void> {
  if (!session) {
    session = getSessionByThread(channel.id)
  }
  if (!session || session.status !== 'active') return

  if (content.toLowerCase().trim() === 'done') {
    await endBuildSession(session.id, true, channel)
    return
  }

  const stopTyping = startTyping(channel)
  const state: { message: Message | null } = { message: null }
  let buffer = ''
  let lastUpdate = 0

  try {
    const exitCode = await sendPromptToOpenCode(
      session.sandbox,
      content,
      (chunk) => {
        buffer += chunk

        const now = Date.now()
        if (now - lastUpdate > 500) {
          lastUpdate = now
          const truncated = buffer.slice(-1800)

          if (!state.message) {
            channel
              .send(`\`\`\`\n${truncated}\n\`\`\``)
              .then((msg) => {
                state.message = msg
              })
              .catch(() => {})
          } else {
            state.message.edit(`\`\`\`\n${truncated}\n\`\`\``).catch(() => {})
          }
        }
      }
    )

    if (buffer) {
      const truncated = buffer.slice(-1800)
      try {
        if (!state.message) {
          await channel.send(`\`\`\`\n${truncated}\n\`\`\``)
        } else {
          await state.message.edit(`\`\`\`\n${truncated}\n\`\`\``)
        }
      } catch {
        // Ignore Discord API errors
      }
    }

    const commitSha = await commitAll(
      session.sandbox,
      `OpenCode: ${content.slice(0, 50)}`,
      session.discordUsername
    )

    if (commitSha) {
      await channel.send(`Committed: \`${commitSha.slice(0, 7)}\``)
    }

    if (exitCode !== 0) {
      await channel.send(`OpenCode exited with code ${exitCode}`)
    }

    await channel.send('Ready for next instruction. Say `done` when finished.')
  } catch (error) {
    await channel.send(`Error: ${error}`)
  } finally {
    stopTyping()
  }
}

export async function endBuildSession(
  sessionId: string,
  markReady: boolean,
  channel?: ThreadChannel | TextChannel
): Promise<void> {
  const session = activeSessions.get(sessionId)
  if (!session) return

  session.status = 'completed'

  try {
    if (markReady) {
      await markPRReady(session.sandbox, session.prNumber)
      if (channel) {
        await channel.send(`PR marked ready for review: ${session.prUrl}`)
      }
    }

    await cleanupOpenCodeSession(session.sandbox)
    await deleteSandbox(session.sandbox)

    if (channel) {
      await channel.send('Build environment cleaned up.')
    }
  } catch (error) {
    if (channel) {
      await channel.send(`Cleanup error: ${error}`)
    }
  } finally {
    activeSessions.delete(sessionId)
    threadToSession.delete(session.discordThreadId)
  }
}

export async function cleanupStaleSessions(): Promise<void> {
  const now = Date.now()
  const maxAge = 2 * 60 * 60 * 1000

  for (const [sessionId, session] of activeSessions) {
    if (now - session.createdAt.getTime() > maxAge) {
      await endBuildSession(sessionId, false)
    }
  }
}
