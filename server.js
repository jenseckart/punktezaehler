const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

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
    
    // Check für Offline-Spieler beim Login
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
        // Host-Check hier optional, aber UI verhindert es eh
        room.players.push({
            id: 'bot-' + Date.now(),
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
            player.id = socket.id;
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

    // --- UPDATE: Schreibschutz ---
    socket.on('submitRound', ({ roomCode, roundScores, userId }) => { // userId wird mitgesendet
        const room = rooms[roomCode];
        if (!room) return;

        // SICHERHEIT: Nur der Host darf schreiben!
        if (room.hostUserId !== userId) {
            socket.emit('errorMsg', 'Nur der Host darf Punkte eintragen!');
            return;
        }

        let zeroCount = 0;
        const parsedScores = {};

        for (let playerId in roundScores) {
            let val = roundScores[playerId];
            let num = (val === '' || val === null) ? 0 : parseInt(val);
            if (isNaN(num)) num = 0;
            if (num === 0) zeroCount++;
            parsedScores[playerId] = num;
        }

        if (zeroCount > 1) {
            socket.emit('errorMsg', 'Maximal eine "0" pro Runde erlaubt!');
            return;
        }

        room.players.forEach(p => {
            const score = parsedScores[p.id] !== undefined ? parsedScores[p.id] : 0;
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
        existingPlayer.id = socket.id;
        socket.join(roomCode);
        socket.emit('gameState', room);
        return;
    }

    // --- UPDATE: Zutritt auch während Spiel (View Only) ---
    // Wir lassen sie rein, fügen sie der Liste hinzu.
    // Da sie aber keine Schreibrechte haben und Score 0 startet, ist das ok.
    // Optional: Wenn man später joint, könnte man "Strafe" bekommen, aber wir starten bei 0.
    
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