const showdown = require("showdown"),
  bodyParser = require("body-parser"),
  express = require("express"),
  nocache = require("nocache"),
  fs = require("fs"),
  dotenv = require("dotenv"),
  path = require("path"),
  storage = require('node-persist'),
  { glob } = require('glob'),
  //drivelist = require('drivelist'),
  { createServer } = require('http'),
  { Server } = require('socket.io');

dotenv.config({ path: path.join(__dirname, ".env") });

storage.init();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

let displayState = {
  view: 'setlist',
  filename: null,
  songName: null,
  scrollPercent: 0,
  selectedSong: null,
  selectedIndex: -1,
  screenW: 1920,
  screenH: 1080,
  dpr: 1,
};

io.on('connection', (socket) => {
  socket.emit('state:update', displayState);

  socket.on('identify', ({ role }) => {
    socket.join(role);
  });

  socket.on('pi:state', (state) => {
    displayState = { ...displayState, ...state };
    socket.to('remote').emit('state:update', displayState);
  });

  socket.on('remote:navigate', (data) => {
    io.to('pi').emit('command:navigate', data);
  });

  socket.on('remote:scroll', (data) => {
    io.to('pi').emit('command:scroll', data);
  });

  socket.on('remote:goto', (data) => {
    io.to('pi').emit('command:goto', data);
  });

  socket.on('remote:setlist', () => {
    io.to('pi').emit('command:setlist');
  });
});

showdown.extension("lyrics", function () {
  return [
    {
      type: "output",
      regex: /~([\w]+)[^>]*~([^]+?)~\/\1~/gi,
      replace: '<div class="$1" markdown="1">$2</div>',
    },
    {
      type: "output",
      regex: /=([\w]+)=(.*?)=\/\1=/gs,
      replace: '<span style="color: $1" markdown="1">$2</span>',
    },
    {
      type: "lang",
      regex: /##\/([\w]+)[^\n#]*##/gi,
      replace: "</div>",
    },
    {
      type: "lang",
      regex: /##([\w]+)[^\n#]*##/gi,
      replace: '<div class="$1" markdown="1">',
    },
  ];
});

const Converter = new showdown.Converter({
  extensions: ["lyrics"],
  metadata: true,
});

app.use(nocache());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");

app.use("/public", express.static(path.join(__dirname, "public")));

const config = {
  port: process.env.PORT || 8080,
  keycodes: {
    left: process.env.KEYCODE_LEFT || 37,
    middle: process.env.KEYCODE_MIDDLE || 40,
    right: process.env.KEYCODE_RIGHT || 39,
  },
  css:
    `--highlight-color: ${process.env.HIGHLIGHT_COLOR || "yellow"};` +
    `--refrain-color: ${process.env.REFRAIN_COLOR || "yellow"};` +
    `--bridge-color: ${process.env.BRIDGE_COLOR || "orange"};` +
    `--font-size: ${process.env.FONT_SIZE || "30px"};`,
};

const SETLISTS_DIR = path.join(__dirname, "setlists");
const DELETED_DIR = "deleted";

function isDeleted(setlistPath) {
  return setlistPath.split(/[\\/]/).includes(DELETED_DIR);
}

// Returns `base`, or `base-2`, `base-3`, ... if that path is taken
function uniquePath(base) {
  let target = base;
  for (let i = 2; fs.existsSync(target); i++) {
    target = `${base}-${i}`;
  }
  return target;
}

// Moves the setlist's directory into a "deleted" folder next to it,
// so it drops out of getSetlists() but can still be restored by hand.
function moveSetlistToDeleted(setlistPath) {
  const dir = path.dirname(setlistPath);
  const deletedDir = path.join(path.dirname(dir), DELETED_DIR);
  fs.mkdirSync(deletedDir, { recursive: true });
  fs.renameSync(dir, uniquePath(path.join(deletedDir, path.basename(dir))));
}

// Today's local date as YYYY-MM-DD
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Copies the setlist's directory (manifest and songs) to a directory named
// after today's date next to it. Returns the new path.
function duplicateSetlist(setlistPath) {
  const dir = path.dirname(setlistPath);
  const target = uniquePath(path.join(path.dirname(dir), today()));
  fs.cpSync(dir, target, { recursive: true });
  return path.join(target, path.basename(setlistPath));
}

