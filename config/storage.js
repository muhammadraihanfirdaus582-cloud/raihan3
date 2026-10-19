const { Redis } = require('@upstash/redis');

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
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
      console.error('Error getting users:', error.message);
      return [];
    }
  }

  async addUser(userData) {
    if (!this.redis) throw new Error('Database Redis tidak terhubung');
    try {
      const users = await this.getAllUsers();
      
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
      const users = await this.getAllUsers();
      return users.find(u => u.username === username) || null;
    } catch (error) {
      console.error('Error getting user by username:', error.message);
      return null;
    }
  }

  async approveUser(username, adminName) {
    if (!this.redis) return null;
    try {
      const users = await this.getAllUsers();
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
      const users = await this.getAllUsers();
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
      users = users.filter(u => u.username !== username);
      await this.redis.set(this.redisKey, JSON.stringify(users));
      return true;
    } catch (error) {
      console.error('Error deleting user:', error.message);
      throw error;
    }
  }
}

module.exports = new StorageConfig();
