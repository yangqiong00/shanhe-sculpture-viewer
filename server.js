const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MODELS_DIR = process.env.MODELS_DIR || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'models') : path.join(__dirname, 'models'));
const COVERS_DIR = process.env.COVERS_DIR || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'covers') : path.join(__dirname, 'covers'));
const JWT_SECRET = process.env.JWT_SECRET || 'shanhe-craft-sculpture-viewer-2026';

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

// Database setup
const db = new Database(path.join(DATA_DIR, 'sculptures.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sculptures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    model_file TEXT NOT NULL,
    default_width REAL DEFAULT 84,
    default_height REAL DEFAULT 225,
    default_depth REAL DEFAULT 80,
    unit TEXT DEFAULT 'cm',
    thumbnail TEXT DEFAULT '',
    cover_image TEXT DEFAULT '',
    rotation_x REAL DEFAULT 0,
    rotation_y REAL DEFAULT 0,
    rotation_z REAL DEFAULT 0,
    model_color TEXT DEFAULT '#f0f0f0',
    created_at TEXT DEFAULT (datetime('now','+8 hours'))
  )
`);

// Migration: add new columns to existing tables
const newCols = [
  ['cover_image', "TEXT DEFAULT ''"],
  ['rotation_x', 'REAL DEFAULT 0'],
  ['rotation_y', 'REAL DEFAULT 0'],
  ['rotation_z', 'REAL DEFAULT 0'],
  ['model_color', "TEXT DEFAULT '#f0f0f0'"]
];
for (const [col, def] of newCols) {
  try { db.exec(`ALTER TABLE sculptures ADD COLUMN ${col} ${def}`); } catch (e) { /* column exists */ }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/models', express.static(MODELS_DIR));
app.use('/covers', express.static(COVERS_DIR));

// Multer for file uploads - model files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'cover') cb(null, COVERS_DIR);
    else cb(null, MODELS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${name}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    const modelExts = ['.obj', '.fbx', '.glb', '.gltf', '.stl'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'cover' && imageExts.includes(ext)) {
      cb(null, true);
    } else if (file.fieldname === 'model' && modelExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file format: ${ext}`));
    }
  }
});
const uploadFields = upload.fields([
  { name: 'model', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]);

// Auth middleware
function authRequired(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Please login first' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Login expired, please login again' });
  }
}

// ========== API Routes ==========

// Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASS = process.env.ADMIN_PASS || 'shanhe2026';
  if (password === ADMIN_PASS) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 });
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Check auth
app.get('/api/auth', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ authenticated: false });
  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

// List all sculptures
app.get('/api/sculptures', (req, res) => {
  const sculptures = db.prepare('SELECT * FROM sculptures ORDER BY created_at DESC').all();
  res.json(sculptures);
});

// Get single sculpture
app.get('/api/sculptures/:id', (req, res) => {
  const sculpture = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(req.params.id);
  if (!sculpture) return res.status(404).json({ error: 'Sculpture not found' });
  res.json(sculpture);
});

// Upload model file and/or cover image
app.post('/api/upload', authRequired, uploadFields, (req, res) => {
  const result = {};
  if (req.files?.model?.[0]) {
    result.model = {
      filename: req.files.model[0].filename,
      originalname: req.files.model[0].originalname,
      size: req.files.model[0].size,
      path: `/models/${req.files.model[0].filename}`
    };
  }
  if (req.files?.cover?.[0]) {
    result.cover = {
      filename: req.files.cover[0].filename,
      originalname: req.files.cover[0].originalname,
      size: req.files.cover[0].size,
      path: `/covers/${req.files.cover[0].filename}`
    };
  }
  if (!result.model && !result.cover) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json(result);
});

// Create sculpture
app.post('/api/sculptures', authRequired, (req, res) => {
  const { name, description, model_file, default_width, default_height, default_depth, unit,
          cover_image, rotation_x, rotation_y, rotation_z, model_color } = req.body;
  if (!name || !model_file) {
    return res.status(400).json({ error: 'Name and model file are required' });
  }
  const result = db.prepare(
    `INSERT INTO sculptures (name, description, model_file, default_width, default_height, default_depth, unit,
     cover_image, rotation_x, rotation_y, rotation_z, model_color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, description || '', model_file, default_width || 84, default_height || 225, default_depth || 80, unit || 'cm',
        cover_image || '', rotation_x || 0, rotation_y || 0, rotation_z || 0, model_color || '#f0f0f0');
  const sculpture = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(result.lastInsertRowid);
  res.json(sculpture);
});

// Update sculpture
app.put('/api/sculptures/:id', authRequired, (req, res) => {
  const { name, description, default_width, default_height, default_depth, unit,
          cover_image, rotation_x, rotation_y, rotation_z, model_color } = req.body;
  db.prepare(
    `UPDATE sculptures SET name=?, description=?, default_width=?, default_height=?, default_depth=?, unit=?,
     cover_image=?, rotation_x=?, rotation_y=?, rotation_z=?, model_color=? WHERE id=?`
  ).run(name, description || '', default_width, default_height, default_depth, unit || 'cm',
        cover_image || '', rotation_x || 0, rotation_y || 0, rotation_z || 0, model_color || '#f0f0f0', req.params.id);
  const sculpture = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(req.params.id);
  res.json(sculpture);
});

// Delete sculpture
app.delete('/api/sculptures/:id', authRequired, (req, res) => {
  const sculpture = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(req.params.id);
  if (sculpture) {
    // Delete model file
    const modelPath = path.join(MODELS_DIR, sculpture.model_file);
    if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
    // Delete cover image
    if (sculpture.cover_image) {
      const coverPath = path.join(COVERS_DIR, sculpture.cover_image);
      if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    }
    db.prepare('DELETE FROM sculptures WHERE id = ?').run(req.params.id);
  }
  res.json({ success: true });
});

// Error handler for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Max 100MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// ========== Seed demo data if empty ==========
const count = db.prepare('SELECT COUNT(*) as c FROM sculptures').get();
if (count.c === 0) {
  // Check if we have the sample OBJ model
  const sampleDir = path.join(__dirname, '..', '3d_models', 'L0-0_1-FO-22_JugoplastikaSandala 2');
  const sampleObj = path.join(sampleDir, 'L0-0_1-FO-22_JugoplastikaSandala.obj');
  if (fs.existsSync(sampleObj)) {
    const destFile = 'L0-0_1-FO-22_JugoplastikaSandala.obj';
    fs.copyFileSync(sampleObj, path.join(MODELS_DIR, destFile));
    db.prepare(
      'INSERT INTO sculptures (name, description, model_file, default_width, default_height, default_depth) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'Jugoplastika Sandala Sculpture',
      'Large-scale custom fiberglass sculpture - Abstract art installation',
      destFile,
      84, 225, 80
    );
    console.log('✓ Seeded demo sculpture from sample OBJ model');
  }
}

// Copy logo if available
const logoSrc = path.join(__dirname, '..', 'logo_shanhe.jpg');
const logoDest = path.join(__dirname, 'public', 'logo.jpg');
if (fs.existsSync(logoSrc) && !fs.existsSync(logoDest)) {
  fs.copyFileSync(logoSrc, logoDest);
}

app.listen(PORT, () => {
  console.log(`\n🏛  SHANHE CRAFT Sculpture Viewer`);
  console.log(`   Server running at http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`   Admin password: shanhe2026\n`);
});
