process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import {
  Client,
  Events,
  GatewayIntentBits,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
  REST,
  Routes,
  ChatInputCommandInteraction
} from 'discord.js'
import { commands } from './lib/commands.ts'
import { startTyping } from './lib/typing.ts'
import { getRandomCat, getRandomDog, getRandomNSFW, getRandomFromSubreddit } from './lib/random.ts'
import { generateGrokResponse } from './lib/grok.ts'
import { fetchThreadChain, fetchUserMessages, formatMessagesForGrok, type FormattedMessage } from './lib/context.ts'
import { createTools, type ToolContext } from './lib/tools.ts'
import { generateImage } from './lib/image.ts'
import { generateDiscordMessageImage } from './lib/discordImage.ts';
import { type Result } from 'neverthrow'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

// Store context for retry functionality
interface GrokContext {
  prompt: string
  attachmentUrls: string[]
  contextMessages: FormattedMessage[]
  userId: string
  username: string
}

const grokContext = new Map<string, GrokContext>()

function buildRetryRow() {
  const retry = new ButtonBuilder()
    .setCustomId('retry_grok')
    .setLabel('Retry')
    .setStyle(ButtonStyle.Primary)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(retry)
  return row
}

async function handleRandomImageCommand(
  context: Message | ChatInputCommandInteraction,
  fetcher: () => Promise<Result<string | { attachment: Buffer; name: string } | { content: string }, Error>>,
  name: string
) {
  let stopTyping = () => {}
  
  if (context instanceof Message) {
    if ('sendTyping' in context.channel) {
      stopTyping = startTyping(context.channel as any)
    }
  } else {
    await context.deferReply()
  }

  try {
    const result = await fetcher()
    stopTyping()

    if (result.isOk()) {
      const value = result.value
      let replyOptions: any
      
      if (typeof value === 'object' && 'content' in value && typeof value.content === 'string') {
        replyOptions = { content: value.content }
      } else {
        replyOptions = { files: [value] }
      }

      if (context instanceof Message) {
        await context.reply(replyOptions)
      } else {
        await context.editReply(replyOptions)
      }
    } else {
      console.error(`${name} fetch failed:`, result.error)
      const errorMsg = `failed to fetch ${name} image`
      if (context instanceof Message) await context.reply(errorMsg)
      else await context.editReply(errorMsg)
    }
  } catch (e) {
    console.error(`${name} fetch error:`, e)
    const errorMsg = `an error occurred while fetching ${name} image`
    if (context instanceof Message) await context.reply(errorMsg)
    else await context.editReply(errorMsg)
  } finally {
    stopTyping()
  }
}

