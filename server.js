const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Statische Dateien aus dem "public" Ordner bereitstellen
app.use(express.static(path.join(__dirname, 'public')));

// Speicher für alle aktiven Räume
// Struktur: { "ABCD": { code, round, status, players: [], hostUserId: "user_..." } }
const rooms = {};

// Hilfsfunktion: Zufälligen Raum-Code generieren
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Lesbare Zeichen
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

io.on('connection', (socket) => {
    console.log('Verbindung:', socket.id);

    // 1. SPIEL ERSTELLEN
    socket.on('createGame', async ({ hostName, userId }) => {
        const roomCode = generateRoomCode();
        
        rooms[roomCode] = {
            code: roomCode,
            round: 1,
            status: 'lobby', // 'lobby', 'playing', 'finished'
            players: [],
            hostUserId: userId // Wir speichern die permanente ID des Hosts
        };

        // QR Code generieren
        const protocol = socket.handshake.headers['x-forwarded-proto'] || 'http';
        const host = socket.handshake.headers.host;
        const joinUrl = `${protocol}://${host}/?room=${roomCode}`;
        const qrCodeData = await QRCode.toDataURL(joinUrl);

        socket.emit('gameCreated', { roomCode, qrCodeData });
        
        // Host tritt dem Raum direkt bei
        joinRoom(socket, roomCode, hostName, userId);
    });

    // 2. BEITRETEN (ODER REJOIN)
    socket.on('joinGame', ({ roomCode, playerName, userId }) => {
        if (!roomCode || !playerName || !userId) return;
        joinRoom(socket, roomCode.toUpperCase(), playerName, userId);
    });

    // 3. STARTEN
    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Sicherheitscheck: Nur der Host darf starten (via userId prüfen)
        // Wir suchen den Spieler, der zum aktuellen Socket gehört
        const player = room.players.find(p => p.id === socket.id);
        
        if (player && player.userId === room.hostUserId) {
            room.status = 'playing';
            io.to(roomCode).emit('gameState', room);
        }
    });

    // 4. RUNDE EINTRAGEN
    socket.on('submitRound', ({ roomCode, roundScores }) => {
        const room = rooms[roomCode];
        if (!room) return;

        let zeroCount = 0;
        const parsedScores = {};

        // Daten säubern und validieren
        for (let playerId in roundScores) {
            let val = roundScores[playerId];
            let num = (val === '' || val === null) ? 0 : parseInt(val);
            if (isNaN(num)) num = 0;
            
            if (num === 0) zeroCount++;
            parsedScores[playerId] = num;
        }

        // Golf-Regel Check: Max eine 0
        if (zeroCount > 1) {
            socket.emit('errorMsg', 'Regelverstoß: Maximal eine "0" (oder leeres Feld) pro Runde erlaubt!');
            return;
        }

        // Punkte speichern
        room.players.forEach(p => {
            const score = parsedScores[p.id] !== undefined ? parsedScores[p.id] : 0;
            p.scores.push(score);
            p.total += score;
        });

        room.round++;
        io.to(roomCode).emit('gameState', room);
    });

    // 5. BEENDEN
    socket.on('finishGame', (roomCode) => {
        const room = rooms[roomCode];
        const player = room?.players.find(p => p.id === socket.id);
        
        if (player && player.userId === room.hostUserId) {
            room.status = 'finished';
            io.to(roomCode).emit('gameState', room);
        }
    });

    // 6. NEUSTART
    socket.on('restartGame', (roomCode) => {
        const room = rooms[roomCode];
        const player = room?.players.find(p => p.id === socket.id);

        if (player && player.userId === room.hostUserId) {
            room.status = 'playing';
            room.round = 1;
            room.players.forEach(p => {
                p.scores = [];
                p.total = 0;
            });
            io.to(roomCode).emit('gameState', room);
        }
    });
});

// ZENTRALE RAUM-LOGIK MIT REJOIN
function joinRoom(socket, roomCode, playerName, userId) {
    const room = rooms[roomCode];
    if (!room) {
        socket.emit('errorMsg', 'Raum nicht gefunden.');
        return;
    }

    // A: Existiert der Spieler schon? (Rejoin Check via userId)
    const existingPlayer = room.players.find(p => p.userId === userId);

    if (existingPlayer) {
        // Spieler ist bekannt -> Socket aktualisieren
        existingPlayer.id = socket.id; 
        socket.join(roomCode);
        
        // Sofort aktuellen Stand senden
        socket.emit('gameState', room);
        return;
    }

    // B: Neuer Spieler
    if (room.status !== 'lobby') {
        socket.emit('errorMsg', 'Spiel läuft bereits. Kein Beitritt mehr möglich.');
        return;
    }

    // Neuen Spieler anlegen
    room.players.push({
        id: socket.id,       // Technischer Socket (wechselt bei Reload)
        userId: userId,      // Permanente ID (bleibt gleich)
        name: playerName,
        scores: [],
        total: 0
    });

    socket.join(roomCode);
    io.to(roomCode).emit('gameState', room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));