// Creates an empty setlist in a directory named after today's date.
// Returns the new path.
function createEmptySetlist() {
  const target = uniquePath(path.join(SETLISTS_DIR, today()));
  fs.mkdirSync(target, { recursive: true });
  const setlistPath = path.join(target, "setlist.json");
  fs.writeFileSync(setlistPath, JSON.stringify({ songs: [] }, null, 4) + "\n");
  return setlistPath;
}

async function getSetlists() {
  console.log("Load setlists...");

  let setlists = [];

  let files = await glob(`${SETLISTS_DIR}/**/setlist.json`);
  files.filter(f => !isDeleted(f)).forEach(f => setlists.push(f));

  let drives = []; //await drivelist.list();

  for (const drive of drives) {
    if (drive.isSystem == false) {
      let files = await glob(`${drive.mountpoints[0].path}/**/setlist.json`)
      files.filter(f => !isDeleted(f)).forEach(f => setlists.push(f));
    }
  }

  setlists.sort();
  console.log(setlists);
  return setlists;
}

// Writes `setlist` to setlistPath, keeping the indentation and line endings
// of `raw` (the file's previous content) so diffs stay small
function writeSetlistLike(setlistPath, raw, setlist) {
  const indent = (raw.match(/^([ \t]+)"/m) || [, "  "])[1];
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const json = JSON.stringify(setlist, null, indent).replace(/\n/g, eol);
  fs.writeFileSync(setlistPath, json + (/\r?\n$/.test(raw) ? eol : ""));
}

// Songs removed from a setlist are kept directly in the deleted directory,
// with their names in songs.json ({ "<filename>": "<name>" }).
const DELETED_SONGS_DIR = path.join(SETLISTS_DIR, DELETED_DIR);
const DELETED_SONGS_NAMES = path.join(DELETED_SONGS_DIR, "songs.json");

function readDeletedSongNames() {
  try {
    return JSON.parse(fs.readFileSync(DELETED_SONGS_NAMES, "utf-8"));
  } catch {
    return {};
  }
}

// Moves a song file into the deleted directory's root, overwriting an
// existing file with the same name, and remembers its name for the song library
function moveSongToDeleted(songPath, name) {
  fs.mkdirSync(DELETED_SONGS_DIR, { recursive: true });
  const target = path.join(DELETED_SONGS_DIR, path.basename(songPath));
  // Copy + delete instead of rename, so it also works across drives
  fs.copyFileSync(songPath, target);
  fs.unlinkSync(songPath);

  const names = readDeletedSongNames();
  names[path.basename(songPath)] = name;
  fs.writeFileSync(DELETED_SONGS_NAMES, JSON.stringify(names, null, 4) + "\n");
}

// A song file in the deleted directory's root (not in a deleted setlist)
function isDeletedSong(file) {
  return path.resolve(path.dirname(file)) === path.resolve(DELETED_SONGS_DIR);
}

// All song files (*.md) in the setlists directory, including removed songs
// but not deleted setlists, once per filename (the most recently changed
// copy wins), sorted by name. The name comes from a setlist.json that lists
// the file, or from the deleted directory's songs.json.
async function getSongLibrary() {
  const names = new Map();
  for (const [filename, name] of Object.entries(readDeletedSongNames())) {
    names.set(path.resolve(DELETED_SONGS_DIR, filename), name);
  }
  for (const setlistPath of await glob(`${SETLISTS_DIR}/**/setlist.json`)) {
    if (isDeleted(setlistPath)) continue;
    try {
      const dir = path.resolve(path.dirname(setlistPath));
      for (const s of JSON.parse(fs.readFileSync(setlistPath, "utf-8")).songs || []) {
        if (s.filename && s.name) names.set(path.join(dir, s.filename), s.name);
      }
    } catch (error) {
      console.log("Skipping unreadable setlist", setlistPath, error.message);
    }
  }

  const byFilename = new Map();
  for (const file of await glob(`${SETLISTS_DIR}/**/*.md`)) {
    if (isDeleted(file) && !isDeletedSong(file)) continue;
    const full = path.resolve(file);
    const song = {
      source: path.relative(SETLISTS_DIR, full).split(path.sep).join("/"),
      filename: path.basename(full),
      name: names.get(full) || path.basename(full, ".md"),
      mtime: fs.statSync(full).mtimeMs,
    };
    const existing = byFilename.get(song.filename);
    if (!existing || song.mtime > existing.mtime) {
      byFilename.set(song.filename, song);
    }
  }

  return Array.from(byFilename.values())
    .map(({ source, filename, name }) => ({ source, filename, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

async function tryGetSetlistPath() {
  return await storage.getItem('setlist');
}

async function getSetlistPath() {
  const setlistPath = await tryGetSetlistPath();
  if (!setlistPath) {
    throw new Error("Missing setlist path");
  }
  return setlistPath;
}

function getSetlistName(setlistPath) {
  return path.basename(path.dirname(setlistPath));
}

async function getSetlist() {
  const setlistPath = await getSetlistPath();
  const data = fs.readFileSync(setlistPath, "utf-8");
  return { ...JSON.parse(data), name: getSetlistName(setlistPath) };
}

async function getLyrics(filename) {
  const setlistPath = await getSetlistPath();
  const songPath = setlistPath.replace("setlist.json", filename);
  const data = fs.readFileSync(songPath, "utf-8");
  return Converter.makeHtml(data.replace(/^[^~.+\r?\n].*.+\r?\n/gm, "$&<br>\r\n"))
}

async function getMetadata(filename) {
  const setlistPath = await getSetlistPath();
  const songPath = setlistPath.replace("setlist.json", filename);
  fs.readFileSync(songPath, "utf-8");
  return Converter.getMetadata();
}

// Pauses (`{ "pause": true }`) are only shown on the setlist page,
// so song navigation skips them.
function getSongInSetlist(filename, setlist, i) {
  const songs = setlist.songs.filter((x) => !x.pause);
  const index = songs.findIndex((x) => x.filename == filename);
  return songs[index + i];
}

async function safeSongPath(filename) {
  if (!filename.endsWith('.md')) {
    throw new Error('Only .md files allowed');
  }
  // Use the same resolution strategy as getLyrics: replace setlist.json with filename
  const setlistPath = await getSetlistPath();
  const songPath = path.resolve(setlistPath.replace("setlist.json", filename));
  const setlistDir = path.resolve(path.dirname(setlistPath));
  if (!songPath.startsWith(setlistDir + path.sep) && songPath !== setlistDir) {
    throw new Error('Invalid path');
  }
  return songPath;
}

// --- Pi display routes ---

app.get("/", async(req, res) => {
  try {
    let setlist = await getSetlist();
    res.render("setlist", {
      setlist,
      // Offered in the "Add Song" overlay
      library: await getSongLibrary(),
      keycodes: config.keycodes,
      fontSize: config.fontSize,
      css: config.css,
    });
  } catch (error) {
    console.log(error);
    res.redirect(`/setlists?error=${error}`);
  }
});

app.get("/setlists", async (req, res) => {
  const setlists = await getSetlists();
  const setlistPath = await tryGetSetlistPath();
  const selectedIndex = setlists.indexOf(setlistPath);
  res.render("setlists", {
    keycodes: config.keycodes,
    error: req.query.error,
    setlists: setlists.map(getSetlistName),
    selectedIndex,
    css: config.css,
  });
});

app.post("/setlists", async (req, res) => {
  const setlists = await getSetlists();
  const setlist = setlists[req.body.setlist];
  console.log(setlist);

  await storage.setItem('setlist', setlist);

  res.redirect(`/`);
});

app.post("/setlists/delete", async (req, res) => {
  const setlists = await getSetlists();
  const setlist = setlists[req.body.setlist];
  if (setlist) {
    console.log("Delete setlist", setlist);
    moveSetlistToDeleted(setlist);
    if (setlist === await tryGetSetlistPath()) {
      await storage.removeItem('setlist');
    }
  }

  res.redirect(`/setlists`);
});

app.post("/setlists/duplicate", async (req, res) => {
  const setlists = await getSetlists();
  const setlist = setlists[req.body.setlist];
  if (!setlist) {
    return res.redirect(`/setlists`);
  }

  console.log("Duplicate setlist", setlist);
  await redirectToSetlist(res, duplicateSetlist(setlist));
});

app.post("/setlists/create", async (req, res) => {
  console.log("Create empty setlist");
  await redirectToSetlist(res, createEmptySetlist());
});

// Back to the setlists page with the given setlist highlighted
async function redirectToSetlist(res, setlistPath) {
  const target = path.resolve(setlistPath);
  const index = (await getSetlists()).findIndex(p => path.resolve(p) === target);
  res.redirect(`/setlists?selected=${index}`);
}

// --- Remote UI route ---

app.get("/remote", (req, res) => {
  res.render("remote");
});

// --- REST API routes ---

app.get("/api/state", (req, res) => {
  res.json(displayState);
});

app.get("/api/setlists", async (req, res) => {
  try {
    const setlistPaths = await getSetlists();
    const result = setlistPaths.map(p => ({ path: p, name: getSetlistName(p) }));
    const selectedPath = await tryGetSetlistPath();
    res.json({ setlists: result, selectedPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/setlist/select", async (req, res) => {
  try {
    const { path: selectedPath } = req.body;
    const setlistPaths = await getSetlists();
    if (!setlistPaths.includes(selectedPath)) {
      return res.status(400).json({ error: 'Invalid setlist path' });
    }
    await storage.setItem('setlist', selectedPath);
    io.emit('state:update', { ...displayState, view: 'setlist', filename: null, songName: null });
    io.to('pi').emit('command:setlist');
    res.json({ ok: true, name: getSetlistName(selectedPath) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/setlist", async (req, res) => {
  try {
    const setlist = await getSetlist();
    const setlistPath = await getSetlistPath();
    res.json({ ...setlist, path: setlistPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/setlist/reorder", async (req, res) => {
  try {
    const { songs } = req.body;
    const setlistPath = await getSetlistPath();
    const setlist = JSON.parse(fs.readFileSync(setlistPath, "utf-8"));
    setlist.songs = songs;
    fs.writeFileSync(setlistPath, JSON.stringify(setlist, null, 2));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reorders the active setlist's entries, keeping each one as it is on disk.
// `order` lists the entries' current indices in their new order (indices,
// not filenames, because pauses have no filename). Used by the Pi's
// setlist page to move a song.
app.post("/api/setlist/order", async (req, res) => {
  try {
    const { order } = req.body;
    const setlistPath = await getSetlistPath();
    const raw = fs.readFileSync(setlistPath, "utf-8");
    const setlist = JSON.parse(raw);

    const count = setlist.songs.length;
    const isPermutation = Array.isArray(order)
      && order.length === count
      && new Set(order).size === count
      && order.every(i => Number.isInteger(i) && i >= 0 && i < count);
    if (!isPermutation) {
      return res.status(400).json({ error: 'Order must contain every entry of the setlist exactly once' });
    }

    setlist.songs = order.map(i => setlist.songs[i]);
    writeSetlistLike(setlistPath, raw, setlist);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adds a pause to the active setlist right after the entry at index `after`,
// or at the end if `after` is missing or out of range. Returns its index.
app.post("/api/setlist/pause/add", async (req, res) => {
  try {
    const { after } = req.body;
    const setlistPath = await getSetlistPath();
    const raw = fs.readFileSync(setlistPath, "utf-8");
    const setlist = JSON.parse(raw);
    const valid = Number.isInteger(after) && after >= 0 && after < setlist.songs.length;
    const index = valid ? after + 1 : setlist.songs.length;
    setlist.songs.splice(index, 0, { pause: true });
    writeSetlistLike(setlistPath, raw, setlist);
    res.json({ ok: true, index });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Removes the entry at `index` (a song or pause) from the active setlist.
// A song's file is moved to the deleted directory's root, overwriting an
// existing file there, unless the setlist still contains the song.
// Returns the index to highlight next.
app.post("/api/setlist/entry/remove", async (req, res) => {
  try {
    const { index } = req.body;
    const setlistPath = await getSetlistPath();
    const raw = fs.readFileSync(setlistPath, "utf-8");
    const setlist = JSON.parse(raw);
    if (!(Number.isInteger(index) && index >= 0 && index < setlist.songs.length)) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    const [entry] = setlist.songs.splice(index, 1);
    writeSetlistLike(setlistPath, raw, setlist);

    // Keep the file while another entry of this setlist still uses it
    const stillUsed = setlist.songs.some(s => s.filename === entry.filename);
    if (entry.filename && !stillUsed) {
      const songPath = path.join(path.dirname(setlistPath), path.basename(entry.filename));
      if (fs.existsSync(songPath)) {
        moveSongToDeleted(songPath, entry.name || path.basename(entry.filename, ".md"));
      }
    }

    res.json({ ok: true, index: Math.min(index, setlist.songs.length - 1) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adds a song from the song library (see getSongLibrary) to the active
// setlist, right after the entry at index `after`, or at the end if `after`
// is missing or out of range. `source` is the song file's path relative to
// SETLISTS_DIR. The file is copied into the active setlist's directory if it
// isn't there. Returns the new entry's index.
app.post("/api/setlist/song/add-from-library", async (req, res) => {
  try {
    const song = (await getSongLibrary()).find(s => s.source === req.body.source);
    if (!song) {
      return res.status(400).json({ error: 'Unknown song' });
    }

    const setlistPath = await getSetlistPath();
    const target = path.join(path.dirname(setlistPath), song.filename);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(SETLISTS_DIR, song.source), target);
    }

    const raw = fs.readFileSync(setlistPath, "utf-8");
    const setlist = JSON.parse(raw);
    const { after } = req.body;
    const valid = Number.isInteger(after) && after >= 0 && after < setlist.songs.length;
    const index = valid ? after + 1 : setlist.songs.length;
    setlist.songs.splice(index, 0, { name: song.name, filename: song.filename });
    writeSetlistLike(setlistPath, raw, setlist);
    res.json({ ok: true, index });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/setlist/song/add", async (req, res) => {
  try {
    const { name, filename } = req.body;
    const setlistPath = await getSetlistPath();
    const setlist = JSON.parse(fs.readFileSync(setlistPath, "utf-8"));
    setlist.songs.push({ name, filename });
    fs.writeFileSync(setlistPath, JSON.stringify(setlist, null, 2));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/setlist/song/remove", async (req, res) => {
  try {
    const { filename } = req.body;
    const setlistPath = await getSetlistPath();
    const setlist = JSON.parse(fs.readFileSync(setlistPath, "utf-8"));
    setlist.songs = setlist.songs.filter(s => s.filename !== filename);
    fs.writeFileSync(setlistPath, JSON.stringify(setlist, null, 2));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/song/:filename", async (req, res) => {
  try {
    const songPath = await safeSongPath(req.params.filename);
    const content = fs.readFileSync(songPath, "utf-8");
    res.json({ content });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/song/:filename", async (req, res) => {
  try {
    const songPath = await safeSongPath(req.params.filename);
    const { content } = req.body;
    fs.writeFileSync(songPath, content);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/song/:filename/preview", async (req, res) => {
  try {
    const html = await getLyrics(req.params.filename);
    res.json({ html });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/setlist/create", async (req, res) => {
  try {
    const { name } = req.body;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dirPath = path.join(SETLISTS_DIR, `setlist-${slug}`);
    if (fs.existsSync(dirPath)) {
      return res.status(400).json({ error: 'Setlist directory already exists' });
    }
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, 'setlist.json'), JSON.stringify({ songs: [] }, null, 2));
    res.json({ ok: true, path: path.join(dirPath, 'setlist.json') });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/setlist", async (req, res) => {
  try {
    const { path: targetPath } = req.body;
    const selectedPath = await tryGetSetlistPath();
    if (targetPath === selectedPath) {
      return res.status(400).json({ error: 'Cannot delete the currently active setlist' });
    }
    const setlistPaths = await getSetlists();
    if (!setlistPaths.includes(targetPath)) {
      return res.status(400).json({ error: 'Invalid setlist path' });
    }
    moveSetlistToDeleted(targetPath);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Must be last — catch-all for song filenames
app.get("/:filename", async (req, res) => {
  try {
    const setlist = await getSetlist();
    const lyrics = await getLyrics(req.params.filename);
    const metadata = await getMetadata(req.params.filename);
    res.render("song", {
      lyrics: lyrics,
      song: getSongInSetlist(req.params.filename, setlist, 0),
      nextSong: getSongInSetlist(req.params.filename, setlist, 1),
      prevSong: getSongInSetlist(req.params.filename, setlist, -1),
      setlist: setlist,
      keycodes: config.keycodes,
      fontSize: config.fontSize,
      flex: metadata.flex === "true",
      css: config.css,
    });
  } catch (error) {
    console.log(error);
    res.redirect(`/setlists?error=${error}`);
  }
});

httpServer.listen(config.port, () => {
  console.log(`Server is up and running on port ${config.port}`);
});
