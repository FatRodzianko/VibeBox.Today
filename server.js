const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5
});

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "rooms.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
const DEFAULT_VIDEO = {
  id: "0tdyU_gW6WE",
  title: "Bustin' — Neil Cicierega",
  url: "https://www.youtube.com/watch?v=0tdyU_gW6WE"
};

app.use(express.static(path.join(__dirname, "public")));

// Room URLs (for example, /Test123-ab12cd) serve the app.
app.get("/:roomSlug", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

let rooms = {};
try {
  rooms = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch {
  rooms = {};
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(rooms, null, 2), {
    mode: 0o600
  });
}

function makeId() {
  return crypto.randomBytes(5).toString("hex");
}

function makeSlug(name) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "room";

  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

function validRoomName(name) {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 50 &&
    /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)
  );
}

function cleanName(name) {
  if (typeof name !== "string") return "Guest";
  const cleaned = name.trim().slice(0, 30);
  return cleaned || "Guest";
}

function validUserId(id) {
  return typeof id === "string" && /^[a-f0-9-]{16,80}$/i.test(id);
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function makePassword(password) {
  if (!password) return null;
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: passwordHash(password, salt) };
}

function verifyPassword(password, stored) {
  if (!stored) return true;
  if (typeof password !== "string") return false;

  const candidate = Buffer.from(passwordHash(password, stored.salt), "hex");
  const expected = Buffer.from(stored.hash, "hex");
  return candidate.length === expected.length &&
    crypto.timingSafeEqual(candidate, expected);
}

function videoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host === "youtu.be" || host === "www.youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
      const match = parsed.pathname.match(/^\/(embed|shorts)\/([^/]+)/);
      return match ? match[2] : null;
    }
  } catch {}

  return null;
}

function publicRoom(room) {
  return {
    id: room.id,
    slug: room.slug,
    name: room.name,
    creatorId: room.creatorId,
    defaultRole: room.defaultRole,
    queue: room.queue,
    currentIndex: room.currentIndex,
    playback: room.playback,
    users: Object.values(room.users)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(({ id, name, role, joinedAt }) => ({ id, name, role, joinedAt }))
  };
}

function sendRoom(room) {
  io.to(room.id).emit("room:update", publicRoom(room));
}

function findRoom(socket) {
  const room = rooms[socket.data.roomId];
  if (!room || !room.users[socket.data.userId]) return null;
  return room;
}

function isAdmin(room, userId) {
  return room.users[userId]?.role === "admin";
}

function activeSockets(roomId, userId) {
  return [...io.sockets.sockets.values()].filter(
    socket =>
      socket.connected &&
      socket.data.roomId === roomId &&
      socket.data.userId === userId
  );
}

function removeUser(room, userId) {
  delete room.users[userId];

  if (userId === room.creatorId) {
    const members = Object.values(room.users);
    const successor =
      members
        .filter(user => user.role === "admin")
        .sort((a, b) => a.joinedAt - b.joinedAt)[0] ||
      members.sort((a, b) => a.joinedAt - b.joinedAt)[0];

    if (successor) {
      room.creatorId = successor.id;
      successor.role = "admin";
    }
  }

  if (Object.keys(room.users).length === 0) {
    delete rooms[room.id];
    save();
    return false;
  }

  save();
  sendRoom(room);
  return true;
}

