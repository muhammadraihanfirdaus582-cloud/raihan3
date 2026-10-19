require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { Redis } = require('@upstash/redis');
const { RouterOSClient } = require('routeros-client');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. STORAGE CONFIG (Upstash Redis)
// ==========================================
class StorageConfig {
  constructor() {
    this.redisKey = 'hotspot_users_data';
    try {
      this.redis = Redis.fromEnv();
    } catch (err) {
      console.error('Error inisialisasi Upstash Redis:', err.message);
      this.redis = null;
    }
  }

  async getAllUsers() {
    if (!this.redis) return [];
    try {
      const data = await this.redis.get(this.redisKey);
      if (!data) return [];
      
      let parsed = data;
      if (typeof data === 'string') {
        try { parsed = JSON.parse(data); } catch (e) { parsed = []; }
      }
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Error getting users:', error.message);
      return [];
    }
  }

  async addUser(userData) {
    if (!this.redis) throw new Error('Database Redis tidak terhubung');
    try {
      let users = await this.getAllUsers();
      if (!Array.isArray(users)) users = [];
      
      const newUser = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        name: userData.name || userData.username,
        email: userData.email || '-',
        phone: userData.phone || '-',
        username: userData.username,
        password: userData.password,
        status: 'pending',
        approvedAt: '',
        approvedBy: ''
      };

      users.push(newUser);
      await this.redis.set(this.redisKey, JSON.stringify(users));
      console.log('Berhasil menambahkan user ke Redis:', newUser.username);
      
      return newUser;
    } catch (error) {
      console.error('Error adding user:', error.message);
      throw error;
    }
  }

  async getUserByUsername(username) {
    try {
      let users = await this.getAllUsers();
      if (!Array.isArray(users)) users = [];
      return users.find(u => u.username === username) || null;
    } catch (error) {
      console.error('Error getting user by username:', error.message);
      return null;
    }
  }

  async approveUser(username, adminName) {
    if (!this.redis) return null;
    try {
      let users = await this.getAllUsers();
      if (!Array.isArray(users)) users = [];
      const userIndex = users.findIndex(u => u.username === username);
      
      if (userIndex === -1) throw new Error('User not found');
      
      users[userIndex].status = 'approved';
      users[userIndex].approvedAt = new Date().toISOString();
      users[userIndex].approvedBy = adminName;
      
      await this.redis.set(this.redisKey, JSON.stringify(users));
      return users[userIndex];
    } catch (error) {
      console.error('Error approving user:', error.message);
      throw error;
    }
  }

  async rejectUser(username, adminName) {
    if (!this.redis) return null;
    try {
      let users = await this.getAllUsers();
      if (!Array.isArray(users)) users = [];
      const userIndex = users.findIndex(u => u.username === username);
      
      if (userIndex === -1) throw new Error('User not found');
      
      users[userIndex].status = 'rejected';
      users[userIndex].approvedAt = new Date().toISOString();
      users[userIndex].approvedBy = adminName;
      
      await this.redis.set(this.redisKey, JSON.stringify(users));
      return users[userIndex];
    } catch (error) {
      console.error('Error rejecting user:', error.message);
      throw error;
    }
  }

  async deleteUser(username) {
    if (!this.redis) return false;
    try {
      let users = await this.getAllUsers();
      if (!Array.isArray(users)) users = [];
      users = users.filter(u => u.username !== username);
      await this.redis.set(this.redisKey, JSON.stringify(users));
      return true;
    } catch (error) {
      console.error('Error deleting user:', error.message);
      throw error;
    }
  }
}

const storageConfig = new StorageConfig();

// ==========================================
// 2. MIKROTIK CONFIG (RouterOS API Client)
// ==========================================
class MikrotikConfig {
  constructor() {
    this.host = process.env.MIKROTIK_HOST || process.env.MIKROTIK_IP || 'idn27.tunnel.id';
    this.user = process.env.MIKROTIK_USER || process.env.MIKROTIK_API_USER;
    this.password = process.env.MIKROTIK_PASSWORD || process.env.MIKROTIK_API_PASSWORD;
    this.port = parseInt(process.env.MIKROTIK_API_PORT || process.env.MIKROTIK_PORT || '3111', 10);
  }

  getClient() {
    return new RouterOSClient({
      host: this.host,
      port: this.port,
      user: this.user,
      password: this.password,
      timeout: 2500,
      keepalive: false
    });
  }

