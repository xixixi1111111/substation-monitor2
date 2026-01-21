// IndexedDB 本地数据存储模块
const DB_NAME = 'SubstationMonitorDB';
const DB_VERSION = 1;
let db = null;

// 初始化数据库
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error('数据库打开失败:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('数据库初始化成功');
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // 变电站表
            if (!db.objectStoreNames.contains('substations')) {
                const substationStore = db.createObjectStore('substations', { keyPath: 'id', autoIncrement: true });
                substationStore.createIndex('name', 'name', { unique: true });
                substationStore.createIndex('createdAt', 'createdAt', { unique: false });
            }

            // 机子信息表
            if (!db.objectStoreNames.contains('machines')) {
                const machineStore = db.createObjectStore('machines', { keyPath: 'id', autoIncrement: true });
                machineStore.createIndex('substationId', 'substationId', { unique: false });
                machineStore.createIndex('position', 'substationId', { unique: false });
                machineStore.createIndex('updatedAt', 'updatedAt', { unique: false });
            }

            // 图片存储表
            if (!db.objectStoreNames.contains('images')) {
                const imageStore = db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
                imageStore.createIndex('machineId', 'machineId', { unique: false });
            }

            // 同步记录表
            if (!db.objectStoreNames.contains('syncRecords')) {
                const syncStore = db.createObjectStore('syncRecords', { keyPath: 'id', autoIncrement: true });
                syncStore.createIndex('timestamp', 'timestamp', { unique: false });
                syncStore.createIndex('type', 'type', { unique: false });
            }
        };
    });
}

// 获取数据库实例
async function getDB() {
    if (!db) {
        await initDB();
    }
    return db;
}

// ============ 变电站操作 ============

// 获取所有变电站
async function getAllSubstations() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['substations'], 'readonly');
        const store = transaction.objectStore('substations');
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 添加变电站
async function addSubstation(name) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['substations'], 'readwrite');
        const store = transaction.objectStore('substations');

        const substation = {
            name: name.trim(),
            createdAt: new Date().toISOString()
        };

        const request = store.add(substation);

        request.onsuccess = () => {
            resolve({ id: request.result, ...substation });
        };
        request.onerror = (event) => {
            if (event.target.error.name === 'ConstraintError') {
                reject(new Error('变电站名称已存在'));
            } else {
                reject(event.target.error);
            }
        };
    });
}

// 删除变电站
async function deleteSubstation(id) {
    const db = await getDB();
    return new Promise(async (resolve, reject) => {
        try {
            // 先删除该变电站下的所有机子
            await deleteMachinesBySubstationId(id);

            const transaction = db.transaction(['substations'], 'readwrite');
            const store = transaction.objectStore('substations');
            const request = store.delete(id);

            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        } catch (error) {
            reject(error);
        }
    });
}

// ============ 机子操作 ============

// 获取变电站的所有机子
async function getMachinesBySubstationId(substationId) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['machines'], 'readonly');
        const store = transaction.objectStore('machines');
        const index = store.index('substationId');
        const request = index.getAll(substationId);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 根据位置获取机子
async function getMachineByPosition(substationId, positionX, positionY) {
    const machines = await getMachinesBySubstationId(substationId);
    return machines.find(m => m.positionX === positionX && m.positionY === positionY);
}

