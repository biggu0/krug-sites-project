export type StoredPhoto = {id: string; fileKey: string};
export type StoredTransform = {scale: number; x: number; y: number; rotation: number};
export type StoredOrder = {
  id: string;
  name: string;
  cover: StoredPhoto;
  preview?: StoredPhoto;
  photos: StoredPhoto[];
  arrangementIds: string[];
  transforms: Record<string, StoredTransform>;
  status: 'pending' | 'ready';
  sheetMatched: boolean;
  sku?: string;
  warehouse?: string;
  quantity: number;
};
export type WorkspaceSnapshot = {
  date: string;
  updatedAt: number;
  selectedId: string;
  includeOrderInfo: boolean;
  orderSheet: Record<string, {customId: string; sku: string; warehouse: string; quantity: number}>;
  orders: StoredOrder[];
};
export type BatchArchive = Omit<WorkspaceSnapshot, 'date'> & {
  id: string;
  name: string;
  createdAt: number;
};
export type BatchArchiveMeta = Pick<BatchArchive, 'id' | 'name' | 'createdAt' | 'updatedAt'> & {
  orderCount: number;
};
export type WorkspaceOrderInput = Omit<
  StoredOrder,
  'cover' | 'preview' | 'photos' | 'arrangementIds'
> & {
  cover: {id: string; file: File};
  preview?: {id: string; file: File};
  photos: Array<{id: string; file: File}>;
  arrangement: Array<{id: string}>;
};

const DB_VERSION = 2,
  SNAPSHOT_STORE = 'snapshots',
  BATCH_STORE = 'batches',
  FILE_STORE = 'files';
const dayKey = (time = Date.now()) => new Date(time).toLocaleDateString('sv-SE');
const fileKey = (file: File) =>
  [file.webkitRelativePath || file.name, file.size, file.lastModified].join('|');

function openDatabase(scope: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const safeScope =
        scope
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '_') || 'default',
      request = indexedDB.open(`jht-order-workspace-${safeScope}`, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (request.oldVersion < 2 && db.objectStoreNames.contains(SNAPSHOT_STORE))
        db.deleteObjectStore(SNAPSHOT_STORE);
      if (!db.objectStoreNames.contains(BATCH_STORE))
        db.createObjectStore(BATCH_STORE, {keyPath: 'id'});
      if (!db.objectStoreNames.contains(FILE_STORE))
        db.createObjectStore(FILE_STORE, {keyPath: 'key'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地恢复数据库打开失败'));
  });
}
function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地恢复数据读取失败'));
  });
}
function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('本地恢复数据保存失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('本地恢复数据保存已中止'));
  });
}

export async function saveWorkspaceSnapshot(
  scope: string,
  orders: WorkspaceOrderInput[],
  selectedId: string,
  includeOrderInfo: boolean,
  orderSheet: WorkspaceSnapshot['orderSheet'],
  retentionDays = 3
) {
  const db = await openDatabase(scope),
    transaction = db.transaction([SNAPSHOT_STORE, FILE_STORE], 'readwrite'),
    snapshots = transaction.objectStore(SNAPSHOT_STORE),
    files = transaction.objectStore(FILE_STORE),
    storedOrders: StoredOrder[] = orders.map((order) => {
      const all = [order.cover, ...order.photos, ...(order.preview ? [order.preview] : [])];
      for (const photo of all) {
        const key = fileKey(photo.file);
        files.put({
          key,
          file: photo.file,
          name: photo.file.name,
          type: photo.file.type,
          lastModified: photo.file.lastModified,
          relativePath: photo.file.webkitRelativePath
        });
      }
      return {
        ...order,
        cover: {id: order.cover.id, fileKey: fileKey(order.cover.file)},
        preview: order.preview
          ? {id: order.preview.id, fileKey: fileKey(order.preview.file)}
          : undefined,
        photos: order.photos.map((photo) => ({id: photo.id, fileKey: fileKey(photo.file)})),
        arrangementIds: order.arrangement.map((photo) => photo.id)
      };
    });
  snapshots.put({
    date: dayKey(),
    updatedAt: Date.now(),
    selectedId,
    includeOrderInfo,
    orderSheet,
    orders: storedOrders
  } satisfies WorkspaceSnapshot);
  await transactionDone(transaction);
  db.close();
  await pruneWorkspaceSnapshots(scope, retentionDays);
}

