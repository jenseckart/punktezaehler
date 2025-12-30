const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Datenspeicher (Achtung: Wird bei Server-Neustart geleert!)
const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

io.on('connection', (socket) => {
    
    socket.on('checkRoom', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            const availablePlayers = room.players.filter(p => p.isBot && !p.userId);
            socket.emit('roomInfo', { exists: true, availablePlayers });
        } else {
            socket.emit('roomInfo', { exists: false });
        }
    });

    socket.on('createGame', async ({ hostName, userId }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            round: 1,
            status: 'lobby',
            players: [],
            hostUserId: userId
        };

        const protocol = socket.handshake.headers['x-forwarded-proto'] || 'http';
        const host = socket.handshake.headers.host;
        const joinUrl = `${protocol}://${host}/?room=${roomCode}`;
        const qrCodeData = await QRCode.toDataURL(joinUrl);

        socket.emit('gameCreated', { roomCode, qrCodeData });
        joinRoom(socket, roomCode, hostName, userId);
    });

    socket.on('addPlaceholder', ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        // Bots bekommen eine permanente Bot-ID
        room.players.push({
            id: 'bot-' + Date.now() + Math.random(), // Stable Bot ID (nutzen wir auch als SocketID Placeholder)
            userId: null,
            name: name,
            scores: [],
            total: 0,
            isBot: true
        });
        io.to(roomCode).emit('gameState', room);
    });

    socket.on('claimPlayer', ({ roomCode, playerId, userId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === playerId);
        if (player && player.isBot && !player.userId) {
            player.userId = userId;
            player.id = socket.id; // Live Socket Update
            player.isBot = false;
            socket.join(roomCode);
            io.to(roomCode).emit('gameState', room);
        }
    });

    socket.on('joinGame', ({ roomCode, playerName, userId }) => {
        if (!roomCode || !playerName || !userId) return;
        joinRoom(socket, roomCode.toUpperCase(), playerName, userId);
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            room.status = 'playing';
            io.to(roomCode).emit('gameState', room);
        }
    });

    // --- CRITICAL FIX: STABLE ID MAPPING ---
    socket.on('submitRound', ({ roomCode, roundScores, userId }) => {
        const room = rooms[roomCode];
        
        // 1. Fallback: Server Neustart
        if (!room) {
            socket.emit('errorMsg', 'FEHLER: Raum nicht gefunden (Server Neustart?). Bitte Seite neu laden oder neuen Raum erstellen.');
            return;
        }

        // 2. Security Check
        if (room.hostUserId !== userId) {
            socket.emit('errorMsg', 'Nur der Host darf Punkte eintragen!');
            return;
        }

        let zeroCount = 0;
        const scoresToSave = {};

        // Wir iterieren durch die ECHTEN Spieler im Raum und suchen ihre Punkte im Input
        // Dies verhindert, dass alte IDs oder Müll-Daten verarbeitet werden.
        for (const p of room.players) {
            // Identifier ist userId (für Menschen) oder id (für Bots)
            const stableId = p.userId || p.id;
            
            let val = roundScores[stableId]; // Frontend muss stableId senden!
            
            let num = (val === '' || val === null) ? 0 : parseInt(val);
            if (isNaN(num)) num = 0;
            
            if (num === 0) zeroCount++;
            scoresToSave[p.id] = num; // Temporär speichern
        }

        if (zeroCount > 1) {
            socket.emit('errorMsg', 'Regelverstoß: Maximal eine "0" (oder leeres Feld) pro Runde erlaubt!');
            return;
        }

        // Speichern
        room.players.forEach(p => {
            const score = scoresToSave[p.id]; // Hier nutzen wir den internen Pointer
            p.scores.push(score);
            p.total += score;
        });

        room.round++;
        io.to(roomCode).emit('gameState', room);
    });

    socket.on('finishGame', (roomCode) => {
        const room = rooms[roomCode];
        if(room) {
            room.status = 'finished';
            io.to(roomCode).emit('gameState', room);
        }
    });

    socket.on('restartGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            room.status = 'playing';
            room.round = 1;
            room.players.forEach(p => { p.scores = []; p.total = 0; });
            io.to(roomCode).emit('gameState', room);
        }
    });
});

function joinRoom(socket, roomCode, playerName, userId) {
    const room = rooms[roomCode];
    if (!room) {
        socket.emit('errorMsg', 'Raum nicht gefunden.');
        return;
    }

    const existingPlayer = room.players.find(p => p.userId === userId);
    if (existingPlayer) {
        // Reconnect: Update Socket ID
        existingPlayer.id = socket.id;
        socket.join(roomCode);
        socket.emit('gameState', room);
        return;
    }

    // View Only Join während Spiel
    room.players.push({
        id: socket.id,
        userId: userId,
        name: playerName,
        scores: [],
        total: 0,
        isBot: false
    });

    socket.join(roomCode);
    io.to(roomCode).emit('gameState', room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
