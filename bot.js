const {
  Client, GatewayIntentBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, EmbedBuilder
} = require('discord.js');

const { organize, flatten } = require('./drive');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('interactionCreate', async (itx) => {
  try {
    if (itx.isChatInputCommand()) {
      if (itx.commandName === 'drive-organize') {
        const folder = itx.options.getString('folder', true);
        const mode = itx.options.getString('mode') || 'run';

        await itx.deferReply({ ephemeral: true });

        const res = await organize(folder, mode);

        const e = new EmbedBuilder()
          .setTitle(mode === 'dry' ? 'DRY RUN - ORGANIZE' : 'ORGANIZE xong')
          .setDescription(
            `Folder: \`${res.summary.folderId}\`\n` +
            `Tổng file: **${res.summary.totalFiles}**\n` +
            `Ảnh/MP4 hợp lệ: **${res.summary.supported}**\n` +
            `Số mã (subfolder): **${res.summary.codes}**`
          );

        if (mode === 'dry') return itx.editReply({ embeds: [e] });

        const folderId = res.summary.folderId;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`drive_flatten:${folderId}`)
            .setLabel('Undo: Kéo file ra ngoài + dọn folder trống')
            .setStyle(ButtonStyle.Danger)
        );

        e.addFields(
          { name: 'Đã chuyển', value: String(res.movedCount), inline: true },
          { name: 'Folder mới tạo', value: String(res.createdFolderCount), inline: true }
        );

        return itx.editReply({ embeds: [e], components: [row] });
      }

      if (itx.commandName === 'drive-undo') {
        const folder = itx.options.getString('folder', true);
        const mode = itx.options.getString('mode') || 'run';
        const recursive = itx.options.getBoolean('recursive') || false;

        await itx.deferReply({ ephemeral: true });

        const res = await flatten(folder, { mode, recursive });

        if (mode === 'dry') {
          return itx.editReply({
            content:
              `DRY RUN - UNDO/FLATTEN\n` +
              `Folder: ${res.rootId}\n` +
              `Subfolder sẽ xử lý: ${res.folderCount}\n` +
              `File sẽ kéo ra: ${res.fileCount}`
          });
        }

        return itx.editReply({
          content:
            `UNDO/FLATTEN xong\n` +
            `Đã kéo ra: **${res.moved}** | Lỗi: **${res.failed}**\n` +
            `Folder đưa vào thùng rác: **${res.trashedFolders}** | Giữ lại: **${res.keptFolders}**`
        });
      }
    }

    if (itx.isButton()) {
      if (itx.customId.startsWith('drive_flatten:')) {
        const folderId = itx.customId.split(':')[1];

        await itx.deferReply({ ephemeral: true });

        const res = await flatten(folderId, { mode: 'run', recursive: false });

        return itx.editReply({
          content:
            `Undo (flatten) xong\n` +
            `Đã kéo ra: **${res.moved}** | Lỗi: **${res.failed}**\n` +
            `Folder đưa vào thùng rác: **${res.trashedFolders}** | Giữ lại: **${res.keptFolders}**`
        });
      }
    }
  } catch (err) {
    const msg = `Lỗi: ${err?.message || String(err)}`;
    if (itx.deferred || itx.replied) itx.editReply({ content: msg });
    else itx.reply({ content: msg, ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
