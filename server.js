require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const storageConfig = require('./config/storage');
const mikrotikConfig = require('./config/mikrotik');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes Static File
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API Routes

// 1. Register new user
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, username, password } = req.body;
    
    if (!name || !email || !phone || !username || !password) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }
    
    const existingUser = await storageConfig.getUserByUsername(username);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Username sudah digunakan' });
    }
    
    await storageConfig.addUser({ name, email, phone, username, password });
    
    return res.json({ success: true, message: 'Registrasi berhasil. Silakan tunggu persetujuan admin.' });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ success: false, message: 'Registrasi gagal' });
  }
});

// 2. Get all users (admin panel)
app.get(['/api/users', '/api/admin/users'], async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const users = await storageConfig.getAllUsers();
    
    let mikrotikStats = [];
    try {
      if (mikrotikConfig.getUsersStats && typeof mikrotikConfig.getUsersStats === 'function') {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('MikroTik Timeout')), 2500)
        );
        mikrotikStats = await Promise.race([mikrotikConfig.getUsersStats(), timeoutPromise]);
      }
    } catch (mtErr) {
      mikrotikStats = [];
    }

    const enrichedUsers = (users || []).map(user => {
      const stats = Array.isArray(mikrotikStats) 
        ? mikrotikStats.find(s => s.name === user.username || s.user === user.username) || {} 
        : {};
      
      return {
        ...user,
        bytesIn: parseInt(stats['bytes-in'] || stats.bytesIn || 0),
        bytesOut: parseInt(stats['bytes-out'] || stats.bytesOut || 0),
        uptime: stats.uptime || 'Off'
      };
    });

    return res.json({ success: true, users: enrichedUsers });
  } catch (error) {
    console.error('Error getting users:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengambil data user' });
  }
});

// 3. Approve user (Diperbarui agar memastikan user benar-benar masuk ke MikroTik sebelum sukses)
app.post('/api/approve', async (req, res) => {
  try {
    const { username, adminName } = req.body;
    
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username wajib diisi' });
    }
    
    const userData = await storageConfig.getUserByUsername(username);
    if (!userData) {
      return res.status(404).json({ success: false, message: 'Data user tidak ditemukan di database' });
    }
    
    // Coba masukkan ke MikroTik terlebih dahulu
    const mtResult = await mikrotikConfig.addUserToHotspot(userData.username, userData.password);
    
    if (!mtResult || !mtResult.success) {
      return res.status(500).json({ 
        success: false, 
        message: 'Gagal menambahkan ke MikroTik: ' + (mtResult ? mtResult.message : 'Unknown error') 
      });
    }
    
    // Jika sukses di MikroTik, baru approve di database lokal
    await storageConfig.approveUser(username, adminName || 'Admin');
    
    return res.json({ success: true, message: 'User berhasil disetujui dan ditambahkan ke MikroTik' });
  } catch (error) {
    console.error('Approval error:', error);
    return res.status(500).json({ success: false, message: 'Gagal menyetujui user: ' + error.message });
  }
});

// 4. Reject user
app.post('/api/reject', async (req, res) => {
  try {
    const { username, adminName } = req.body;
    
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username wajib diisi' });
    }
    
    await storageConfig.rejectUser(username, adminName || 'Admin');
    await mikrotikConfig.removeUserFromHotspot(username);
    
    return res.json({ success: true, message: 'User berhasil ditolak' });
  } catch (error) {
    console.error('Rejection error:', error);
    return res.status(500).json({ success: false, message: 'Gagal menolak user' });
  }
});

// 5. Delete user
app.delete('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    await storageConfig.deleteUser(username);
    await mikrotikConfig.removeUserFromHotspot(username);
    
    return res.json({ success: true, message: 'User berhasil dihapus' });
  } catch (error) {
    console.error('Deletion error:', error);
    return res.status(500).json({ success: false, message: 'Gagal menghapus user' });
  }
});

// 6. Admin authentication
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ADMIN_PASSWORD || 'admin')) {
    return res.json({ success: true, message: 'Login admin berhasil' });
  } else {
    return res.status(401).json({ success: false, message: 'Password admin salah' });
  }
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