export async function loadLatestWorkspaceSnapshot(scope: string, retentionDays = 3) {
  await pruneWorkspaceSnapshots(scope, retentionDays);
  const db = await openDatabase(scope),
    transaction = db.transaction([SNAPSHOT_STORE, FILE_STORE], 'readonly'),
    snapshots = (await requestResult(
      transaction.objectStore(SNAPSHOT_STORE).getAll()
    )) as WorkspaceSnapshot[],
    latest = snapshots.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!latest) {
    db.close();
    return null;
  }
  const keys = new Set<string>();
  latest.orders.forEach((order) => {
    keys.add(order.cover.fileKey);
    order.photos.forEach((photo) => keys.add(photo.fileKey));
    if (order.preview) keys.add(order.preview.fileKey);
  });
  const storedFiles = new Map<string, File>();
  for (const key of keys) {
    const record = (await requestResult(transaction.objectStore(FILE_STORE).get(key))) as
      | {file: Blob; name: string; type: string; lastModified: number; relativePath?: string}
      | undefined;
    if (record)
      storedFiles.set(
        key,
        new File([record.file], record.name, {type: record.type, lastModified: record.lastModified})
      );
  }
  await transactionDone(transaction);
  db.close();
  return {snapshot: latest, files: storedFiles};
}

export async function deleteOrderFromSnapshots(scope: string, orderId: string, retentionDays = 3) {
  const db = await openDatabase(scope),
    transaction = db.transaction(SNAPSHOT_STORE, 'readwrite'),
    store = transaction.objectStore(SNAPSHOT_STORE),
    snapshots = (await requestResult(store.getAll())) as WorkspaceSnapshot[];
  snapshots.forEach((snapshot) =>
    store.put({
      ...snapshot,
      orders: snapshot.orders.filter((order) => order.id !== orderId),
      selectedId: snapshot.selectedId === orderId ? '' : snapshot.selectedId
    })
  );
  await transactionDone(transaction);
  db.close();
  await pruneWorkspaceSnapshots(scope, retentionDays);
}

export async function clearWorkspaceSnapshots(scope: string) {
  const db = await openDatabase(scope),
    transaction = db.transaction([SNAPSHOT_STORE, FILE_STORE], 'readwrite');
  transaction.objectStore(SNAPSHOT_STORE).clear();
  transaction.objectStore(FILE_STORE).clear();
  await transactionDone(transaction);
  db.close();
}

export async function pruneWorkspaceSnapshots(scope: string, retentionDays = 3) {
  const db = await openDatabase(scope),
    transaction = db.transaction([SNAPSHOT_STORE, FILE_STORE], 'readwrite'),
    snapshotStore = transaction.objectStore(SNAPSHOT_STORE),
    fileStore = transaction.objectStore(FILE_STORE),
    snapshots = (await requestResult(snapshotStore.getAll())) as WorkspaceSnapshot[],
    cutoff = Date.now() - Math.max(1, retentionDays) * 86400000,
    kept = snapshots.filter((snapshot) => snapshot.updatedAt >= cutoff);
  snapshots
    .filter((snapshot) => snapshot.updatedAt < cutoff)
    .forEach((snapshot) => snapshotStore.delete(snapshot.date));
  const used = new Set<string>();
  kept.forEach((snapshot) =>
    snapshot.orders.forEach((order) => {
      used.add(order.cover.fileKey);
      order.photos.forEach((photo) => used.add(photo.fileKey));
      if (order.preview) used.add(order.preview.fileKey);
    })
  );
  const keys = await requestResult(fileStore.getAllKeys());
  keys.filter((key) => !used.has(String(key))).forEach((key) => fileStore.delete(key));
  await transactionDone(transaction);
  db.close();
}

