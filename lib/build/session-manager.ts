import type { Message, ThreadChannel, TextChannel } from 'discord.js'
import type { BuildSession } from './types'
import { createSandbox, deleteSandbox } from './cloudflare'
import {
  cloneRepo,
  createBranch,
  createDraftPR,
  commitAll,
  markPRReady,
  protectSandboxFolder,
} from './git'
import {
  installOpenCode,
  configureOpenCode,
  createOpenCodeSession,
  sendPromptToOpenCode,
  cleanupOpenCodeSession,
} from './opencode'
import { startTyping } from '../typing'

const activeSessions = new Map<string, BuildSession>()
const threadToSession = new Map<string, string>()

interface ProgressStep {
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
}

function formatProgress(steps: ProgressStep[], description: string): string {
  const lines = [`**Building:** ${description}\n`]

  for (const step of steps) {
    const icon =
      step.status === 'done'
        ? '✓'
        : step.status === 'active'
          ? '►'
          : step.status === 'error'
            ? '✗'
            : '○'
    const style = step.status === 'active' ? '**' : ''
    lines.push(`${icon} ${style}${step.label}${style}`)
  }

  return lines.join('\n')
}

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
    autoArchiveDuration: 1440,
  })

  const steps: ProgressStep[] = [
    { label: 'Creating sandbox', status: 'pending' },
    { label: 'Cloning repository', status: 'pending' },
    { label: `Creating branch \`${branch}\``, status: 'pending' },
    { label: 'Pushing branch', status: 'pending' },
    { label: 'Creating draft PR', status: 'pending' },
    { label: 'Installing dependencies', status: 'pending' },
    { label: 'Configuring OpenCode', status: 'pending' },
  ]

  const statusMsg = await thread.send(formatProgress(steps, description))

  const updateProgress = async (stepIndex: number, status: ProgressStep['status']) => {
    steps[stepIndex].status = status
    await statusMsg.edit(formatProgress(steps, description)).catch(() => {})
  }

  let sandbox
  let prNumber = 0
  let prUrl = ''

  try {
    // Step 0: Create sandbox
    await updateProgress(0, 'active')
    sandbox = await createSandbox(sessionId, message.author.id)
    await updateProgress(0, 'done')

    // Step 1: Clone repo
    await updateProgress(1, 'active')
    await cloneRepo(sandbox)
    await protectSandboxFolder(sandbox)
    await updateProgress(1, 'done')

    // Step 2: Create branch
    await updateProgress(2, 'active')
    await createBranch(sandbox, branch)
    await updateProgress(2, 'done')

    // Step 3: Push branch to remote
    await updateProgress(3, 'active')
    await commitAll(
      sandbox,
      'chore: initialize build session',
      message.author.username,
      true
    )
    await updateProgress(3, 'done')

    // Step 4: Create draft PR
    await updateProgress(4, 'active')
    const pr = await createDraftPR(
      sandbox,
      branch,
      `Build: ${description.slice(0, 60)}`,
      `Automated build session started by <@${message.author.id}>\n\n**Description:**\n${description}`
    )
    prNumber = pr.prNumber
    prUrl = pr.prUrl
    await updateProgress(4, 'done')

    // Step 5: Install dependencies
    await updateProgress(5, 'active')
    await installOpenCode(sandbox)
    await updateProgress(5, 'done')

    // Step 6: Configure OpenCode
    await updateProgress(6, 'active')
    await configureOpenCode(sandbox)
    await createOpenCodeSession(sandbox)
    await updateProgress(6, 'done')

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
      repoPath: '/workspace/repo',
      createdAt: new Date(),
      status: 'active',
    }

    activeSessions.set(sessionId, session)
    threadToSession.set(thread.id, sessionId)

    // Final success message
    await statusMsg.edit(
      `✓ **Ready!**\n\n` +
        `**PR:** ${prUrl}\n\n` +
        `Send messages to instruct OpenCode.\n` +
        `Say \`done\` when finished.`
    )

    await handleThreadMessage(thread, description, session)

    return session
  } catch (error) {
    // Mark current active step as error
    const activeStep = steps.findIndex((s) => s.status === 'active')
    if (activeStep !== -1) {
      await updateProgress(activeStep, 'error')
    }
    await thread.send(`\`\`\`\n${error}\n\`\`\``)
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