async function handleChat(
  context: Message | ChatInputCommandInteraction,
  prompt: string,
  attachmentUrls: string[] = [],
  systemPrompt?: string,
  contextMessages: FormattedMessage[] = [],
  responsePrefix?: string
) {
  const user = context instanceof Message ? context.author : context.user
  let stopTyping = () => {}
  
  if (context instanceof Message) {
    if ('sendTyping' in context.channel) {
      stopTyping = startTyping(context.channel as any)
    }
  } else {
    // If not already deferred (e.g. by handleMimic), defer now
    if (!context.deferred && !context.replied) {
      await context.deferReply()
    }
  }

  try {
    // If there are image attachments, directly generate/edit with nano banana pro
    if (attachmentUrls.length > 0) {
      const result = await generateImage(
        prompt,
        attachmentUrls,
        user.id,
        user.username
      )

      stopTyping()

      if (result.isErr()) {
        console.error('Image generation failed:', result.error)
        const errorMsg = `failed to generate image: ${result.error.message}`
        if (context instanceof Message) await context.reply(errorMsg)
        else await context.editReply(errorMsg)
        return
      }

      const { nanoBanana } = result.value

      if (nanoBanana.isErr()) {
        console.error('Nano-banana failed:', nanoBanana.error)
        const errorMsg = `failed to generate image: ${nanoBanana.error.message}`
        if (context instanceof Message) await context.reply(errorMsg)
        else await context.editReply(errorMsg)
        return
      }

      const replyOptions = {
        files: [
          new AttachmentBuilder(nanoBanana.value, {
            name: 'generated.jpg'
          })
        ],
        components: [buildRetryRow()]
      }

      let sentId: string
      if (context instanceof Message) {
        const sent = await context.reply(replyOptions)
        sentId = sent.id
      } else {
        const sent = await context.editReply(replyOptions)
        sentId = sent.id
      }

      // Store context for retry
      grokContext.set(sentId, {
        prompt,
        attachmentUrls,
        contextMessages,
        userId: user.id,
        username: user.username
      })
      return
    }

    // Create tools with Discord context
    // For interactions, we might not have the full message object needed for some tools
    // But we can approximate or fetch it if needed.
    // The tools expect `discordMessage: Message`.
    // If it's an interaction, we might need to fetch the message or adapt the tools.
    // `fetchMessages` tool uses `ctx.discordMessage.channel.messages.fetch`.
    // `interaction.channel` is available.
    
    let toolContext: ToolContext
    if (context instanceof Message) {
      toolContext = {
        discordMessage: context,
        attachmentUrls,
        userId: user.id,
        username: user.username
      }
    } else {
      // Mock message for tools if interaction
      // This is a bit hacky but tools rely on message.channel
      // We can try to fetch the latest message or just pass a mock object that has the channel
      if (!context.channel) throw new Error('No channel found')
      
      toolContext = {
        // @ts-expect-error - partial mock
        discordMessage: {
          channel: context.channel,
          client: context.client,
          author: user
        },
        attachmentUrls,
        userId: user.id,
        username: user.username
      }
    }

    const tools = createTools(toolContext)

    const result = await generateGrokResponse({
      prompt,
      contextMessages,
      attachmentUrls,
      tools,
      systemPrompt
    })

    stopTyping()

    if (result.isErr()) {
      console.error('Grok generation failed:', result.error)
      const errorMsg = `failed to generate response: ${result.error.message}`
      if (context instanceof Message) await context.reply(errorMsg)
      else await context.editReply(errorMsg)
      return
    }

    const { text, reasoning, imageBuffer } = result.value

    // Send image if one was generated
    if (imageBuffer) {
      const replyOptions = {
        content: text || undefined,
        files: [
          new AttachmentBuilder(imageBuffer, {
            name: 'generated.jpg'
          })
        ],
        components: [buildRetryRow()]
      }

      let sentId: string
      if (context instanceof Message) {
        const sent = await context.reply(replyOptions)
        sentId = sent.id
      } else {
        const sent = await context.editReply(replyOptions)
        sentId = sent.id
      }

      grokContext.set(sentId, {
        prompt,
        attachmentUrls,
        contextMessages,
        userId: user.id,
        username: user.username
      })
      return
    }

    // Text-only response
    let fullMessage = text
    if (responsePrefix) {
      fullMessage = `${responsePrefix} ${fullMessage}`
    }

    if (reasoning) {
      const subtextReasoning = reasoning
        .split('\n')
        .map((line) => `-# ${line}`)
        .join('\n')
      fullMessage = `${fullMessage}\n\n${subtextReasoning}`
    }

    if (fullMessage.length > 2000) {
      fullMessage = fullMessage.substring(0, 1997) + '...'
    }

    const replyOptions = {
      content: fullMessage,
      components: [buildRetryRow()]
    }

    let sentId: string
    if (context instanceof Message) {
      const sent = await context.reply(replyOptions)
      sentId = sent.id
    } else {
      // Check if interaction is still valid before editing
      try {
        const sent = await context.editReply(replyOptions)
        sentId = sent.id
      } catch (error) {
        console.error('Failed to edit reply (interaction likely expired):', error)
        return
      }
    }

    grokContext.set(sentId, {
      prompt,
      attachmentUrls,
      contextMessages,
      userId: user.id,
      username: user.username
    })
  } catch (e) {
    console.error('Grok generation error:', e)
    const errorMsg = 'An error occurred while generating a response'
    if (context instanceof Message) {
      await context.reply(errorMsg).catch(console.error)
    } else {
        try {
            await context.editReply(errorMsg)
        } catch {
            // If defer failed or something
        }
    }
  } finally {
    stopTyping()
  }
}

