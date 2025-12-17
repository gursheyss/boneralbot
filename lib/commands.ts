import { SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js'

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName('rcat')
    .setDescription('Get a random cat image')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('rdog')
    .setDescription('Get a random dog image')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('rnsfw')
    .setDescription('Get a random NSFW image')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('r')
    .setDescription('Get a random image from a subreddit')
    .addStringOption(option =>
      option
        .setName('subreddit')
        .setDescription('The subreddit to fetch from')
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('mimic')
    .setDescription('Mimic a user')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The user to mimic')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('What you want the mimic to say or respond to')
        .setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the bot something')
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('What you want to ask')
        .setRequired(true)
    )
    .addAttachmentOption(option =>
      option
        .setName('image')
        .setDescription('Optional image to edit or use as reference')
        .setRequired(false)
    )
    .toJSON()
]