// 添加或更新机子
async function saveMachine(substationId, positionX, positionY, name, info, imageData = null) {
    const db = await getDB();
    return new Promise(async (resolve, reject) => {
        try {
            // 检查是否已存在
            const existingMachine = await getMachineByPosition(substationId, positionX, positionY);

            const transaction = db.transaction(['machines', 'images'], 'readwrite');
            const machineStore = transaction.objectStore('machines');
            const imageStore = transaction.objectStore('images');

            let machineId;
            let imageId = null;

            // 保存图片（如果存在）
            if (imageData) {
                const imageRecord = {
                    machineId: existingMachine?.id,
                    data: imageData,
                    timestamp: new Date().toISOString()
                };
                const imageRequest = imageStore.add(imageRecord);
                imageRequest.onsuccess = () => {
                    imageId = imageRequest.result;
                };
            }

            const machineData = {
                substationId: substationId,
                positionX: positionX,
                positionY: positionY,
                name: name || '',
                info: info || '',
                imageId: imageId,
                updatedAt: new Date().toISOString()
            };

            if (existingMachine) {
                machineData.id = existingMachine.id;
                machineData.createdAt = existingMachine.createdAt;
                const request = machineStore.put(machineData);
                request.onsuccess = () => {
                    machineId = request.result;
                    resolve({ id: machineId, ...machineData });
                };
            } else {
                machineData.createdAt = new Date().toISOString();
                const request = machineStore.add(machineData);
                request.onsuccess = () => {
                    machineId = request.result;
                    resolve({ id: machineId, ...machineData });
                };
            }

            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });
}

// 获取机子详情
async function getMachine(machineId) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['machines', 'images'], 'readonly');
        const machineStore = transaction.objectStore('machines');
        const imageStore = transaction.objectStore('images');
        const request = machineStore.get(machineId);

        request.onsuccess = async () => {
            const machine = request.result;
            if (machine && machine.imageId) {
                const imageRequest = imageStore.get(machine.imageId);
                imageRequest.onsuccess = () => {
                    machine.imageData = imageRequest.result?.data || null;
                    resolve(machine);
                };
                imageRequest.onerror = () => resolve(machine);
            } else {
                resolve(machine);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

// 删除机子
async function deleteMachine(machineId) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['machines', 'images'], 'readwrite');
        const machineStore = transaction.objectStore('machines');
        const imageStore = transaction.objectStore('images');

        // 先获取机子信息，找到关联的图片
        const getRequest = machineStore.get(machineId);
        getRequest.onsuccess = () => {
            const machine = getRequest.result;
            if (machine && machine.imageId) {
                imageStore.delete(machine.imageId);
            }
            const deleteRequest = machineStore.delete(machineId);
            deleteRequest.onsuccess = () => resolve(true);
            deleteRequest.onerror = () => reject(deleteRequest.error);
        };
        getRequest.onerror = () => reject(getRequest.error);
    });
}

// 根据变电站ID删除所有机子
async function deleteMachinesBySubstationId(substationId) {
    const machines = await getMachinesBySubstationId(substationId);
    for (const machine of machines) {
        await deleteMachine(machine.id);
    }
}

// ============ 同步操作 ============

// 记录同步
async function addSyncRecord(type, data) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['syncRecords'], 'readwrite');
        const store = transaction.objectStore('syncRecords');

        const record = {
            type: type,
            data: data,
            timestamp: new Date().toISOString()
        };

        const request = store.add(record);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 获取所有同步记录
async function getAllSyncRecords() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['syncRecords'], 'readonly');
        const store = transaction.objectStore('syncRecords');
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 清空同步记录
async function clearSyncRecords() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['syncRecords'], 'readwrite');
        const store = transaction.objectStore('syncRecords');
        const request = store.clear();

        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
    });
}

// ============ 导出/导入数据 ============

// 导出所有数据
async function exportAllData() {
    const substations = await getAllSubstations();
    const machines = [];
    const db = await getDB();

    for (const substation of substations) {
        const subMachines = await getMachinesBySubstationId(substation.id);
        machines.push(...subMachines);
    }

    return {
        version: DB_VERSION,
        exportDate: new Date().toISOString(),
        substations: substations,
        machines: machines
    };
}

// 导入数据
async function importData(data) {
    const db = await getDB();
    return new Promise(async (resolve, reject) => {
        try {
            const transaction = db.transaction(['substations', 'machines', 'images'], 'readwrite');

            // 清空现有数据
            transaction.objectStore('substations').clear();
            transaction.objectStore('machines').clear();
            transaction.objectStore('images').clear();

            // 导入变电站
            for (const substation of data.substations) {
                const newSubstation = { ...substation };
                delete newSubstation.id;
                await new Promise((res, rej) => {
                    const request = transaction.objectStore('substations').add(newSubstation);
                    request.onsuccess = () => res();
                    request.onerror = () => rej(request.error);
                });
            }

            // 导入机子
            for (const machine of data.machines) {
                const newMachine = { ...machine };
                delete newMachine.id;
                await new Promise((res, rej) => {
                    const request = transaction.objectStore('machines').add(newMachine);
                    request.onsuccess = () => res();
                    request.onerror = () => rej(request.error);
                });
            }

            transaction.oncomplete = () => resolve(true);
            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });
}

// 初始化数据库
initDB().catch(console.error);
