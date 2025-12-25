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
    // --- NEU: Vorab-Check für den Login-Screen ---
    socket.on('checkRoom', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            // Sende Liste der verfügbaren (unclaimed) Bot-Spieler
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

    // --- NEU: Offline-Spieler hinzufügen ---
    socket.on('addPlaceholder', ({ roomCode, name }) => {
        const room = rooms[roomCode];
        // Nur Host darf das, oder jeder? Wir lassen es den Host machen.
        // Check via socket.id ist hier einfacher, aber userId sicherer. 
        // Der Einfachheit halber: Wenn Raum in Lobby ist, darf man adden.
        if (!room || room.status !== 'lobby') return;

        room.players.push({
            id: 'bot-' + Date.now(), // Temporäre ID
            userId: null,            // Kein echter User verknüpft
            name: name,
            scores: [],
            total: 0,
            isBot: true              // Markierung
        });
        io.to(roomCode).emit('gameState', room);
    });

    // --- NEU: Spieler übernehmen (Claiming) ---
    socket.on('claimPlayer', ({ roomCode, playerId, userId }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === playerId);
        if (player && player.isBot && !player.userId) {
            // Übernahme!
            player.userId = userId;
            player.id = socket.id; // Socket aktualisieren
            player.isBot = false;  // Ist jetzt ein echter Mensch
            
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

    socket.on('submitRound', ({ roomCode, roundScores }) => {
        const room = rooms[roomCode];
        if (!room) return;

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
            // Wichtig: Auch Bots bekommen Punkte (Host hat sie eingetragen)
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

    if (room.status !== 'lobby') {
        socket.emit('errorMsg', 'Spiel läuft bereits.');
        return;
    }

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