async function handleMimic(
  context: Message | ChatInputCommandInteraction,
  targetUserId: string,
  promptText?: string
) {
  // Defer immediately if it's an interaction
  if (!(context instanceof Message)) {
    await context.deferReply()
  }

  // Identify the Requester
  const requesterUser = context instanceof Message ? context.author : context.user
  const requesterName = requesterUser.username

  // --- 1. Fetch Target Details (Better approach for nickname/avatar) ---
  let targetName = "Unknown User"
  let targetAvatarUrl = requesterUser.displayAvatarURL({ extension: 'png' }); // Default fallback

  try {
      // Try to fetch as a guild member first to get server nickname and server avatar
      if (context.guild) {
          const member = await context.guild.members.fetch(targetUserId);
          targetName = member.displayName;
          // Use server avatar if present, otherwise fall back to user avatar
          targetAvatarUrl = member.displayAvatarURL({ extension: 'png', forceStatic: true });
      } else {
          // Fallback for DMs
          const targetUser = await context.client.users.fetch(targetUserId);
          targetName = targetUser.username;
          targetAvatarUrl = targetUser.displayAvatarURL({ extension: 'png', forceStatic: true });
      }
  } catch (e) {
      console.error("Failed to fetch target user details for mimic:", e);
      // Keep defaults if fetch fails
  }

  // Handle manual typing indicator since we aren't using handleChat
  let stopTyping = () => {}
  if (context instanceof Message && 'sendTyping' in context.channel) {
       stopTyping = startTyping(context.channel as any)
  }


  let finalPrompt = promptText;
  if (!finalPrompt || finalPrompt.trim().length === 0) {
    const randomScenarios = [
      "Complain about something trivial.",
      `Roast ${requesterName}, the one who asked you to mimic this.`,
      "Give a hot take",
      "Yell about something mundane.",
      "Tell a joke in your unique style.",
      "Brag about something insignificant."
    ]
    finalPrompt = randomScenarios[Math.floor(Math.random() * randomScenarios.length)]
  }

  // Fetch history (existing logic)
  const userMessages = await fetchUserMessages(context.client, targetUserId, 100)

  if (userMessages.length < 5) {
    stopTyping();
    const msg = "I couldn't find enough recent messages from that user in general chat to mimic them."
    if (context instanceof Message) await context.reply(msg)
    else await context.editReply(msg)
    return
  }

  const formattedHistory = formatMessagesForGrok(userMessages)

  // (Your existing system prompt remains exactly the same)
  const customSystemPrompt = `You are a method actor performing a deep-fake text impression of the user described below.
TARGET USER: ${targetName}
REQUESTED BY: ${requesterName}
DATA SOURCE:
Use the "TARGET USER HISTORY" as your exclusive source for personality and style.
INSTRUCTIONS:
1.  **Vocabulary & Slang Extraction (CRITICAL)**:
    - Identify unique slang, catchphrases, or filler words (e.g., "lmao", "fr", "bet", "actually") used in the history.
    - REUSE these specific words in your response. Do not invent slang they haven't used.
2.  **Structural Mimicry**:
    - **Casing**: If they type in all lowercase, you must too.
    - **Punctuation**: Copy their punctuation habits exactly. (Do they use periods at the end of messages? Do they use multiple exclamation marks? Do they omit apostrophes?)
    - **Sentence Length**: If they write short, choppy messages, do not write a paragraph. Match their average message length.
3.  **Anti-Caricature**:
    - Do not sound like a generic "internet user."
    - If the history is formal, be formal. If it is chaotic, be chaotic.
    - Do not use emojis unless the history contains them.
4.  **The Content**:
    - Respond to the prompt as if you are the user.
    - Adhere to the opinions and attitude shown in the history.
    - Use names, never raw IDs.
TARGET USER HISTORY:
${formattedHistory}`;

  if (promptText) {
      finalPrompt = `(Context: This command was run by ${requesterName}) ${finalPrompt}`
  }
  console.log(`[mimic] ${requesterName} asked to mimic ${targetName} with prompt: ${finalPrompt}`)

  // --- 2. Generate TEXT using Grok directly (Bypassing handleChat) ---
  try {
      // We call generateGrokResponse directly instead of going through handleChat
      const grokResult = await generateGrokResponse({
          prompt: finalPrompt!,
          contextMessages: [], // Mimic usually doesn't need current thread context
          attachmentUrls: [],
          tools: {}, // No tools for mimics usually
          systemPrompt: customSystemPrompt
      });

      if (grokResult.isErr()) {
          throw grokResult.error;
      }

      // Extract the generated text
      const mimickedText = grokResult.value.text;

      // --- 3. Generate IMAGE using the text and user details ---
      const imageBuffer = await generateDiscordMessageImage(targetName, targetAvatarUrl, mimickedText);

      // --- 4. Send the Result ---
      stopTyping();
      
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'mimic.png' });
      const replyOptions = { 
          files: [attachment]
          // Note: We don't usually add retry buttons to mimics as the context is fleeting
      };

       if (context instanceof Message) {
           await context.reply(replyOptions)
       } else {
           await context.editReply(replyOptions)
       }

  } catch (error: any) {
    stopTyping();
    console.error('Mimic generation error:', error);
    const errorMsg = `Failed to generate mimic: ${error.message || 'Unknown error'}`;
    if (context instanceof Message) {
      await context.reply(errorMsg).catch(console.error)
    } else {
        try { await context.editReply(errorMsg) } catch {}
    }
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`)

  const rest = new REST().setToken(process.env.DISCORD_TOKEN!)

  try {
    console.log('Started refreshing application (/) commands.')

    await rest.put(
      Routes.applicationCommands(c.user.id),
      { body: commands },
    )

    console.log('Successfully reloaded application (/) commands.')
  } catch (error) {
    console.error(error)
  }
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return
  if (!client.user) return

  // Only respond to @mentions
  if (!message.mentions.has(client.user)) return

  const botId = client.user.id
  let prompt = message.content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim()

  // Handle "@bot mimic @User" command
 const cleanPrompt = prompt.replace(/^<@[!&]?\d+>\s*/, '');
  console.log('[index] cleanPrompt:', cleanPrompt);
  const mimicMatch = cleanPrompt.match(/^mimic\s+<@!?(\d+)>/i);
  if (mimicMatch) {
    const targetUserId = mimicMatch[1]
    if (targetUserId) {
      prompt = prompt.replace(/^mimic\s+<@!?\d+>\s*/i, '').trim()
      await handleMimic(message, targetUserId, prompt)
      return
    }
  }

  // Handle "@bot rcat" command
  if (prompt.toLowerCase() === 'rcat') {
    await handleRandomImageCommand(message, getRandomCat, 'cat')
    return
  }

  // Handle "@bot rdog" command
  if (prompt.toLowerCase() === 'rdog') {
    await handleRandomImageCommand(message, getRandomDog, 'dog')
    return
  }

  // Handle "@bot rnsfw" command
  if (prompt.toLowerCase() === 'rnsfw') {
    await handleRandomImageCommand(message, getRandomNSFW, 'nsfw')
    return
  }

  // Handle "@bot r<subreddit>" command
  const subredditMatch = prompt.match(/^r([a-zA-Z0-9_]+)$/i)
  if (subredditMatch) {
    const subreddit = subredditMatch[1]
    if (!subreddit) return
    await handleRandomImageCommand(message, () => getRandomFromSubreddit(subreddit), subreddit)
    return
  }

  if (!prompt) {
    await message.reply('please include a message or question when you mention me')
    return
  }

  // Collect image attachments from current message
  // Check by contentType OR file extension for robustness
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
  const imageAttachments = message.attachments.filter((attachment) => {
    if (attachment.contentType?.startsWith('image/')) return true
    const url = attachment.url?.toLowerCase().split('?')[0]
    return url && imageExtensions.some(ext => url.endsWith(ext))
  })
  let attachmentUrls = imageAttachments.map((a) => a.url)

  // Also check referenced message for images
  if (message.reference) {
    try {
      const referencedMessage = await message.fetchReference()
      const refImageAttachments = referencedMessage.attachments.filter((attachment) => {
        if (attachment.contentType?.startsWith('image/')) return true
        const url = attachment.url?.toLowerCase().split('?')[0]
        return url && imageExtensions.some(ext => url.endsWith(ext))
      })
      const refImageUrls = refImageAttachments.map((a) => a.url)
      attachmentUrls = [...refImageUrls, ...attachmentUrls]
    } catch {
      // Ignore errors fetching reference
    }
  }

  // Fetch thread context if this is a reply
  let contextMessages: FormattedMessage[] = []
  if (message.reference) {
    contextMessages = await fetchThreadChain(message)
  }

  console.log('[index] attachments detected:', attachmentUrls.length, attachmentUrls)

  await handleChat(message, prompt, attachmentUrls, undefined, contextMessages)
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction

    if (commandName === 'rcat') {
      await handleRandomImageCommand(interaction, getRandomCat, 'cat')
    } else if (commandName === 'rdog') {
      await handleRandomImageCommand(interaction, getRandomDog, 'dog')
    } else if (commandName === 'rnsfw') {
      await handleRandomImageCommand(interaction, getRandomNSFW, 'nsfw')
    } else if (commandName === 'r') {
      const subreddit = interaction.options.getString('subreddit', true)
      await handleRandomImageCommand(interaction, () => getRandomFromSubreddit(subreddit), subreddit)
    } else if (commandName === 'mimic') {
      const user = interaction.options.getUser('user', true)
      const prompt = interaction.options.getString('prompt') || undefined
      await handleMimic(interaction, user.id, prompt)
    } else if (commandName === 'ask') {
      const prompt = interaction.options.getString('prompt', true)
      const image = interaction.options.getAttachment('image')
      const attachmentUrls = image ? [image.url] : []
      await handleChat(interaction, prompt, attachmentUrls)
    }
    return
  }

  if (!interaction.isButton()) return
  if (interaction.customId !== 'retry_grok') return

  const ctx = grokContext.get(interaction.message.id)
  if (!ctx) {
    await interaction.reply({
      content: 'context expired. please mention me again with your question.',
      ephemeral: true
    })
    return
  }

  if (!interaction.channel) {
    await interaction.reply({ content: 'cannot retry here', ephemeral: true })
    return
  }

  const channel = interaction.channel
  if (!('sendTyping' in channel) || !('send' in channel)) {
    await interaction.reply({ content: 'cannot retry here', ephemeral: true })
    return
  }

  const stopTyping = startTyping(channel)
  try {
    await interaction.deferReply({ ephemeral: true })

    // If there are image attachments, directly regenerate with nano banana pro
    if (ctx.attachmentUrls.length > 0) {
      const result = await generateImage(
        ctx.prompt,
        ctx.attachmentUrls,
        ctx.userId,
        ctx.username
      )

      if (result.isErr()) {
        console.error('Retry failed:', result.error)
        await interaction.editReply(`retry failed: ${result.error.message}`)
        return
      }

      const { nanoBanana } = result.value

      if (nanoBanana.isErr()) {
        console.error('Retry nano-banana failed:', nanoBanana.error)
        await interaction.editReply(`retry failed: ${nanoBanana.error.message}`)
        return
      }

      const sent = await channel.send({
        files: [
          new AttachmentBuilder(nanoBanana.value, {
            name: 'generated.jpg'
          })
        ],
        components: [buildRetryRow()]
      })
      grokContext.set(sent.id, ctx)
      await interaction.editReply('Retry complete')
      return
    }

    // Create a minimal tool context for retry (no Discord message available)
    const toolContext: ToolContext = {
      // @ts-expect-error - we don't have the original message for retry
      discordMessage: null,
      attachmentUrls: ctx.attachmentUrls,
      userId: ctx.userId,
      username: ctx.username
    }
    const tools = createTools(toolContext)

    const result = await generateGrokResponse({
      prompt: ctx.prompt,
      contextMessages: ctx.contextMessages,
      attachmentUrls: ctx.attachmentUrls,
      tools
    })

    if (result.isErr()) {
      console.error('Retry failed:', result.error)
      await interaction.editReply(`retry failed: ${result.error.message}`)
      return
    }

    const { text, reasoning, imageBuffer } = result.value

    // Send image if one was generated
    if (imageBuffer) {
      const sent = await channel.send({
        content: text || undefined,
        files: [
          new AttachmentBuilder(imageBuffer, {
            name: 'generated.jpg'
          })
        ],
        components: [buildRetryRow()]
      })
      grokContext.set(sent.id, ctx)
      await interaction.editReply('Retry complete')
      return
    }

    // Text-only response
    let fullMessage = text
    if (reasoning) {
      const subtextReasoning = reasoning
        .split('\n')
        .map((line) => `-# ${line}`)
        .join('\n')
      fullMessage = `${text}\n\n${subtextReasoning}`
    }

    if (fullMessage.length > 2000) {
      fullMessage = fullMessage.substring(0, 1997) + '...'
    }

    const sent = await channel.send({
      content: fullMessage,
      components: [buildRetryRow()]
    })

    grokContext.set(sent.id, ctx)
    await interaction.editReply('Retry complete')
  } catch (e) {
    console.error('Retry error:', e)
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('failed to generate response')
      } else {
        await interaction.reply({
          content: 'failed to generate response',
          ephemeral: true
        })
      }
    } catch {}
  } finally {
    stopTyping()
  }
})

client.login(process.env.DISCORD_TOKEN)
