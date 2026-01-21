// 局域网同步模块
const SYNC_PORT = 51234;
const SYNC_PROTOCOL = 'substation-sync-v1';
let syncServer = null;
let syncClients = [];
let localDeviceId = generateDeviceId();
let isHosting = false;
let isConnected = false;

// 生成设备唯一ID
function generateDeviceId() {
    const id = localStorage.getItem('deviceId');
    if (id) return id;

    const newId = 'device_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    localStorage.setItem('deviceId', newId);
    return newId;
}

// 获取本地IP地址
async function getLocalIP() {
    return new Promise((resolve) => {
        const ips = [];
        const interfaces = navigator.hardwareConcurrency || 4;

        // 尝试获取本地IP的常见方法
        try {
            constRTCPeerConnection = RTCPeerConnection || webkitRTCPeerConnection;
            if (RTCPeerConnection) {
                const pc = new RTCPeerConnection({iceServers: []});
                pc.createDataChannel('');
                pc.createOffer().then(offer => pc.setLocalDescription(offer));

                pc.onicecandidate = (event) => {
                    if (!event.candidate) {
                        pc.close();
                        resolve(ips.length > 0 ? ips[0] : '192.168.1.100');
                        return;
                    }

                    const candidate = event.candidate.candidate;
                    const ipMatch = candidate.match(/([0-9]{1,3}(\.[0-9]{1,3}){3})/);
                    if (ipMatch && !ips.includes(ipMatch[1])) {
                        ips.push(ipMatch[1]);
                    }
                };

                setTimeout(() => {
                    pc.close();
                    resolve(ips.length > 0 ? ips[0] : '192.168.1.100');
                }, 1000);
            } else {
                resolve('192.168.1.100');
            }
        } catch (e) {
            resolve('192.168.1.100');
        }
    });
}

// WebRTC 连接管理
class SyncConnection {
    constructor(peerId, isInitiator = false) {
        this.peerId = peerId;
        this.isInitiator = isInitiator;
        this.connected = false;
        this.dataChannel = null;
        this.peerConnection = null;

        this.init();
    }

    async init() {
        const config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };

        this.peerConnection = new RTCPeerConnection(config);

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignalingMessage({
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        this.peerConnection.ondatachannel = (event) => {
            this.setupDataChannel(event.channel);
        };

        if (this.isInitiator) {
            this.dataChannel = this.peerConnection.createDataChannel('sync');
            this.setupDataChannel(this.dataChannel);

            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);

            this.sendSignalingMessage({
                type: 'offer',
                sdp: offer
            });
        }
    }

    setupDataChannel(channel) {
        this.dataChannel = channel;
        this.dataChannel.onopen = () => {
            this.connected = true;
            console.log(`与 ${this.peerId} 的连接已建立`);
            onPeerConnected(this.peerId);
        };

        this.dataChannel.onclose = () => {
            this.connected = false;
            console.log(`与 ${this.peerId} 的连接已关闭`);
            onPeerDisconnected(this.peerId);
        };

        this.dataChannel.onmessage = (event) => {
            this.handleMessage(JSON.parse(event.data));
        };
    }

    async handleMessage(message) {
        switch (message.type) {
            case 'sync-data':
                await this.handleSyncData(message.data);
                break;
            case 'sync-request':
                await this.sendSyncData();
                break;
            case 'ping':
                this.send({ type: 'pong' });
                break;
        }
    }

    async handleSyncData(data) {
        try {
            await importData(data);
            await addSyncRecord('receive', {
                from: this.peerId,
                timestamp: new Date().toISOString()
            });
            console.log('同步数据接收成功');
            onSyncComplete(true);
        } catch (error) {
            console.error('同步数据接收失败:', error);
            onSyncComplete(false, error.message);
        }
    }

    async sendSyncData() {
        const data = await exportAllData();
        this.send({
            type: 'sync-data',
            data: data
        });
    }

    send(data) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(JSON.stringify(data));
        }
    }

    sendSignalingMessage(message) {
        // 实际实现中需要信令服务器，这里使用BroadcastChannel作为替代方案
        // 在同一设备的不同标签页间通信
        const channel = new BroadcastChannel(`${SYNC_PROTOCOL}_${this.peerId}`);
        channel.postMessage(message);
        channel.close();
    }

    close() {
        if (this.dataChannel) {
            this.dataChannel.close();
        }
        if (this.peerConnection) {
            this.peerConnection.close();
        }
    }
}