io.on("connection", socket => {
  socket.on("room:create", (payload = {}, done) => {
    if (typeof done !== "function") return;
    const { name, password, defaultRole, userId } = payload;

    if (!validRoomName(name)) {
      return done({
        ok: false,
        error: "Use a room name of 1–50 letters, numbers, spaces, periods, underscores, or hyphens."
      });
    }
    if (!validUserId(userId)) {
      return done({ ok: false, error: "Invalid browser user ID." });
    }
    if (typeof password === "string" && password.length > 128) {
      return done({ ok: false, error: "Room password is too long." });
    }

    const id = makeId();
    const room = {
      id,
      slug: makeSlug(name),
      name,
      password: makePassword(password),
      creatorId: userId,
      defaultRole: defaultRole === "admin" ? "admin" : "regular",
      users: {
        [userId]: {
          id: userId,
          name: cleanName(payload.userName),
          role: "admin",
          joinedAt: Date.now()
        }
      },
      queue: [{ ...DEFAULT_VIDEO }],
      currentIndex: 0,
      playback: { playing: false, position: 0, updatedAt: Date.now() }
    };

    rooms[id] = room;
    socket.join(id);
    socket.data.roomId = id;
    socket.data.userId = userId;
    save();
    done({ ok: true, room: publicRoom(room) });
  });

  socket.on("room:join", (payload = {}, done) => {
    if (typeof done !== "function") return;
    const roomKey = String(payload.roomId || "").toLowerCase().slice(0, 100);
    const room =
      rooms[roomKey] ||
      Object.values(rooms).find(candidate => candidate.slug === roomKey);

    if (!room) return done({ ok: false, error: "Room not found." });
    if (!validUserId(payload.userId)) {
      return done({ ok: false, error: "Invalid browser user ID." });
    }
    if (!verifyPassword(payload.password, room.password)) {
      return done({ ok: false, error: "Incorrect room password." });
    }

    const userId = payload.userId;
    if (!room.users[userId]) {
      room.users[userId] = {
        id: userId,
        name: cleanName(payload.userName),
        role: room.defaultRole,
        joinedAt: Date.now()
      };
    } else {
      room.users[userId].name = cleanName(payload.userName);
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.userId = userId;
    save();
    sendRoom(room);
    done({ ok: true, room: publicRoom(room) });
  });

  socket.on("user:name", name => {
    const room = findRoom(socket);
    if (!room || typeof name !== "string") return;
    room.users[socket.data.userId].name = cleanName(name);
    save();
    sendRoom(room);
  });

  socket.on("queue:add", async url => {
    const room = findRoom(socket);
    if (!room || !isAdmin(room, socket.data.userId)) return;
    if (typeof url !== "string" || url.length > 2048) {
      return socket.emit("app:error", "Please enter a valid YouTube link.");
    }

    const id = videoId(url);
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      return socket.emit("app:error", "That doesn’t look like a valid YouTube link.");
    }

    let title = `YouTube video (${id})`;
    try {
      const response = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${id}`
        )}&format=json`
      );
      if (response.ok) {
        const metadata = await response.json();
        if (typeof metadata.title === "string") {
          title = metadata.title.slice(0, 200);
        }
      }
    } catch {
      // Keep the fallback title if metadata lookup fails.
    }

    const currentRoom = findRoom(socket);
    if (!currentRoom || currentRoom.id !== room.id ||
        !isAdmin(currentRoom, socket.data.userId)) return;

    currentRoom.queue.push({
      id,
      title,
      url: `https://www.youtube.com/watch?v=${id}`
    });
    save();
    sendRoom(currentRoom);
  });

  socket.on("queue:remove", index => {
    const room = findRoom(socket);
    if (!room || !isAdmin(room, socket.data.userId)) return;

    index = Number(index);
    if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) return;

    room.queue.splice(index, 1);
    if (room.queue.length === 0) {
      room.queue.push({ ...DEFAULT_VIDEO });
      room.currentIndex = 0;
      room.playback = { playing: false, position: 0, updatedAt: Date.now() };
    } else if (index < room.currentIndex) {
      room.currentIndex--;
    } else if (index === room.currentIndex) {
      room.currentIndex = Math.min(room.currentIndex, room.queue.length - 1);
      room.playback = { playing: false, position: 0, updatedAt: Date.now() };
    }

    save();
    sendRoom(room);
  });

  socket.on("playback:control", payload => {
    const room = findRoom(socket);
    if (!room || !isAdmin(room, socket.data.userId) || !payload) return;

    if (payload.action === "skip") {
      if (!room.queue.length) return;
      room.currentIndex = (room.currentIndex + 1) % room.queue.length;
      room.playback = { playing: true, position: 0, updatedAt: Date.now() };
    } else if (payload.action === "play" || payload.action === "pause") {
      const position = Number(payload.position);
      room.playback = {
        playing: payload.action === "play",
        position: Number.isFinite(position) ? Math.max(0, Math.min(position, 86400)) : 0,
        updatedAt: Date.now()
      };
    } else {
      return;
    }

    save();
    sendRoom(room);
  });

  socket.on("user:role", payload => {
    const room = findRoom(socket);
    if (!room || !payload || !isAdmin(room, socket.data.userId)) return;

    const target = room.users[payload.targetId];
    if (!target || target.id === room.creatorId) return;

    if (payload.role === "admin") {
      target.role = "admin";
    } else if (
      payload.role === "regular" &&
      socket.data.userId === room.creatorId
    ) {
      target.role = "regular";
    } else {
      return;
    }

    save();
    sendRoom(room);
  });

  socket.on("user:kick", targetId => {
    const room = findRoom(socket);
    if (!room || !isAdmin(room, socket.data.userId)) return;

    const target = room.users[targetId];
    if (!target || target.id === room.creatorId) return;
    if (target.role === "admin" && socket.data.userId !== room.creatorId) return;

    for (const client of activeSockets(room.id, targetId)) {
      client.emit("room:kicked");
      client.leave(room.id);
      client.data.roomId = null;
    }

    removeUser(room, targetId);
  });

  socket.on("room:leave", () => {
    leaveSocketRoom(socket);
  });

  socket.on("disconnect", () => {
    leaveSocketRoom(socket);
  });
});

function leaveSocketRoom(socket) {
  const roomId = socket.data.roomId;
  const userId = socket.data.userId;
  if (!roomId || !userId) return;

  const room = rooms[roomId];
  socket.leave(roomId);
  socket.data.roomId = null;

  // Keep the user present if they still have another connected tab.
  if (activeSockets(roomId, userId).length > 0) return;
  if (room && room.users[userId]) removeUser(room, userId);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Vibebox listening on port ${PORT}`);
});
