const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('drive-organize')
    .setDescription('Tạo subfolder theo mã và chuyển ảnh/mp4 vào đúng folder')
    .addStringOption(o => o.setName('folder').setDescription('Folder link hoặc ID').setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('dry hoặc run').setRequired(false)
      .addChoices({ name: 'dry', value: 'dry' }, { name: 'run', value: 'run' })),

  new SlashCommandBuilder()
    .setName('drive-undo')
    .setDescription('UNDO đơn giản: kéo file ra folder gốc và dọn subfolder trống')
    .addStringOption(o => o.setName('folder').setDescription('Folder link hoặc ID').setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('dry hoặc run').setRequired(false)
      .addChoices({ name: 'dry', value: 'dry' }, { name: 'run', value: 'run' }))
    .addBooleanOption(o => o.setName('recursive').setDescription('Có xử lý folder lồng nhau không? (mặc định: không)')),
].map(c => c.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID; // deploy theo guild để thấy ngay

if (!token || !clientId || !guildId) {
  console.error('Thiếu DISCORD_TOKEN hoặc CLIENT_ID hoặc GUILD_ID');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Deploying (guild) slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
    console.log('Done.');
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