// 使用BroadcastChannel进行同设备多标签页同步
class LocalSyncManager {
    constructor() {
        this.channel = new BroadcastChannel(SYNC_PROTOCOL);
        this.channel.onmessage = (event) => this.handleMessage(event.data);
        this.connections = new Map();
    }

    handleMessage(message) {
        switch (message.type) {
            case 'offer':
                this.handleOffer(message);
                break;
            case 'answer':
                this.handleAnswer(message);
                break;
            case 'ice-candidate':
                this.handleIceCandidate(message);
                break;
            case 'sync-request':
                this.broadcastSyncData();
                break;
        }
    }

    handleOffer(message) {
        // 接收方处理offer
        console.log('收到同步请求');
        onSyncRequest(message.from);
    }

    handleAnswer(message) {
        // 发起方处理answer
    }

    handleIceCandidate(message) {
        // 处理ICE候选
    }

    broadcastSyncData() {
        // 广播同步数据到其他标签页
    }

    async requestSync() {
        // 请求其他设备同步
        this.channel.postMessage({
            type: 'sync-request',
            from: localDeviceId
        });
    }

    async broadcast(data) {
        this.channel.postMessage({
            type: 'sync-data',
            from: localDeviceId,
            data: data
        });
    }

    close() {
        this.channel.close();
    }
}

// 同步事件回调
let onPeerConnected = (peerId) => {};
let onPeerDisconnected = (peerId) => {};
let onSyncRequest = (from) => {};
let onSyncComplete = (success, error) => {};
let onStatusChange = (status) => {};

// 设置同步事件回调
function setSyncCallbacks(callbacks) {
    if (callbacks.onPeerConnected) onPeerConnected = callbacks.onPeerConnected;
    if (callbacks.onPeerDisconnected) onPeerDisconnected = callbacks.onPeerDisconnected;
    if (callbacks.onSyncRequest) onSyncRequest = callbacks.onSyncRequest;
    if (callbacks.onSyncComplete) onSyncComplete = callbacks.onSyncComplete;
    if (callbacks.onStatusChange) onStatusChange = callbacks.onStatusChange;
}

// 开始广播（作为主机）
async function startBroadcast() {
    if (isHosting) return;

    const ip = await getLocalIP();
    localSyncManager = new LocalSyncManager();

    isHosting = true;
    isConnected = true;
    onStatusChange({
        status: 'hosting',
        ip: ip,
        port: SYNC_PORT,
        deviceId: localDeviceId
    });

    console.log(`开始广播同步服务: ${ip}:${SYNC_PORT}`);
    return { ip, port: SYNC_PORT, deviceId: localDeviceId };
}

// 停止广播
function stopBroadcast() {
    if (localSyncManager) {
        localSyncManager.close();
        localSyncManager = null;
    }
    isHosting = false;
    isConnected = false;
    onStatusChange({ status: 'disconnected' });
    console.log('停止广播同步服务');
}

// 发送同步请求到其他设备
async function requestSyncFrom(hostIp, hostPort = SYNC_PORT) {
    if (isHosting) {
        console.warn('作为主机时不能请求同步');
        return false;
    }

    try {
        // 创建WebRTC连接
        const connection = new SyncConnection(hostIp, true);
        syncClients.push(connection);

        isConnected = true;
        onStatusChange({
            status: 'connecting',
            host: hostIp
        });

        console.log(`正在连接到 ${hostIp}:${hostPort}`);
        return true;
    } catch (error) {
        console.error('连接失败:', error);
        isConnected = false;
        onStatusChange({ status: 'disconnected' });
        return false;
    }
}

// 执行同步
async function performSync() {
    if (!isConnected && !isHosting) {
        console.warn('未连接到任何同步服务');
        return false;
    }

    try {
        const data = await exportAllData();

        if (isHosting && localSyncManager) {
            // 广播到其他标签页
            await localSyncManager.broadcast(data);
        }

        // 发送给已连接的WebRTC客户端
        for (const client of syncClients) {
            if (client.connected) {
                client.send({
                    type: 'sync-data',
                    data: data
                });
            }
        }

        console.log('同步数据已发送');
        return true;
    } catch (error) {
        console.error('同步失败:', error);
        return false;
    }
}

// 获取同步状态
function getSyncStatus() {
    return {
        isHosting: isHosting,
        isConnected: isConnected,
        deviceId: localDeviceId,
        localIP: null
    };
}

// 初始化同步管理器
let localSyncManager = null;

// 初始化
async function initSync() {
    const status = getSyncStatus();
    onStatusChange({ status: 'ready', ...status });
}

// 初始化
initSync();
