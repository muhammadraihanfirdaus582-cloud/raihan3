const { RouterOSClient } = require('routeros-client');

class MikrotikConfig {
  constructor() {
    this.host = process.env.MIKROTIK_HOST || process.env.MIKROTIK_IP || 'idn27.tunnel.id';
    this.user = process.env.MIKROTIK_USER || process.env.MIKROTIK_API_USER;
    this.password = process.env.MIKROTIK_PASSWORD || process.env.MIKROTIK_API_PASSWORD; // Diperbaiki: ditambah titik koma
    // Mengutamakan MIKROTIK_API_PORT agar tidak bentrok dengan PORT bawaan Vercel
    this.port = parseInt(process.env.MIKROTIK_API_PORT || process.env.MIKROTIK_PORT || '3111', 10);
  }

  getClient() {
    return new RouterOSClient({
      host: this.host,
      port: this.port,
      user: this.user,
      password: this.password,
      timeout: 5000, // Dinaikkan ke 5 detik untuk menghindari timeout cepat di Vercel/tunnel
      keepalive: false
    });
  }

  // Helper untuk membatasi waktu koneksi agar tidak hang
  async connectClient(client) {
    const connectPromise = client.connect();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('MikroTik API Connection Timeout ( > 5s )')), 5000)
    );
    return await Promise.race([connectPromise, timeoutPromise]);
  }

  // 1. Tambah User ke Hotspot MikroTik
  async addUserToHotspot(username, password, profile = 'default') {
    const client = this.getClient();
    try {
      const api = await this.connectClient(client);
      
      // Cek dulu apakah user sudah ada sebelumnya untuk menghindari duplikasi error
      const userMenu = api.menu('/ip/hotspot/user');
      const existingUsers = await userMenu.where('name', username).get().catch(() => []);
      
      if (existingUsers && existingUsers.length > 0) {
        console.log(`User ${username} sudah ada di MikroTik.`);
        return { success: true, message: 'User already exists in MikroTik' };
      }

      await userMenu.add({
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

  // 2. Hapus User dari Hotspot MikroTik
  async removeUserFromHotspot(username) {
    const client = this.getClient();
    try {
      const api = await this.connectClient(client);
      const userMenu = api.menu('/ip/hotspot/user');
      const users = await userMenu.where('name', username).get().catch(() => []);
      
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

  // 3. Ambil Statistik User
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

module.exports = new MikrotikConfig();
