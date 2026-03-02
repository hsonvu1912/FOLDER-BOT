const pLimit = require('p-limit');
const { google } = require('googleapis');

/**
 * Shared Drive safe defaults.
 * Nếu folder nằm ở Shared Drive mà không set supportsAllDrives/includeItemsFromAllDrives thì lúc được lúc không.
 */
const DRIVE_OPTS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: 'allDrives',
};

function makeDriveClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive']
  );
  return google.drive({ version: 'v3', auth });
}

function normalizeId(input) {
  if (!input) return '';
  const m = String(input).trim().match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

function escQ(s) {
  return String(s).replace(/'/g, "\\'");
}

function extractCode(fileName) {
  const noExt = String(fileName || '').replace(/\.[^/.]+$/, '').trim();
  return noExt.replace(/\s*\(\d+\)$/, '').trim() || null;
}

function isSupported(file) {
  const mt = file.mimeType || '';
  if (mt.startsWith('image/')) return true;
  if (mt === 'video/mp4') return true;
  return (file.name || '').toLowerCase().endsWith('.mp4');
}

async function listAll(drive, params) {
  let pageToken = undefined;
  const out = [];
  do {
    const res = await drive.files.list({
      ...DRIVE_OPTS,
      ...params,
      pageToken,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

async function listChildren(drive, folderId) {
  return listAll(drive, {
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'nextPageToken, files(id,name,mimeType,parents)',
    pageSize: 1000,
  });
}

async function listFolders(drive, parentId) {
  return listAll(drive, {
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'nextPageToken, files(id,name,mimeType,parents)',
    pageSize: 1000,
  });
}

async function findOrCreateSubfolder(drive, parentId, name) {
  const res = await drive.files.list({
    ...DRIVE_OPTS,
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escQ(name)}' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 1,
  });

  const existed = (res.data.files || [])[0];
  if (existed) return { id: existed.id, created: false };

  const created = await drive.files.create({
    ...DRIVE_OPTS,
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  return { id: created.data.id, created: true };
}

async function moveFile(drive, fileId, fromFolderId, toFolderId) {
  await drive.files.update({
    ...DRIVE_OPTS,
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId,
    fields: 'id',
  });
}

async function folderIsEmpty(drive, folderId) {
  const res = await drive.files.list({
    ...DRIVE_OPTS,
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
    pageSize: 1,
  });
  return (res.data.files || []).length === 0;
}

async function folderChildrenPreview(drive, folderId, n = 5) {
  const res = await drive.files.list({
    ...DRIVE_OPTS,
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,mimeType)',
    pageSize: n,
  });
  return res.data.files || [];
}

async function trashFolder(drive, folderId) {
  await drive.files.update({
    ...DRIVE_OPTS,
    fileId: folderId,
    requestBody: { trashed: true },
    fields: 'id',
  });
}

/**
 * ORGANIZE:
 * - đọc file trong folder gốc
 * - nhóm theo code (bỏ (1)(2)... + bỏ extension)
 * - tạo subfolder theo code
 * - move ảnh/mp4 vào subfolder
 */
async function organize(folderInput, mode = 'run') {
  const folderId = normalizeId(folderInput);
  if (!folderId) throw new Error('Folder ID/link không hợp lệ.');

  const drive = makeDriveClient();
  const files = await listChildren(drive, folderId);

  const groups = new Map();
  for (const f of files) {
    if (!isSupported(f)) continue;
    const code = extractCode(f.name || '');
    if (!code) continue;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(f);
  }

  const summary = {
    folderId,
    totalFiles: files.length,
    supported: [...groups.values()].reduce((a, arr) => a + arr.length, 0),
    codes: groups.size,
  };

  if (mode === 'dry') return { mode, summary };

  const limit = pLimit(5);
  let createdFolderCount = 0;

  for (const [code, arr] of groups.entries()) {
    const sub = await findOrCreateSubfolder(drive, folderId, code);
    if (sub.created) createdFolderCount++;

    await Promise.all(
      arr.map((f) =>
        limit(async () => {
          await moveFile(drive, f.id, folderId, sub.id);
        })
      )
    );
  }

  return {
    mode,
    summary,
    movedCount: summary.supported,
    createdFolderCount,
  };
}

/**
 * UNDO đơn giản = FLATTEN:
 * - list subfolders (1 cấp hoặc recursive)
 * - kéo mọi file trong subfolder về folder gốc
 * - trash subfolder trống
 * - trả thêm trashFailed để bạn biết folder nào không trash được và vì sao
 */
async function flatten(folderInput, { mode = 'run', recursive = false } = {}) {
  const rootId = normalizeId(folderInput);
  if (!rootId) throw new Error('Folder ID/link không hợp lệ.');

  const drive = makeDriveClient();
  const limit = pLimit(5);

  // Collect folders
  const folders = [];
  if (!recursive) {
    folders.push(...(await listFolders(drive, rootId)));
  } else {
    // BFS
    folders.push(...(await listFolders(drive, rootId)));
    for (let i = 0; i < folders.length; i++) {
      const sub = await listFolders(drive, folders[i].id);
      folders.push(...sub);
    }
  }

  // Collect file moves
  const moves = [];
  for (const folder of folders) {
    const children = await listChildren(drive, folder.id);
    for (const item of children) {
      if (item.mimeType === 'application/vnd.google-apps.folder') continue;
      moves.push({ fileId: item.id, fromFolderId: folder.id });
    }
  }

  if (mode === 'dry') {
    return {
      mode,
      rootId,
      folderCount: folders.length,
      fileCount: moves.length,
    };
  }

  let moved = 0;
  let failed = 0;

  await Promise.all(
    moves.map((m) =>
      limit(async () => {
        try {
          await moveFile(drive, m.fileId, m.fromFolderId, rootId);
          moved++;
        } catch {
          failed++;
        }
      })
    )
  );

  // Cleanup folders (bottom-up if recursive)
  const cleanupOrder = recursive ? [...folders].reverse() : folders;

  let trashed = 0;
  let kept = 0;
  const trashFailed = []; // [{id,name,reason,preview[]}]

  for (const f of cleanupOrder) {
    try {
      const empty = await folderIsEmpty(drive, f.id);
      if (!empty) {
        kept++;
        continue;
      }

      try {
        await trashFolder(drive, f.id);
        trashed++;
      } catch (e) {
        kept++;
        const reason =
          e?.response?.data?.error?.message || e?.message || 'unknown';
        const preview = await folderChildrenPreview(drive, f.id, 5).catch(
          () => []
        );
        trashFailed.push({
          id: f.id,
          name: f.name,
          reason,
          preview: preview.map((x) => x.name),
        });
      }
    } catch (e) {
      kept++;
      const reason =
        e?.response?.data?.error?.message || e?.message || 'unknown';
      trashFailed.push({
        id: f.id,
        name: f.name,
        reason,
        preview: [],
      });
    }
  }

  return {
    mode,
    rootId,
    moved,
    failed,
    trashedFolders: trashed,
    keptFolders: kept,
    trashFailed,
  };
}

module.exports = { organize, flatten };