function storeOrders(orders: WorkspaceOrderInput[], files: IDBObjectStore) {
  return orders.map((order) => {
    const all = [order.cover, ...order.photos, ...(order.preview ? [order.preview] : [])];
    for (const photo of all) {
      const key = fileKey(photo.file);
      files.put({
        key,
        file: photo.file,
        name: photo.file.name,
        type: photo.file.type,
        lastModified: photo.file.lastModified
      });
    }
    return {
      ...order,
      cover: {id: order.cover.id, fileKey: fileKey(order.cover.file)},
      preview: order.preview
        ? {id: order.preview.id, fileKey: fileKey(order.preview.file)}
        : undefined,
      photos: order.photos.map((photo) => ({id: photo.id, fileKey: fileKey(photo.file)})),
      arrangementIds: order.arrangement.map((photo) => photo.id)
    } as StoredOrder;
  });
}
export async function listBatchArchives(scope: string) {
  const db = await openDatabase(scope),
    transaction = db.transaction(BATCH_STORE, 'readonly'),
    items = (await requestResult(transaction.objectStore(BATCH_STORE).getAll())) as BatchArchive[];
  await transactionDone(transaction);
  db.close();
  return items
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(
      (item) =>
        ({
          id: item.id,
          name: item.name,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          orderCount: item.orders.length
        }) satisfies BatchArchiveMeta
    );
}
export async function saveBatchArchive(
  scope: string,
  input: {
    id?: string;
    name: string;
    orders: WorkspaceOrderInput[];
    selectedId: string;
    includeOrderInfo: boolean;
    orderSheet: WorkspaceSnapshot['orderSheet'];
  }
) {
  const db = await openDatabase(scope),
    transaction = db.transaction([BATCH_STORE, FILE_STORE], 'readwrite'),
    batches = transaction.objectStore(BATCH_STORE),
    files = transaction.objectStore(FILE_STORE),
    id = input.id ?? crypto.randomUUID(),
    now = Date.now(),
    archive: BatchArchive = {
      id,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      selectedId: input.selectedId,
      includeOrderInfo: input.includeOrderInfo,
      orderSheet: input.orderSheet,
      orders: storeOrders(input.orders, files)
    };
  batches.put(archive);
  await transactionDone(transaction);
  db.close();
  return {
    id,
    name: archive.name,
    createdAt: archive.createdAt,
    updatedAt: archive.updatedAt,
    orderCount: archive.orders.length
  } satisfies BatchArchiveMeta;
}
export async function loadBatchArchive(scope: string, id: string) {
  const db = await openDatabase(scope),
    transaction = db.transaction([BATCH_STORE, FILE_STORE], 'readonly'),
    archive = (await requestResult(transaction.objectStore(BATCH_STORE).get(id))) as
      BatchArchive | undefined;
  if (!archive) {
    db.close();
    return null;
  }
  const keys = new Set<string>();
  archive.orders.forEach((order) => {
    keys.add(order.cover.fileKey);
    order.photos.forEach((photo) => keys.add(photo.fileKey));
    if (order.preview) keys.add(order.preview.fileKey);
  });
  const files = new Map<string, File>();
  for (const key of keys) {
    const record = (await requestResult(transaction.objectStore(FILE_STORE).get(key))) as
      {file: Blob; name: string; type: string; lastModified: number} | undefined;
    if (record)
      files.set(
        key,
        new File([record.file], record.name, {type: record.type, lastModified: record.lastModified})
      );
  }
  await transactionDone(transaction);
  db.close();
  return {archive, files};
}
export async function deleteBatchArchive(scope: string, id: string) {
  const db = await openDatabase(scope),
    transaction = db.transaction([BATCH_STORE, FILE_STORE], 'readwrite'),
    batches = transaction.objectStore(BATCH_STORE),
    files = transaction.objectStore(FILE_STORE);
  batches.delete(id);
  const remaining = (await requestResult(batches.getAll())) as BatchArchive[],
    used = new Set<string>();
  remaining.forEach((batch) =>
    batch.orders.forEach((order) => {
      used.add(order.cover.fileKey);
      order.photos.forEach((photo) => used.add(photo.fileKey));
      if (order.preview) used.add(order.preview.fileKey);
    })
  );
  const keys = await requestResult(files.getAllKeys());
  keys.filter((key) => !used.has(String(key))).forEach((key) => files.delete(key));
  await transactionDone(transaction);
  db.close();
}
export async function deleteBatchArchives(scope: string, ids: string[]) {
  const db = await openDatabase(scope),
    transaction = db.transaction([BATCH_STORE, FILE_STORE], 'readwrite'),
    batches = transaction.objectStore(BATCH_STORE),
    files = transaction.objectStore(FILE_STORE);
  ids.forEach((id) => batches.delete(id));
  const remaining = (await requestResult(batches.getAll())) as BatchArchive[],
    used = new Set<string>();
  remaining.forEach((batch) =>
    batch.orders.forEach((order) => {
      used.add(order.cover.fileKey);
      order.photos.forEach((photo) => used.add(photo.fileKey));
      if (order.preview) used.add(order.preview.fileKey);
    })
  );
  const keys = await requestResult(files.getAllKeys());
  keys.filter((key) => !used.has(String(key))).forEach((key) => files.delete(key));
  await transactionDone(transaction);
  db.close();
}
export async function renameBatchArchive(scope: string, id: string, name: string) {
  const db = await openDatabase(scope),
    transaction = db.transaction(BATCH_STORE, 'readwrite'),
    store = transaction.objectStore(BATCH_STORE),
    archive = (await requestResult(store.get(id))) as BatchArchive | undefined;
  if (!archive) {
    db.close();
    throw new Error('找不到该批次存档');
  }
  store.put({...archive, name, updatedAt: Date.now()});
  await transactionDone(transaction);
  db.close();
}
