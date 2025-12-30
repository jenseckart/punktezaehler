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
    
    socket.on('checkRoom', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            // Nur echte Spieler (keine Bots, keine Zuschauer) anzeigen, die übernommen werden können
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
        
        room.players.push({
            id: 'bot-' + Date.now() + Math.random(),
            userId: null,
            name: name,
            scores: [],
            total: 0,
            isBot: true,
            isSpectator: false
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

    socket.on('submitRound', ({ roomCode, roundScores, userId }) => {
        const room = rooms[roomCode];
        
        if (!room) {
            socket.emit('errorMsg', 'FEHLER: Raum nicht gefunden. Bitte Seite neu laden.');
            return;
        }

        if (room.hostUserId !== userId) {
            socket.emit('errorMsg', 'Nur der Host darf Punkte eintragen!');
            return;
        }

        // --- FIX: Nur AKTIVE Spieler validieren (Zuschauer ignorieren) ---
        const activePlayers = room.players.filter(p => !p.isSpectator);
        
        let zeroCount = 0;
        const scoresToSave = {};

        for (const p of activePlayers) {
            const stableId = p.userId || p.id;
            let val = roundScores[stableId];
            
            let num = (val === '' || val === null) ? 0 : parseInt(val);
            if (isNaN(num)) num = 0;
            
            if (num === 0) zeroCount++;
            scoresToSave[p.id] = num;
        }

        if (zeroCount > 1) {
            socket.emit('errorMsg', 'Regelverstoß: Maximal eine "0" (oder leeres Feld) pro Runde erlaubt!');
            return;
        }

        // Speichern (nur für aktive Spieler)
        activePlayers.forEach(p => {
            const score = scoresToSave[p.id];
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
            // Alle Scores resetten, aber Spieler behalten
            room.players.forEach(p => { 
                p.scores = []; 
                p.total = 0; 
                // Optional: Zuschauer kicken oder zu Spielern machen? 
                // Wir lassen sie Zuschauer bleiben, außer sie rejoinen neu.
            });
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

    // --- FIX: Unterscheidung Spieler vs. Zuschauer ---
    const isSpectator = (room.status === 'playing');

    room.players.push({
        id: socket.id,
        userId: userId,
        name: playerName,
        scores: [],
        total: 0,
        isBot: false,
        isSpectator: isSpectator // NEU: Flag setzen
    });

    socket.join(roomCode);
    io.to(roomCode).emit('gameState', room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
