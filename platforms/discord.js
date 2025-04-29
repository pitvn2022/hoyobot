const {
	ChannelType,
	Client,
	DiscordAPIError,
	GatewayIntentBits,
	PermissionFlagsBits,
	REST,
	Routes
} = require("discord.js");

const ignoredChannels = [
	ChannelType.AnnouncementThread,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildCategory,
	ChannelType.PrivateThread,
	ChannelType.PublicThread
];

module.exports = class DiscordController extends require("./template.js") {
	constructor (config) {
		super("discord", config);

		if (!this.botId) {
			throw new app.Error({
				message: "No bot ID provided for Discord controller"
			});
		}
		else if (!this.token) {
			throw new app.Error({
				message: "Discord token has not been configured for the bot"
			});
		}
	}

	async connect () {
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent
			]
		});

		this.initListeners();
		await this.client.login(this.token);

		await this.registerSlashCommands();
	}

	initListeners () {
		/** @type {Client} */
		const client = this.client;

		client.on("messageCreate", async (messageData) => {
			if (messageData.content.length === 0 && Array.isArray(messageData.embeds) && messageData.embeds.length > 0) {
				return;
			}

			const {
				message,
				channelType,
				discordID,
				author,
				commandArgs
			} = this.parseMessage(messageData);

			if (ignoredChannels.includes(channelType)) {
				return;
			}

			const botPermissions = messageData.channel.permissionsFor?.(this.id);
			if (botPermissions && !botPermissions.has(PermissionFlagsBits.SendMessages)) {
				return;
			}

			if (discordID === this.id) {
				return;
			}

			if (app.Command.is(message)) {
				const commandPrefix = app.Command.prefix;
				const command = message.replace(commandPrefix, "").split(" ").find(Boolean);
				const args = (commandArgs[0] === commandPrefix)
					? commandArgs.slice(2)
					: commandArgs.slice(1);

				await this.handleCommand({
					command,
					args,
					channelData: messageData.channel,
					userData: author
				});
			}
		});

		client.on("interactionCreate", async (interaction) => {
			if (!interaction.isChatInputCommand()) {
				return;
			}

			const commandName = interaction.commandName;
			const options = interaction.options;

			const args = options.data.map(i => i.value);

			const channelData = interaction.channel;
			const userData = interaction.user;

			await this.handleCommand({
				interaction,
				command: commandName,
				args,
				channelData,
				userData
			});
		});
	}

	async send (message, channel, options = {}) {
		const channelData = await this.client.channels.fetch(channel.id);
		if (!channelData) {
			return;
		}

		let sendTarget;
		if (Array.isArray(options.embeds) && options.embeds.length !== 0) {
			sendTarget = {
				embeds: options.embeds
			};
		}
		else if (typeof message === "string") {
			sendTarget = message;
		}
		else {
			throw new app.Error({
				message: "Invalid Discord message provided",
				args: {
					message,
					type: typeof message
				}
			});
		}

		try {
			await channelData.send(sendTarget);
		}
		catch (e) {
			if (e instanceof DiscordAPIError) {
				app.Logger.log("Discord", {
					message: sendTarget,
					channelID: channelData.id,
					channelName: channelData.name ?? null,
					guildID: channelData.guild.id ?? null,
					guildName: channelData.guild.name ?? null
				});
			}
			else {
				throw new app.Error({
					message: "Failed to send message to Discord channel",
					args: {
						message: sendTarget,
						channelID: channelData.id,
						channelName: channelData.name ?? null,
						guildID: channelData.guild.id ?? null,
						guildName: channelData.guild.name ?? null
					},
					cause: e
				});
			}
		}
	}

	async handleCommand (data) {
		const {
			interaction,
			command,
			args,
			channelData,
			userData
		} = data;

		const execution = await app.Command.checkAndRun(command, args, channelData, userData, {
			interaction,
			platform: {
				id: 1,
				name: "Discord"
			}
		});

		if (!execution) {
			return;
		}

		const { reply }	= execution;
		const embeds = execution.discord?.embeds ?? [];
		if (!reply && embeds.length === 0) {
			return;
		}

		if (embeds.length !== 0) {
			await this.send(null, channelData, {
				embeds
			});
		}
		else {
			await this.send(reply, channelData);
		}
	}

	async registerSlashCommands () {
		const commands = [];

		for (const command of app.Command.data) {
			const slashCommandData = command.getSlashCommandData();
			commands.push(slashCommandData.toJSON());
		}

		const rest = new REST({ version: "10" }).setToken(this.token);

		try {
			app.Logger.info("Discord", "Registering application commands.");

			await rest.put(
				Routes.applicationCommands(this.botId),
				{ body: commands }
			);

			app.Logger.info("Discord", `Successfully registered ${commands.length} application commands.`);
		}
		catch (e) {
			console.error(e);
		}
	}

	parseMessage (messageData) {
		const content = messageData.content.replace(/<(https?:\/\/.+?)>/g, "$1");
		const args = content.split(" ");

		return {
			message: messageData.cleanContent.replace(/\s+/g, " "),
			channelType: messageData.channel.type,
			discordID: String(messageData.author.id),
			author: messageData.author,
			commandArgs: args
		};
	}
};
