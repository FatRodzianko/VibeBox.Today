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

io.engine.use((req, res, next) => {
  if (authorizedRequest(req)) return next();

  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Vibebox", charset="UTF-8"'
  });
  res.end("Password required.");
});

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "rooms.json");
const SEARCH_STATE_FILE = path.join(DATA_DIR, "search-state.json");


const APP_PASSWORD = process.env.APP_PASSWORD || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

function authorizedRequest(req) {
  if (!APP_PASSWORD) return true;

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;

  let suppliedPassword;
  try {
    suppliedPassword = Buffer.from(encoded, "base64")
      .toString("utf8")
      .split(":")
      .slice(1)
      .join(":");
  } catch {
    return false;
  }

  const supplied = Buffer.from(suppliedPassword);
  const expected = Buffer.from(APP_PASSWORD);

  return supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);
}

function requireAppPassword(req, res, next) {
  if (authorizedRequest(req)) return next();

  res.set("WWW-Authenticate", 'Basic realm="Vibebox", charset="UTF-8"');
  res.status(401).send("Password required.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const DEFAULT_VIDEO = {
  id: "0tdyU_gW6WE",
  title: "Bustin' — Neil Cicierega",
  url: "https://www.youtube.com/watch?v=0tdyU_gW6WE"
};

app.use(requireAppPassword);

app.use((req, res, next) => {
  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );
  next();
});

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
function nextPacificMidnight() {
  const now = new Date();

  // Find the next calendar date in America/Los_Angeles, then convert
  // that date's midnight back to a UTC timestamp.
  const pacificDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);

  const [year, month, day] = pacificDate.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));

  // Start with a UTC guess, then adjust it to Pacific midnight.
  let result = Date.UTC(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth(),
    nextDate.getUTCDate()
  );

  for (let i = 0; i < 3; i++) {
    const pacificParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(result));

    const values = Object.fromEntries(
      pacificParts.map(part => [part.type, part.value])
    );

    const representedAsUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    );

    result += Date.UTC(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth(),
      nextDate.getUTCDate()
    ) - representedAsUtc;
  }

  return result;
}

let searchDisabledUntil = 0;

try {
  const saved = JSON.parse(fs.readFileSync(SEARCH_STATE_FILE, "utf8"));
  searchDisabledUntil = Number(saved.searchDisabledUntil) || 0;
} catch {}

function searchEnabled() {
  if (Date.now() >= searchDisabledUntil) {
    searchDisabledUntil = 0;
    return true;
  }
  return false;
}

