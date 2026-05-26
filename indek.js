const mcJava = require('minecraft-protocol');
const javaRegistryLib = require('prismarine-registry');
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const { EventEmitter } = require('events');

// --- 1. KONFIGURASI & REGISTRY ---
const JAVA_VERSION = '1.15.2';
const javaRegistry = javaRegistryLib(JAVA_VERSION);
const mcData = require('minecraft-data')(JAVA_VERSION);
const ChunkLib = require('prismarine-chunk')(JAVA_VERSION);
const Anvil = require('prismarine-provider-anvil').Anvil(JAVA_VERSION);

const WORLD_NAME = 'InfiniteWorld';
const worldPath = path.join(__dirname, WORLD_NAME);
if (!fs.existsSync(worldPath)) fs.mkdirSync(worldPath, { recursive: true });

const regionPath = path.join(worldPath, 'region');
if (!fs.existsSync(regionPath)) fs.mkdirSync(regionPath, { recursive: true });
const anvil = new Anvil(regionPath);

// --- 2. ENGINE STORAGE & TICK ---
const serverEvents = new EventEmitter();
serverEvents.setMaxListeners(0);

const TPS = 20;
const TICK_INTERVAL = 1000 / TPS;
const entities = {}; 
const mobBehaviors = {}; 
let tickCount = 0;

// Jantung Server
setInterval(() => {
    tickCount++;
    serverEvents.emit('tick', tickCount);
}, TICK_INTERVAL);

// --- 3. GENERATOR DUNIA (Default) ---
// Kita buat variabel let agar bisa di-"override" oleh Mod World
let worldGenerator = (cx, cz) => {
    const chunk = new ChunkLib();
    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            chunk.setBlockType(new Vec3(x, 0, z), javaRegistry.blocksByName.bedrock.id);
            for (let y = 1; y < 4; y++) chunk.setBlockType(new Vec3(x, y, z), javaRegistry.blocksByName.stone.id);
            chunk.setBlockType(new Vec3(x, 4, z), javaRegistry.blocksByName.grass_block.id);
            for (let y = 5; y < 256; y++) chunk.setSkyLight(new Vec3(x, y, z), 15);
        }
    }
    return chunk;
};

// --- 4. SERVER SETUP ---
const server = mcJava.createServer({
    host: '0.0.0.0',
    port: 25565,
    version: JAVA_VERSION,
    'online-mode': false 
});
server.setMaxListeners(0);

// Helper: Broadcast Aman
server.broadcast = (packetName, data) => {
    Object.values(server.clients).forEach(client => {
        if (client && client.state === mcJava.states.PLAY) {
            try { client.write(packetName, data); } catch (e) {}
        }
    });
};

// --- 5. MOD & PLUGIN LOADER SYSTEM ---
const extras = { 
    entities, serverEvents, javaRegistry, mcData, mobBehaviors, anvil, Vec3,
    setWorldGenerator: (newGen) => { worldGenerator = newGen; } // Akses khusus Mod World
};

function loadScripts(folderName, label) {
    const dir = path.join(__dirname, folderName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.readdirSync(dir).forEach(file => {
        if (file.endsWith('.js')) {
            try {
                const scriptPath = path.join(dir, file);
                delete require.cache[require.resolve(scriptPath)];
                const script = require(scriptPath);
                if (typeof script === 'function') {
                    script(server, extras);
                    console.log(`[${label}] Berhasil memuat: ${file}`);
                }
            } catch (err) {
                console.error(`[${label} ERROR] Gagal memuat ${file}:\n`, err.stack);
            }
        }
    });
}

// Urutan pemuatan penting: Mods dulu untuk mengatur core, lalu Plugin
loadScripts('mods/logic', 'MOD-LOGIC');
loadScripts('mods/blocks', 'MOD-BLOCKS');
loadScripts('mods/world', 'MOD-WORLD');
loadScripts('mods/mobs', 'MOD-MOBS');
loadScripts('plugins', 'PLUGIN');

// --- 6. PLAYER CONNECTION ---
server.on('login', async (client) => {
    const loadedChunks = new Set();
    const viewDistance = 4;

    entities[client.id] = {
        id: client.id, uuid: client.uuid, username: client.username,
        pos: new Vec3(0, 20, 0), type: 'player', health: 20
    };

    client.write('login', {
        entityId: client.id, levelType: 'default', gameMode: 1, 
        dimension: 0, hashedSeed: [0, 0], difficulty: 1,
        maxPlayers: 10, reducedDebugInfo: false, enableRespawnScreen: true
    });

    const sendChunkToClient = async (cx, cz) => {
        const key = `${cx},${cz}`;
        if (loadedChunks.has(key)) return;
        try {
            let chunk = await anvil.load(cx, cz);
            if (!chunk) {
                chunk = worldGenerator(cx, cz); // Menggunakan generator yang mungkin sudah diubah Mod
                await anvil.save(cx, cz, chunk);
            }
            client.write('map_chunk', {
                x: cx, z: cz, groundUp: true,
                bitMap: chunk.getMask(), chunkData: chunk.dump(),
                biomes: new Int32Array(1024).fill(1),
                heightmaps: { type: 'compound', name: '', value: { MOTION_BLOCKING: { type: 'longArray', value: new Array(36).fill([0, 0]) } } },
                blockEntities: []
            });
            loadedChunks.add(key);
        } catch (e) { console.error(`Chunk Error:`, e); }
    };

    // Spawn awal
    for (let x = -viewDistance; x <= viewDistance; x++) {
        for (let z = -viewDistance; z <= viewDistance; z++) await sendChunkToClient(x, z);
    }
    client.write('position', { x: 0, y: 20, z: 0, yaw: 0, pitch: 0, flags: 0x00, teleportId: 1 });

    client.on('position', (data) => {
        const ent = entities[client.id];
        if (ent) {
            ent.pos.set(data.x, data.y, data.z);
            server.broadcast('entity_teleport', {
                entityId: client.id, x: data.x, y: data.y, z: data.z,
                yaw: 0, pitch: 0, onGround: data.onGround
            });
            // Auto chunk loading saat jalan
            sendChunkToClient(Math.floor(data.x / 16), Math.floor(data.z / 16));
        }
    });

    client.on('end', () => {
        delete entities[client.id];
        server.broadcast('destroy_entities', { entityIds: [client.id] });
    });
});

console.log(`\n--- SERVER MODDED READY ---`);
console.log(`Versi: ${JAVA_VERSION} | Port: 25565`);

