const pLimit = require('p-limit');
const { google } = require('googleapis');

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

function extractCode(fileName) {
  const noExt = fileName.replace(/\.[^/.]+$/, '').trim();
  return noExt.replace(/\s*\(\d+\)$/, '').trim() || null;
}

function isSupported(file) {
  const mt = file.mimeType || '';
  if (mt.startsWith('image/')) return true;
  if (mt === 'video/mp4') return true;
  return (file.name || '').toLowerCase().endsWith('.mp4');
}

function escQ(s) {
  return String(s).replace(/'/g, "\\'");
}

async function listAll(drive, params) {
  let pageToken = undefined;
  const out = [];
  do {
    const res = await drive.files.list({ ...params, pageToken });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

async function listChildren(drive, folderId) {
  return listAll(drive, {
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'nextPageToken, files(id,name,mimeType,parents)',
    pageSize: 1000
  });
}

async function listFolders(drive, parentId) {
  return listAll(drive, {
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'nextPageToken, files(id,name,mimeType,parents)',
    pageSize: 1000
  });
}

async function findOrCreateSubfolder(drive, parentId, name, createdFolderIds) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escQ(name)}' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 1
  });

  const existed = (res.data.files || [])[0];
  if (existed) return existed.id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id'
  });

  const id = created.data.id;
  createdFolderIds.push(id);
  return id;
}

async function moveFile(drive, fileId, fromFolderId, toFolderId) {
  await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId,
    fields: 'id'
  });
}

async function folderIsEmpty(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
    pageSize: 1
  });
  return (res.data.files || []).length === 0;
}

async function trashFolder(drive, folderId) {
  await drive.files.update({
    fileId: folderId,
    requestBody: { trashed: true },
    fields: 'id'
  });
}

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
    codes: groups.size
  };

  if (mode === 'dry') return { mode, summary };

  const createdFolderIds = [];
  const limit = pLimit(5);

  for (const [code, arr] of groups.entries()) {
    const subId = await findOrCreateSubfolder(drive, folderId, code, createdFolderIds);

    await Promise.all(arr.map(f => limit(async () => {
      await moveFile(drive, f.id, folderId, subId);
    })));
  }

  return {
    mode,
    summary,
    movedCount: summary.supported,
    createdFolderCount: createdFolderIds.length
  };
}

async function flatten(folderInput, { mode = 'run', recursive = false } = {}) {
  const rootId = normalizeId(folderInput);
  if (!rootId) throw new Error('Folder ID/link không hợp lệ.');

  const drive = makeDriveClient();
  const limit = pLimit(5);

  const folders = [];
  if (!recursive) {
    folders.push(...await listFolders(drive, rootId));
  } else {
    const first = await listFolders(drive, rootId);
    folders.push(...first);
    for (let i = 0; i < folders.length; i++) {
      const sub = await listFolders(drive, folders[i].id);
      folders.push(...sub);
    }
  }

  const moves = [];
  for (const folder of folders) {
    const children = await listChildren(drive, folder.id);
    for (const item of children) {
      if (item.mimeType === 'application/vnd.google-apps.folder') continue;
      moves.push({ fileId: item.id, fromFolderId: folder.id });
    }
  }

  if (mode === 'dry') {
    return { mode, rootId, folderCount: folders.length, fileCount: moves.length };
  }

  let moved = 0;
  let failed = 0;

  await Promise.all(moves.map(m => limit(async () => {
    try {
      await moveFile(drive, m.fileId, m.fromFolderId, rootId);
      moved++;
    } catch {
      failed++;
    }
  })));

  const cleanupOrder = recursive ? [...folders].reverse() : folders;

  let trashed = 0;
  let kept = 0;

  for (const f of cleanupOrder) {
    try {
      const empty = await folderIsEmpty(drive, f.id);
      if (empty) {
        await trashFolder(drive, f.id);
        trashed++;
      } else {
        kept++;
      }
    } catch {
      kept++;
    }
  }

  return { mode, rootId, moved, failed, trashedFolders: trashed, keptFolders: kept };
}

module.exports = { organize, flatten };