function setSearchDisabledUntilReset() {
  searchDisabledUntil = nextPacificMidnight();

  fs.writeFileSync(
    SEARCH_STATE_FILE,
    JSON.stringify({ searchDisabledUntil }),
    { mode: 0o600 }
  );

  io.emit("youtube:search-status", {
    enabled: false,
    resetAt: searchDisabledUntil
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
	socket.on("queue:reorder", payload => {
	  const room = findRoom(socket);
	  if (!room || !isAdmin(room, socket.data.userId) || !payload) return;

	  const from = Number(payload.from);
	  const to = Number(payload.to);

	  if (
		!Number.isInteger(from) ||
		!Number.isInteger(to) ||
		from < 0 ||
		to < 0 ||
		from >= room.queue.length ||
		to >= room.queue.length ||
		from === to
	  ) {
		return;
	  }

	  // Keep the currently playing video selected after the move.
	  const currentItem = room.queue[room.currentIndex];
	  const [movedItem] = room.queue.splice(from, 1);
	  room.queue.splice(to, 0, movedItem);
	  room.currentIndex = room.queue.indexOf(currentItem);

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
  socket.on("youtube:search", async (payload = {}, done) => {
  if (typeof done !== "function") return;

  const room = findRoom(socket);
  if (!room || !isAdmin(room, socket.data.userId)) {
    return done({ ok: false, error: "Only admins can search and add videos." });
  }

  if (!searchEnabled()) {
    return done({
      ok: false,
      disabled: true,
      resetAt: searchDisabledUntil,
      error: "YouTube search is unavailable until the daily quota resets."
    });
  }

  const apiKey = YOUTUBE_API_KEY;
  const query = typeof payload.query === "string" ? payload.query.trim() : "";

  if (!apiKey) {
	  return done({ ok: false, error: "YouTube search is not configured on the server." });
	}

  if (query.length < 2 || query.length > 100) {
    return done({ ok: false, error: "Search terms must be 2–100 characters." });
  }

  try {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.search = new URLSearchParams({
      key: apiKey,
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      order: "viewCount",
      maxResults: "10",
      q: query
    });

    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();

    if (!searchResponse.ok) {
      const reason = searchData?.error?.errors?.[0]?.reason;

      if (reason === "quotaExceeded") {
        setSearchDisabledUntilReset();
        return done({
          ok: false,
          disabled: true,
          resetAt: searchDisabledUntil,
          error: "YouTube search quota was reached. Search is disabled for everyone until the daily reset."
        });
      }

      if (reason === "keyInvalid" || searchResponse.status === 400) {
        return done({
          ok: false,
          error: "That API key was rejected. Check that YouTube Data API v3 is enabled for its Google Cloud project."
        });
      }

      return done({
        ok: false,
        error: "YouTube search failed. Check the API key and try again."
      });
    }

        const ids = (searchData.items || [])
      .map(item => item.id?.videoId)
      .filter(Boolean);

    if (!ids.length) {
      return done({ ok: true, results: [] });
    }

    const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    detailsUrl.search = new URLSearchParams({
      key: apiKey,
      part: "snippet,contentDetails,statistics,status",
      id: ids.join(",")
    });

    const detailsResponse = await fetch(detailsUrl);
    const detailsData = await detailsResponse.json();

    if (!detailsResponse.ok) {
      const reason = detailsData?.error?.errors?.[0]?.reason;

      if (reason === "quotaExceeded") {
        setSearchDisabledUntilReset();
        return done({
          ok: false,
          disabled: true,
          resetAt: searchDisabledUntil,
          error: "YouTube search quota was reached. Search is disabled for everyone until the daily reset."
        });
      }

      return done({ ok: false, error: "Could not retrieve video details." });
    }

    function durationSeconds(isoDuration) {
      const match = isoDuration.match(
        /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
      );
      if (!match) return Infinity;

      return (
        Number(match[1] || 0) * 3600 +
        Number(match[2] || 0) * 60 +
        Number(match[3] || 0)
      );
    }

    const results = (detailsData.items || [])
      .map(video => ({
        id: video.id,
        title: video.snippet?.title || `YouTube video (${video.id})`,
        channelTitle: video.snippet?.channelTitle || "",
        durationSeconds: durationSeconds(video.contentDetails?.duration || ""),
        embeddable: video.status?.embeddable === true,
        viewCount: Number(video.statistics?.viewCount || 0)
      }))
      .filter(video =>
        video.embeddable &&
        video.durationSeconds >= 120 &&
        video.durationSeconds <= 900
      )
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 5)
      .map(({ id, title, channelTitle, durationSeconds }) => ({
        id,
        title: title.slice(0, 200),
        channelTitle: channelTitle.slice(0, 100),
        durationSeconds
      }));

    done({ ok: true, results });
	return;

    const suitable = (detailsData.items || [])
      .filter(video => {
        const seconds = durationSeconds(video.contentDetails?.duration || "");
        return (
          video.status?.embeddable === true &&
          seconds >= 120 &&
          seconds <= 900
        );
      })
      .sort(
        (a, b) =>
          Number(b.statistics?.viewCount || 0) -
          Number(a.statistics?.viewCount || 0)
      );

    if (!suitable.length) {
      return done({
        ok: false,
        error: "No embeddable results between 2 and 15 minutes were found."
      });
    }

    const selected = suitable[0];
    const currentRoom = findRoom(socket);

    if (
      !currentRoom ||
      currentRoom.id !== room.id ||
      !isAdmin(currentRoom, socket.data.userId)
    ) {
      return done({ ok: false, error: "You are no longer an admin in this room." });
    }

    const id = selected.id;
    currentRoom.queue.push({
      id,
      title: selected.snippet.title.slice(0, 200),
      url: `https://www.youtube.com/watch?v=${id}`
    });

    save();
    sendRoom(currentRoom);

    done({
      ok: true,
      title: selected.snippet.title,
      id
    });
  } catch {
    done({ ok: false, error: "Could not reach YouTube. Try again." });
  }
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