  async connectClient(client) {
    const connectPromise = client.connect();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('MikroTik API Connection Timeout')), 2500)
    );
    return await Promise.race([connectPromise, timeoutPromise]);
  }

  async addUserToHotspot(username, password, profile = 'default') {
    const client = this.getClient();
    try {
      const api = await this.connectClient(client);
      await api.menu('/ip/hotspot/user').add({
        name: username,
        password: password,
        profile: profile,
        server: 'all'
      });
      console.log(`Berhasil menambahkan user ${username} via API!`);
      return { success: true, message: 'User added to hotspot' };
    } catch (error) {
      console.error('Error adding user via API:', error.message);
      return { success: false, message: error.message };
    } finally {
      try { await client.close(); } catch (e) {}
    }
  }

  async removeUserFromHotspot(username) {
    const client = this.getClient();
    try {
      const api = await this.connectClient(client);
      const userMenu = api.menu('/ip/hotspot/user');
      const users = await userMenu.where('name', username).get();
      
      if (!users || users.length === 0) {
        return { success: false, message: 'User tidak ditemukan di MikroTik' };
      }

      await userMenu.remove(users[0]['.id']);
      return { success: true, message: 'User berhasil dihapus' };
    } catch (error) {
      console.error('Error removing user via API:', error.message);
      return { success: false, message: error.message };
    } finally {
      try { await client.close(); } catch (e) {}
    }
  }

  async getUsersStats() {
    const client = this.getClient();
    try {
      const api = await this.connectClient(client);
      
      const mtUsers = await api.menu('/ip/hotspot/user').get().catch(() => []);
      const mtActive = await api.menu('/ip/hotspot/active').get().catch(() => []);
      
      return mtUsers.map(u => {
        const active = mtActive.find(act => act.user && act.user.toLowerCase() === u.name.toLowerCase());

        const bytesInVal = active
          ? (active['bytes-in'] || active['bytes-in-total'] || active.bytesIn || u['bytes-in'] || u['bytes-in-total'] || 0)
          : (u['bytes-in'] || u['bytes-in-total'] || u.bytesIn || 0);

        const bytesOutVal = active
          ? (active['bytes-out'] || active['bytes-out-total'] || active.bytesOut || u['bytes-out'] || u['bytes-out-total'] || 0)
          : (u['bytes-out'] || u['bytes-out-total'] || u.bytesOut || 0);

        const packetsInVal = active
          ? (active['packets-in'] || active.packetsIn || u['packets-in'] || 0)
          : (u['packets-in'] || u.packetsIn || 0);

        const packetsOutVal = active
          ? (active['packets-out'] || active.packetsOut || u['packets-out'] || 0)
          : (u['packets-out'] || u.packetsOut || 0);

        const uptime = active ? `${active.uptime} (Online)` : (u.uptime || '00:00:00');

        return {
          name: u.name,
          user: u.name,
          uptime: uptime,
          'bytes-in': Number(bytesInVal),
          'bytes-out': Number(bytesOutVal),
          'packets-in': Number(packetsInVal),
          'packets-out': Number(packetsOutVal)
        };
      });
    } catch (error) {
      console.error('Error getting user stats via API:', error.message);
      return [];
    } finally {
      try { await client.close(); } catch (e) {}
    }
  }
}

const mikrotikConfig = new MikrotikConfig();

// ==========================================
// 3. EXPRESS MIDDLEWARE & ROUTES
// ==========================================
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// API Routes
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

app.post('/api/approve', async (req, res) => {
  try {
    const { username, adminName } = req.body;
    
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username wajib diisi' });
    }
    
    await storageConfig.approveUser(username, adminName || 'Admin');
    
    const userData = await storageConfig.getUserByUsername(username);
    if (userData) {
      await mikrotikConfig.addUserToHotspot(userData.username, userData.password);
    }
    
    return res.json({ success: true, message: 'User berhasil disetujui' });
  } catch (error) {
    console.error('Approval error:', error);
    return res.status(500).json({ success: false, message: 'Gagal menyetujui user' });
  }
});

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

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ADMIN_PASSWORD || 'admin')) {
    return res.json({ success: true, message: 'Login admin berhasil' });
  } else {
    return res.status(401).json({ success: false, message: 'Password admin salah' });
  }
});

// ==========================================
// 4. VERCEL SERVERLESS EXPORT & LOCAL LISTEN
// ==========================================
module.exports = (req, res) => {
  return app(req, res);
};

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
