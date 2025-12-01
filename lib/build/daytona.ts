import { Daytona, type Sandbox } from '@daytonaio/sdk'

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY
})

export async function createSandbox(
  sessionId: string,
  userId: string
): Promise<Sandbox> {
  return await daytona.create(
    {
      language: 'typescript',
      image: 'node:20',
      envVars: {
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY!
      },
      labels: {
        'discord-user': userId,
        'session-id': sessionId,
        type: 'boneralbot-build'
      },
      resources: {
        cpu: 4,
        memory: 8,
        disk: 50
      },
      autoStopInterval: 30
    },
    { timeout: 180 }
  )
}

export async function getSandbox(sandboxId: string): Promise<Sandbox> {
  return await daytona.get(sandboxId)
}

export async function deleteSandbox(sandbox: Sandbox): Promise<void> {
  await daytona.delete(sandbox, 60)
}

export async function executeCommand(
  sandbox: Sandbox,
  command: string,
  cwd?: string
): Promise<{ result: string; exitCode: number }> {
  return await sandbox.process.executeCommand(command, cwd || '/home/daytona')
}

export async function executeCommandAsync(
  sandbox: Sandbox,
  sessionName: string,
  command: string,
  onLog: (chunk: string) => void
): Promise<number> {
  const cmd = await sandbox.process.executeSessionCommand(sessionName, {
    command,
    runAsync: true
  })

  await sandbox.process.getSessionCommandLogs(
    sessionName,
    cmd.cmdId!,
    onLog,
    onLog
  )

  const result = await sandbox.process.getSessionCommand(
    sessionName,
    cmd.cmdId!
  )
  return result.exitCode ?? 1
}

export { daytona }
